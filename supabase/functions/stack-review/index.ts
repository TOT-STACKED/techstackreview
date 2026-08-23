// Supabase Edge Function: stack-review
//
// Generates a Claude-written narrative review of a stack submission, using the
// Stacked Intelligence hospitality tech review system prompt (sourced from the repo's
// CLAUDE.md, packaged as system-prompt.json for clean string escaping).
//
// Flow:
//   1. Frontend POSTs { submission_id } after the gate-step row is inserted.
//   2. Function looks up the row via service-role key (bypasses anon RLS).
//   3. Calls Anthropic with prompt caching on the system prompt (~7K tokens,
//      identical every call → ~3x cost saving after first hit).
//   4. Writes the review back to submissions.ai_feedback.
//   5. Returns the review markdown to the frontend.
//
// Required env vars (via `supabase secrets set`):
//   - ANTHROPIC_API_KEY
//   - SUPABASE_URL                (auto-populated by Supabase)
//   - SUPABASE_SERVICE_ROLE_KEY   (auto-populated by Supabase)
//
// Deploy: supabase functions deploy stack-review --no-verify-jwt

// deno-lint-ignore-file
// @ts-nocheck — Deno edge runtime.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.65.0";
import promptData from "./system-prompt.json" with { type: "json" };

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SLACK_WEBHOOK_URL = Deno.env.get("SLACK_WEBHOOK_URL");
// Marketplace Airtable — source of the "community context" for the Stacked
// Intelligence report. We batch-look-up every tool the operator listed, pull
// its community SOS Score + Reviews count + Operator names rollup, and pass
// the shape into Claude so the report can weave in the "X across N operators
// including [names]" moment inline. Same base + key the SOS sync writes to.
// Reuse AIRTABLE_API_KEY as a fallback — slack-notify already uses it, and
// it's the same account key that reaches the TOT Website base. Prefer a
// dedicated MARKETPLACE_AIRTABLE_KEY if set (in case we ever scope down).
const MARKETPLACE_AIRTABLE_KEY =
  Deno.env.get("MARKETPLACE_AIRTABLE_KEY") || Deno.env.get("AIRTABLE_API_KEY");
const MARKETPLACE_AIRTABLE_BASE_ID =
  Deno.env.get("MARKETPLACE_AIRTABLE_BASE_ID") || "appNvxXXaMWJfiX6X";
const MARKETPLACE_PARTNERS_TABLE =
  Deno.env.get("MARKETPLACE_PARTNERS_TABLE") || "Partners";
// Minimum operator ratings to display community context — same threshold as
// the marketplace SOS displays. Below this, we withhold the number (thin
// data is worse than no data for the operator's confidence in the report).
const COMMUNITY_MIN_RESPONSES = 2;
// A rating delta of this many points (on the operator's own 0–10 scale) is
// what earns the "your read differs meaningfully from the community" flag +
// the hello@wearestacked.io escalation line.
const DISAGREEMENT_DELTA = 3;
const ESCALATION_EMAIL = "hello@wearestacked.io";
// The "portal" / canonical operator-database Supabase project. The Stack
// Review's slack-notify edge function already syncs every new submission
// there (see syncToStackcollect in slack-notify), and historical data lives
// there. Persisting the AI review to that project's business_submissions
// row keeps everything queryable from one place.
const STACKCOLLECT_SUPABASE_URL = Deno.env.get("STACKCOLLECT_SUPABASE_URL");
const STACKCOLLECT_SUPABASE_KEY = Deno.env.get("STACKCOLLECT_SUPABASE_KEY");
// Email the AI review to the operator on send. From address is on the
// verified wearestacked.io Resend domain (SPF/DKIM/DMARC set up there).
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
// Display name reads "Chris at Stacked" but the address is the team inbox
// (hello@wearestacked.io) so replies route somewhere monitored, not a
// personal mailbox. Standard pattern — Chris signs it, team catches it.
const EMAIL_FROM = "Chris at Stacked <hello@wearestacked.io>";
const EMAIL_REPLY_TO = "hello@wearestacked.io";

const SYSTEM_PROMPT: string = (promptData as { prompt: string }).prompt;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey",
};

const CATEGORY_LABEL: Record<string, string> = {
  pos: "EPOS",
  payments: "Payments",
  workforce: "Workforce",
  inventory: "Inventory",
  loyalty: "Loyalty / CRM",
  learning: "Learning",
  finance_ops: "Finance / Ops management",
};

const VENUE_LABEL: Record<string, string> = {
  indie: "Independent restaurant",
  group: "Multi-site restaurant group",
  bar: "Bar / pub",
  qsr: "QSR / fast casual",
  hotel: "Hotel F&B",
  other: "Other",
};

const SITES_LABEL: Record<string, string> = {
  "1": "1 site",
  "2-5": "2–5 sites",
  "6-20": "6–20 sites",
  "20+": "20+ sites",
};

// ---------- Community context (Stacked Intelligence) ----------
//
// Pull per-product community data from the Marketplace Partners table in one
// batched Airtable REST call. Returns a map keyed by lowercased tool name so
// buildUserMessage can look up: community avg, review count, operator names.
//
// Threshold: only surfaces products with n >= COMMUNITY_MIN_RESPONSES. Below
// that threshold, thin data is worse than no data on the report.
//
// Scale: Airtable's `SOS Score` formula field returns a 0–5 rating (matches
// the marketplace tile). Operators rate on 0–10 in the form. We multiply by
// 2 here so both numbers reach Claude on the same scale — the report reads
// "your 7/10 vs community 6.8/10" without asking Claude to reconcile scales.
//
// Operator names come from the `Operator names` rollup which returns unique
// brand names for every venue using the tool. We cap to 5 + report total so
// the AI can render "up to 5 pills, +N more" per the design.
type CommunityEntry = {
  tool: string;              // canonical partner name from Airtable
  avgOutOfTen: number;       // SOS × 2, rounded to 1 dp
  reviewCount: number;
  totalOperators: number;    // count of distinct operators (not venues)
  operatorNames: string[];   // first 5 for display
};
type CommunityContext = Map<string, CommunityEntry>; // key: tool.toLowerCase()

async function fetchCommunityContext(toolNames: string[]): Promise<CommunityContext> {
  const out: CommunityContext = new Map();
  if (!MARKETPLACE_AIRTABLE_KEY || !toolNames.length) return out;

  // De-dupe (case-insensitive) so we don't over-fetch.
  const uniq = Array.from(
    new Map(toolNames.map((t) => [t.trim().toLowerCase(), t.trim()])).values(),
  ).filter(Boolean);
  if (!uniq.length) return out;

  // Batched OR({Name}="X",{Name}="Y",...) filterByFormula. Airtable escapes
  // by doubling single quotes; we also strip stray double quotes to keep the
  // formula parseable. A single call is fine for 6-8 tool names.
  const esc = (s: string) => s.replace(/"/g, "").replace(/'/g, "\\'");
  const formula = uniq.length === 1
    ? `LOWER({Name})="${esc(uniq[0].toLowerCase())}"`
    : `OR(${uniq.map((n) => `LOWER({Name})="${esc(n.toLowerCase())}"`).join(",")})`;

  const params = new URLSearchParams({
    filterByFormula: formula,
    "fields[]": "Name",
  });
  // Also request the community fields. Airtable's URLSearchParams only takes
  // one value per key, so we add each field separately.
  for (const f of ["SOS Score", "SOS Reviews", "Operator names", "Operators (brands)"]) {
    params.append("fields[]", f);
  }

  const url =
    `https://api.airtable.com/v0/${MARKETPLACE_AIRTABLE_BASE_ID}/${encodeURIComponent(MARKETPLACE_PARTNERS_TABLE)}?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${MARKETPLACE_AIRTABLE_KEY}` },
    });
    console.log(`[stack-review] community fetch → HTTP ${res.status} for ${uniq.length} tools: ${uniq.join(", ")}`);
    console.log(`[stack-review] community fetch URL: ${url}`);
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(`[stack-review] community fetch failed: ${errBody}`);
      // Also stash on the map so debug can see it (hacky but useful)
      (out as any)._debugError = { status: res.status, body: errBody.slice(0, 500) };
      return out;
    }
    const json = await res.json();
    const records: any[] = Array.isArray(json?.records) ? json.records : [];
    console.log(`[stack-review] community fetch returned ${records.length} Airtable records`);
    for (const r of records) {
      const name = (r?.fields?.Name || "").toString().trim();
      if (!name) continue;
      const sos = Number(r?.fields?.["SOS Score"]);
      const count = Number(r?.fields?.["SOS Reviews"]) || 0;
      if (!Number.isFinite(sos) || sos <= 0 || count < COMMUNITY_MIN_RESPONSES) continue;
      const ops = Array.isArray(r?.fields?.["Operator names"])
        ? r.fields["Operator names"].filter((s: any) => typeof s === "string" && s.trim())
        : [];
      // Prefer the distinct-brands rollup for the total count; fall back to
      // ops.length if it's missing.
      const totalOperators = Number(r?.fields?.["Operators (brands)"]) || ops.length;
      out.set(name.toLowerCase(), {
        tool: name,
        avgOutOfTen: Math.round((sos * 2) * 10) / 10,
        reviewCount: count,
        totalOperators,
        operatorNames: ops.slice(0, 5),
      });
    }
  } catch (e) {
    console.error("[stack-review] community fetch threw", e);
  }
  return out;
}

// ---------- Structured review parsing + markdown fallback ----------
//
// Claude is prompted to return a JSON object matching the report screen's
// renderer shape. parseStructuredReview strips any accidental code fence
// and returns the parsed object (or null if it can't parse — we degrade to
// treating the raw text as markdown in that case).
type StructuredReview = {
  main_flag?: { kind?: string; title?: string; body?: string } | null;
  sections?: Array<{
    heading?: string;
    kind?: "positive" | "prose" | "list" | "warning";
    body?: string;
    items?: Array<{
      tool?: string;
      operator_score?: number | null;
      community_avg?: number | null;
      community_count?: number | null;
      operator_names?: string[];
      more_operators?: number;
      commentary?: string;
      escalate?: boolean;
    }>;
  }>;
  next_step?: { title?: string; body?: string } | null;
};

function parseStructuredReview(raw: string): StructuredReview | null {
  if (!raw) return null;
  let s = raw.trim();
  // Strip ```json fences or bare ``` fences if Claude added one.
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  // Also handle case where JSON is preceded by a stray line or two.
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace > 0 && lastBrace > firstBrace) s = s.slice(firstBrace, lastBrace + 1);
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === "object") return obj as StructuredReview;
  } catch (_e) {
    // Falls through to null. The caller will treat rawText as markdown.
  }
  return null;
}

// Flatten the structured JSON into a readable markdown string. Used to
// keep Slack + email + submissions.ai_feedback in the same shape they've
// always been in — the report screen renders the structured JSON directly
// for the pretty pills, but every other consumer just wants readable text.
function structuredToMarkdown(sr: StructuredReview): string {
  const out: string[] = [];
  if (sr.main_flag?.title) {
    out.push(`## 🥣 Main flag — ${sr.main_flag.title}`);
    if (sr.main_flag.body) {
      out.push("");
      out.push(sr.main_flag.body);
    }
    out.push("");
  }
  for (const sec of sr.sections ?? []) {
    if (!sec?.heading) continue;
    out.push(`## ${sec.heading}`);
    if (sec.kind === "prose") {
      if (sec.body) {
        out.push("");
        out.push(sec.body);
      }
    } else {
      out.push("");
      const items = Array.isArray(sec.items) ? sec.items : [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const bullet = sec.kind === "list" ? `${i + 1}.` : "-";
        const tool = (it.tool || "").trim() || "—";
        let line = `${bullet} **${tool}**`;
        if (typeof it.operator_score === "number") line += ` — you gave ${it.operator_score}/10`;
        if (typeof it.community_avg === "number" && typeof it.community_count === "number") {
          line += ` · community ${it.community_avg}/10 across ${it.community_count} operators`;
        }
        out.push(line);
        if (it.commentary) out.push(`  ${it.commentary}`);
        if (Array.isArray(it.operator_names) && it.operator_names.length) {
          const tail = it.more_operators && it.more_operators > 0
            ? ` (+${it.more_operators} more)`
            : "";
          out.push(`  _Also using it: ${it.operator_names.join(", ")}${tail}_`);
        }
        if (it.escalate) {
          out.push(`  > 🥣 Your read differs from the community — worth challenging: ${ESCALATION_EMAIL}`);
        }
      }
    }
    out.push("");
  }
  if (sr.next_step?.title) {
    out.push(`## ${sr.next_step.title}`);
    if (sr.next_step.body) {
      out.push("");
      out.push(sr.next_step.body);
    }
    out.push("");
  }
  return out.join("\n").trim();
}

function fmtGBP(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (!v) return "£0";
  if (v >= 1_000_000) return "£" + (v / 1_000_000).toFixed(1) + "m";
  if (v >= 1_000) return "£" + Math.round(v / 100) / 10 + "k";
  return "£" + Math.round(v);
}

// Extract every unique tool name the operator picked, across all categories
// (named tools + the free-text "other" field). We hand this to
// fetchCommunityContext so Claude gets community data on the specific
// products it's about to comment on.
function collectToolsFromStack(stack: any): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (name: unknown) => {
    if (typeof name !== "string") return;
    const t = name.trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  const s = stack ?? {};
  for (const catId of [
    "pos", "payments", "workforce", "inventory", "loyalty",
    "learning", "finance_ops", "guest_feedback",
  ]) {
    const cat = s[catId] ?? {};
    const tools: unknown[] = Array.isArray(cat?.tools) ? cat.tools : [];
    for (const t of tools) push(t);
    const other = (cat?.other ?? "").toString();
    for (const t of other.split(",")) push(t);
  }
  return out;
}

function buildUserMessage(row: any, community: CommunityContext): string {
  const lines: string[] = [];
  lines.push("# Operator profile");
  lines.push(`- Venue type: ${VENUE_LABEL[row.venue_type] ?? row.venue_type ?? "—"}`);
  lines.push(`- Sites: ${SITES_LABEL[row.sites] ?? row.sites ?? "—"}`);
  if (row.location) lines.push(`- Location: ${row.location}`);
  lines.push(`- Segment (peer group): ${row.segment ?? "—"}`);
  lines.push("");

  lines.push("# Their reported stack");
  const stack = row.stack ?? {};
  for (const catId of ["pos", "payments", "workforce", "inventory", "loyalty", "learning", "finance_ops"]) {
    const cat = stack[catId] ?? {};
    const label = CATEGORY_LABEL[catId];
    const tools: string[] = Array.isArray(cat.tools) ? cat.tools : [];
    const other = (cat.other ?? "").toString().trim();
    const none = !!cat.none;
    const nps = cat.nps && typeof cat.nps === "object" ? cat.nps : {};

    let line = `**${label}:** `;
    if (none) {
      line += "_we don't use anything here_";
    } else if (!tools.length && !other) {
      line += "_(no answer)_";
    } else {
      const parts: string[] = [];
      for (const t of tools) {
        const score = typeof nps[t] === "number" ? ` (NPS ${nps[t]})` : "";
        parts.push(`${t}${score}`);
      }
      if (other) {
        const otherScore = typeof nps[`__other__:${other}`] === "number"
          ? ` (NPS ${nps[`__other__:${other}`]})`
          : "";
        parts.push(`other: ${other}${otherScore}`);
      }
      line += parts.join(", ");
    }
    lines.push(`- ${line}`);
  }
  lines.push("");

  lines.push("# Reporting snapshot (deterministic, calculated by our scoring tool)");
  lines.push(`- Match score: ${row.score ?? "—"}/100`);
  lines.push(`- Coverage: ${row.coverage_pct ?? "—"}% of 6 core categories`);
  lines.push(`- Estimated annual upside: ${fmtGBP(row.total_gbp_per_year)}`);
  lines.push(`- Estimated time saved: ${row.total_hrs_per_week ?? 0} hrs/week`);
  const gaps = Array.isArray(row.gap_categories) ? row.gap_categories : [];
  lines.push(`- Categories flagged as gaps: ${gaps.length ? gaps.join(", ") : "_none — full coverage_"}`);
  if (typeof row.nps_avg === "number") {
    lines.push(`- Average product NPS across their stack: ${row.nps_avg}/10`);
  }
  if (typeof row.uses_whatsapp === "boolean") {
    lines.push(
      `- Uses WhatsApp for team communications: ${row.uses_whatsapp ? "yes" : "no"}`,
    );
  }
  if (typeof row.has_knowledge_base === "boolean") {
    lines.push(
      `- Has a team knowledge base (wiki/intranet/shared docs for SOPs, training, allergens): ${row.has_knowledge_base ? "yes" : "no"}`,
    );
  }
  lines.push("");

  // -------------------------------------------------------------------------
  // Community context (Stacked Intelligence data)
  // -------------------------------------------------------------------------
  // Emit each tool the operator listed with what the wider Stacked operator
  // base thinks of it. Only surfaces products that pass COMMUNITY_MIN_RESPONSES;
  // silence otherwise (thin data is worse than no data). The AI uses this to
  // weave "community avg X across N operators including [names]" inline per
  // the design.
  lines.push("# Community context (Stacked Intelligence)");
  lines.push(
    "This is what the wider Stacked operator base rates each tool. Use these numbers to compare the operator's own rating to the community — inline, next to each tool.",
  );
  lines.push("");
  const stackForCollect = row.stack ?? {};
  const operatorTools = collectToolsFromStack(stackForCollect);
  let matched = 0;
  for (const t of operatorTools) {
    const c = community.get(t.toLowerCase());
    if (!c) continue;
    matched++;
    const opsBlurb = c.operatorNames.length
      ? ` — used by ${c.operatorNames.join(", ")}${c.totalOperators > c.operatorNames.length ? ` (+${c.totalOperators - c.operatorNames.length} more)` : ""}`
      : "";
    lines.push(
      `- **${c.tool}** — community avg ${c.avgOutOfTen}/10 across ${c.totalOperators} operators${opsBlurb}`,
    );
  }
  if (!matched) {
    lines.push("_No community context available for the tools this operator listed (either below the n≥2 threshold or not yet in the marketplace)._");
  }
  lines.push("");

  lines.push("# Your task");
  lines.push(
    "Conduct a **Stacked Intelligence** review for this operator. Diagnose gaps, name legacy systems they're stuck on, and challenge their current stack where it's wrong for their scale or trajectory. Use plain English and operator-friendly language. Be direct.",
  );
  lines.push("");
  lines.push(
    "**Critical: follow the OUTPUT BOUNDARIES section of your system prompt strictly.** Comment freely on tools they've already declared they use (it's their data). Name legacy systems factually. But do NOT prescribe specific replacement products in any category — describe the type of solution they need and direct them to the Stacked team for the matchmaking conversation.",
  );
  lines.push("");
  lines.push("## Output format — a single JSON object");
  lines.push("");
  lines.push(
    "Return **ONLY** a valid JSON object matching the schema below. No prose before or after. No markdown fences. The renderer parses this JSON to build the report screen — malformed JSON breaks the report.",
  );
  lines.push("");
  lines.push("```");
  lines.push(`{
  "main_flag": {
    "kind": "gap" | "disagreement" | "legacy_risk" | "opportunity",
    "title": "One-sentence headline — the single biggest thing worth doing next",
    "body": "1–2 sentence supporting paragraph. Tie it to why a Stacked conversation is the next step."
  },
  "sections": [
    {
      "heading": "What's working",
      "kind": "positive",
      "items": [
        {
          "tool": "Toast",                     // tool name as the operator entered it
          "operator_score": 8,                 // their 0–10 rating (null if unrated)
          "community_avg": 6.8,                // 0–10 community avg (null if no context)
          "community_count": 30,               // operator count behind the avg (null if no context)
          "operator_names": ["Sushi Dog","Blend Family","Corrigan Collection","Wilson's","The Griffin"],
          "more_operators": 25,                // count beyond the 5 above (0 if none)
          "commentary": "1–2 sentences on why it's working / how they compare to community.",
          "escalate": false                    // true only when |operator_score - community_avg| >= ${DISAGREEMENT_DELTA}
        }
      ]
    },
    { "heading": "The biggest issue", "kind": "prose", "body": "1 short paragraph" },
    { "heading": "What I'd change first", "kind": "list", "items": [ /* same item shape as above; tool may be a category name if the item is a gap, e.g. 'Inventory & Stock Management'. community fields null in that case. */ ] },
    { "heading": "What I'd leave alone", "kind": "positive", "items": [ /* same shape */ ] },
    { "heading": "Watch out for", "kind": "warning", "items": [ /* same shape; use for legacy risk items */ ] }
  ],
  "next_step": {
    "title": "Talk to the Stacked team",
    "body": "1 short paragraph naming their highest-priority change and directing them to book a call."
  }
}`);
  lines.push("```");
  lines.push("");
  lines.push("### Section rules");
  lines.push(
    "- Omit any section that doesn't apply. Sections must appear in this exact order when present.",
  );
  lines.push(
    "- 3–6 items total across all `positive`/`list`/`warning` sections. Don't over-produce — brevity wins.",
  );
  lines.push(
    "- `positive.items` names their current tools they should keep. `list.items` are category-level changes. `warning.items` are legacy risks or contract traps.",
  );
  lines.push("");
  lines.push("### Community pill rules (inline for every item)");
  lines.push(
    `- If we passed community context for a tool, populate \`community_avg\`, \`community_count\`, \`operator_names\` (up to 5), and \`more_operators\` (total minus the 5 shown).`,
  );
  lines.push(
    `- If we did NOT pass community context for a tool (below threshold or gap category), set community_avg/count to \`null\` and operator_names to \`[]\`.`,
  );
  lines.push(
    `- NEVER attribute a specific score to a named operator ("Pizza Pilgrims gave it 7"). Community avg is aggregate only; names are just "who uses it".`,
  );
  lines.push("");
  lines.push("### Escalation rule");
  lines.push(
    `- Set \`escalate: true\` on an item ONLY when the operator's rating and the community avg differ by ${DISAGREEMENT_DELTA} points or more on the /10 scale (either direction). In that case the renderer will show the "worth challenging with us: ${ESCALATION_EMAIL}" callout. Do NOT put the email into \`commentary\` — the renderer handles it.`,
  );
  lines.push("");
  lines.push("### Main flag rules");
  lines.push(
    "Pick the strongest signal for this specific operator, in this order of preference when tied:",
  );
  lines.push(
    "1. `gap` — a peer-adopted category they haven't covered (inventory at 4+ sites, no first-party ordering at QSR, no staff comms platform).",
  );
  lines.push(
    `2. \`disagreement\` — the biggest single tool where the operator diverges from the community by ${DISAGREEMENT_DELTA}+ points.`,
  );
  lines.push(
    "3. `legacy_risk` — a legacy platform (Access, Zonal, Polaris, Aloha, Comtrex POS, Andromeda) with a real forward risk at their scale.",
  );
  lines.push(
    "4. `opportunity` — used ONLY when nothing above applies. This is the \"stack is in a strong place, why not level up\" flag: point them at advanced-tech conversations (first-party ordering, tighter GP visibility, AI in operations, margin plays). Same BD hook, positive framing. Book a call to explore how the current stack could unlock more margin.",
  );
  lines.push("");
  lines.push("### Voice");
  lines.push(
    "Direct, opinionated, operator-friendly. Not sales copy. The tone from your system prompt applies to every prose field (`main_flag.title/body`, `commentary`, `sections[].body`, `next_step.body`).",
  );
  return lines.join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS });
  }

  if (!ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(
      JSON.stringify({ error: "SUPABASE env vars not configured" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: CORS });
  }

  const submissionId = body?.submission_id;
  if (!submissionId || typeof submissionId !== "string") {
    return new Response(
      JSON.stringify({ error: "submission_id (string) required" }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  // Look up the row using service-role (bypasses anon-only RLS).
  const rowRes = await fetch(
    `${SUPABASE_URL}/rest/v1/submissions?id=eq.${encodeURIComponent(submissionId)}&select=*`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  );
  if (!rowRes.ok) {
    return new Response(
      JSON.stringify({ error: "row lookup failed", status: rowRes.status }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
  const rows = await rowRes.json();
  if (!Array.isArray(rows) || !rows.length) {
    return new Response(
      JSON.stringify({ error: "submission not found" }),
      { status: 404, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
  const row = rows[0];

  // If we already have a review for this row (e.g. user refreshed), return it
  // rather than burning another Anthropic call. Still attempt the portal
  // persist + operator email in case they didn't happen before (e.g. row
  // reviewed before that code shipped).
  if (row.ai_feedback && typeof row.ai_feedback === "string" && row.ai_feedback.length > 50) {
    if (STACKCOLLECT_SUPABASE_URL && STACKCOLLECT_SUPABASE_KEY) {
      persistReviewToPortal(row, row.ai_feedback).catch((e) =>
        console.error("[stack-review] portal persist (cached path) threw", e)
      );
    }
    if (RESEND_API_KEY) {
      sendReviewEmail(row, row.ai_feedback).catch((e) =>
        console.error("[stack-review] email send (cached path) threw", e)
      );
    }
    return new Response(
      // Cache hit — we return the previously-persisted markdown. structured
      // is null on this path (we don't currently store it); the renderer
      // falls back to markdown rendering, which is fine for reopens.
      JSON.stringify({ review: row.ai_feedback, structured: null, cached: true }),
      { headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  // Fetch community context for every tool the operator listed. One batched
  // Airtable call. Best-effort — if the marketplace key is missing or the
  // fetch fails, we still generate a review, it just won't have community
  // pills. Non-blocking on error.
  const operatorTools = collectToolsFromStack(row.stack ?? {});
  const community = await fetchCommunityContext(operatorTools);

  const userMessage = buildUserMessage(row, community);

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  let rawText = "";
  try {
    const response = await client.messages.create({
      model: "claude-opus-4-7",
      // 8000 gives comfortable headroom for the structured JSON — 3000 was
      // hitting truncation partway through the sections array, which made
      // parseStructuredReview return null and the email fell back to
      // rendering the raw JSON as prose.
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userMessage }],
    });

    rawText = response.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();

    console.log(
      `[stack-review] ok submission=${submissionId} community_matched=${community.size}/${operatorTools.length} cache_read=${response.usage?.cache_read_input_tokens ?? 0} cache_create=${response.usage?.cache_creation_input_tokens ?? 0} input=${response.usage?.input_tokens ?? 0} output=${response.usage?.output_tokens ?? 0}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[stack-review] anthropic error: ${msg}`);
    return new Response(
      JSON.stringify({ error: "review generation failed", detail: msg }),
      { status: 502, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  if (!rawText) {
    return new Response(
      JSON.stringify({ error: "empty review returned" }),
      { status: 502, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  // Parse Claude's JSON output. Strip any code-fence Claude might have added
  // despite the "no fences" instruction — it's a common relapse. If we can't
  // parse it, fall back to treating it as markdown (belt-and-braces).
  const structured = parseStructuredReview(rawText);
  const reviewText = structured
    ? structuredToMarkdown(structured)
    : rawText;

  // Persist the review back to the row. Best-effort — if this fails, still
  // return the review to the user.
  try {
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/submissions?id=eq.${encodeURIComponent(submissionId)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ ai_feedback: reviewText }),
      },
    );
    if (!patchRes.ok) {
      console.error(
        `[stack-review] persist failed status=${patchRes.status} ${await patchRes.text().catch(() => "")}`,
      );
    }
  } catch (e) {
    console.error("[stack-review] persist threw", e);
  }

  // Persist the same review into the portal/canonical operator database
  // (`business_submissions.recommendations` on the StackCollect Supabase
  // project) so historical + AI-augmented data sits in one place. Best-effort
  // — failures here don't affect the user-visible response. Match the
  // canonical row by (email, business_name) within the last hour, since the
  // portal sync inserts almost immediately after the row lands in this
  // project.
  if (STACKCOLLECT_SUPABASE_URL && STACKCOLLECT_SUPABASE_KEY) {
    persistReviewToPortal(row, reviewText).catch((e) =>
      console.error("[stack-review] portal persist threw", e)
    );
  }

  // Email the review to the operator. The gate form consent line promises
  // this. Best-effort, non-blocking.
  if (RESEND_API_KEY) {
    sendReviewEmail(row, reviewText).catch((e) =>
      console.error("[stack-review] email send threw", e)
    );
  }

  // Fire a follow-up Slack message with the AI review. Best-effort and
  // non-blocking — the original numeric ping from slack-notify is unaffected.
  if (SLACK_WEBHOOK_URL) {
    postReviewToSlack(row, reviewText).catch((e) =>
      console.error("[stack-review] slack post threw", e)
    );
  }

  return new Response(
    JSON.stringify({
      review: reviewText,
      structured,   // null if parsing failed; renderer falls back to markdown
      cached: false,
      // Minimal telemetry so we can see coverage without opening logs.
      community_matched: community.size,
      community_tools: operatorTools.length,
    }),
    { headers: { ...CORS, "Content-Type": "application/json" } },
  );
});

// Escape a string for safe inclusion in HTML text. We don't trust the
// review's content as HTML because it comes from an LLM.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Render the same markdown subset the report screen handles: ## h2, ### h3,
// **bold**, bullets (- or *), numbered lists (1.), and paragraphs. Anything
// exotic falls through as a paragraph.
function reviewMarkdownToHtml(md: string): string {
  const normalized = md.trim().replace(/^(#{1,6} .+)\n(?!\n|$)/gm, "$1\n\n");
  const renderInline = (text: string) => {
    return escapeHtml(text).replace(
      /\*\*([^*]+)\*\*/g,
      "<strong style=\"color: #FC90C3;\">$1</strong>",
    );
  };
  return normalized
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      const first = lines[0] || "";
      if (first.startsWith("### ")) {
        return `<h4 style="font-family: Georgia, serif; font-size: 16px; margin: 18px 0 8px;">${renderInline(first.slice(4))}</h4>`;
      }
      if (first.startsWith("## ")) {
        return `<h3 style="font-family: 'Archivo Black', 'Arial Black', -apple-system, sans-serif; font-size: 18px; font-weight: 900; color: #FC90C3; margin: 22px 0 10px; letter-spacing: -0.01em;">${renderInline(first.slice(3))}</h3>`;
      }
      if (first.startsWith("# ")) {
        return `<h2 style="font-family: 'Archivo Black', 'Arial Black', -apple-system, sans-serif; font-size: 22px; font-weight: 900; color: #FC90C3; margin: 24px 0 12px; letter-spacing: -0.01em;">${renderInline(first.slice(2))}</h2>`;
      }
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        const items = lines
          .map((l) => `<li style="margin-bottom: 6px;">${renderInline(l.replace(/^\s*[-*]\s+/, ""))}</li>`)
          .join("");
        return `<ul style="padding-left: 20px; margin: 0 0 14px;">${items}</ul>`;
      }
      if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
        const items = lines
          .map((l) => `<li style="margin-bottom: 6px;">${renderInline(l.replace(/^\s*\d+\.\s+/, ""))}</li>`)
          .join("");
        return `<ol style="padding-left: 20px; margin: 0 0 14px;">${items}</ol>`;
      }
      return `<p style="margin: 0 0 14px; line-height: 1.55;">${renderInline(block)}</p>`;
    })
    .join("\n");
}

async function sendReviewEmail(row: any, review: string) {
  const toEmail = (row.email ?? "").toString().trim();
  if (!toEmail) {
    console.error("[stack-review] email skipped: no email on row");
    return;
  }
  const firstName = (row.first_name ?? "").toString().trim();
  const company = (row.company ?? "").toString().trim();

  const greeting = firstName ? `Hi ${firstName},` : "Hi there,";
  const intro = `Thanks for completing your Stacked Intelligence Score${company ? ` for ${escapeHtml(company)}` : ""}. Here's what came back — a diagnostic look at where your stack is strong, where the gaps are, and how you compare with the wider Stacked operator base.`;

  const reviewHtml = reviewMarkdownToHtml(review);

  const subject = company
    ? `Your Stacked Intelligence Score — ${company}`
    : "Your Stacked Intelligence Score";

  const html = `<!doctype html><html><body style="margin:0; padding:0; background:#5C1932;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#5C1932; padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="640" style="max-width:640px; background:#87013B; border:1px solid rgba(252,144,195,0.14); border-radius:16px; padding:32px; color:#F5F1E4; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; font-size:15px; line-height:1.55;">
        <tr><td>
          <div style="font-size:12px; text-transform:uppercase; letter-spacing:1.5px; color:#FC90C3; font-weight:700; margin-bottom:6px;">Stacked · Intelligence Score</div>
          <h1 style="font-family:'Archivo Black','Arial Black',-apple-system,sans-serif; font-weight:900; font-size:28px; color:#FC90C3; margin:0 0 18px; letter-spacing:-0.02em;">${escapeHtml(greeting)}</h1>
          <p style="margin:0 0 18px; line-height:1.55; color:#F5F1E4;">${intro}</p>
          <hr style="border:none; border-top:1px solid rgba(252,144,195,0.14); margin:24px 0;">
          ${reviewHtml}
          <hr style="border:none; border-top:1px solid rgba(252,144,195,0.14); margin:28px 0;">
          <p style="margin:0 0 6px; color:#F5F1E4;">Reply to this email to book a call — I read everything that comes through here personally.</p>
          <p style="margin:0; color:#ffcae0;">— Chris<br>Stacked</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  // Plain-text fallback — strip markdown to readable text for clients that
  // don't render HTML (rare, but worth doing).
  const text =
    `${greeting}\n\n${intro.replace(/<[^>]+>/g, "")}\n\n${review}\n\n` +
    `Reply to this email to book a call — I read everything personally.\n\n— Chris, Stacked`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [toEmail],
      reply_to: EMAIL_REPLY_TO,
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    console.error(
      `[stack-review] resend returned ${res.status}: ${await res.text().catch(() => "")}`,
    );
    return;
  }
  const body = await res.json().catch(() => ({}));
  console.log(`[stack-review] email sent to ${toEmail} (resend id ${body.id ?? "?"})`);
}

// Slack mrkdwn doesn't render markdown headings (#, ##) or **bold** the way
// markdown does. Translate the subset our prompt asks for: ## becomes :small_blue_diamond:
// + bold, ### becomes bold, **bold** becomes *bold*. Bullets pass through.
function mdToSlackMrkdwn(md: string): string {
  return md
    .replace(/^### (.+)$/gm, "*$1*")
    .replace(/^## (.+)$/gm, ":small_blue_diamond: *$1*")
    .replace(/^# (.+)$/gm, "*$1*")
    .replace(/\*\*([^*]+)\*\*/g, "*$1*");
}

// Persist the AI review to the portal's business_submissions row that matches
// this new-project submission. Lookup keys: contact_email + business_name +
// recent created_at window. We use email-as-primary because business_name has
// punctuation/whitespace variability; the time window guards against
// matching an old row from a different submission with the same email.
async function persistReviewToPortal(row: any, review: string) {
  const baseUrl = STACKCOLLECT_SUPABASE_URL!;
  const key = STACKCOLLECT_SUPABASE_KEY!;
  const portalHeaders = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };

  const email = (row.email ?? "").toString().trim().toLowerCase();
  if (!email) {
    console.error("[stack-review] portal persist skipped: no email on row");
    return;
  }

  // Search a 6-hour window back from the source row's created_at — gives the
  // slack-notify portal sync plenty of time to have landed the row.
  const baseTime = row.created_at ? new Date(row.created_at).getTime() : Date.now();
  const windowStart = new Date(baseTime - 6 * 60 * 60 * 1000).toISOString();

  // PostgREST's `eq.` filter on a lowercase email works because the column is
  // text — but the data was inserted with original case, so use `ilike` to
  // match case-insensitively.
  const query =
    `contact_email=ilike.${encodeURIComponent(email)}` +
    `&created_at=gte.${encodeURIComponent(windowStart)}` +
    `&select=id,business_name,contact_email,created_at` +
    `&order=created_at.desc` +
    `&limit=5`;

  const lookupRes = await fetch(
    `${baseUrl}/rest/v1/business_submissions?${query}`,
    { headers: portalHeaders },
  );
  if (!lookupRes.ok) {
    console.error(
      `[stack-review] portal lookup failed ${lookupRes.status}: ${await lookupRes.text().catch(() => "")}`,
    );
    return;
  }
  const candidates: any[] = await lookupRes.json().catch(() => []);
  if (!Array.isArray(candidates) || !candidates.length) {
    console.error(
      `[stack-review] portal lookup: no match for email=${email} in 6h window`,
    );
    return;
  }

  // Prefer a candidate whose business_name matches (case-insensitively, after
  // stripping whitespace). Fall back to the most recent.
  const companyNorm = (row.company ?? "").toString().toLowerCase().replace(/\s+/g, " ").trim();
  const match =
    candidates.find((c) => {
      const cn = (c.business_name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
      return cn && cn === companyNorm;
    }) ?? candidates[0];

  // Write the review as plain text — `recommendations` is jsonb but PostgREST
  // accepts a JSON-encoded string value and stores it as a JSON string.
  const patchRes = await fetch(
    `${baseUrl}/rest/v1/business_submissions?id=eq.${encodeURIComponent(match.id)}`,
    {
      method: "PATCH",
      headers: { ...portalHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ recommendations: review }),
    },
  );
  if (!patchRes.ok) {
    console.error(
      `[stack-review] portal patch failed ${patchRes.status}: ${await patchRes.text().catch(() => "")}`,
    );
    return;
  }
  console.log(
    `[stack-review] portal review persisted business_submission=${match.id} business_name="${match.business_name}"`,
  );
}

async function postReviewToSlack(row: any, review: string) {
  const fullName = [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || "—";
  const company = row.company ?? "—";
  const slackBody = mdToSlackMrkdwn(review);

  // Slack mrkdwn section blocks are capped at 3000 chars. Most reviews are
  // 1500–3000; if longer, split into multiple section blocks.
  const chunks: string[] = [];
  const max = 2900;
  let remaining = slackBody;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);

  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "🤖 Stacked Intelligence review (Claude)",
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `For *${fullName}* at *${company}* — ${row.segment ?? "?"} · ${row.sites ?? "?"} sites`,
        },
      ],
    },
    { type: "divider" },
    ...chunks.map((c) => ({
      type: "section",
      text: { type: "mrkdwn", text: c },
    })),
  ];

  const res = await fetch(SLACK_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `Stacked Intelligence review for ${fullName} at ${company}`,
      blocks,
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.error(`[stack-review] slack returned ${res.status}: ${err}`);
  }
}
