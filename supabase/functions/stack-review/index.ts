// Supabase Edge Function: stack-review
//
// Generates a Claude-written narrative review of a stack submission, using the
// Tech on Toast Hospitality Tech Review system prompt (sourced from the repo's
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

function fmtGBP(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (!v) return "£0";
  if (v >= 1_000_000) return "£" + (v / 1_000_000).toFixed(1) + "m";
  if (v >= 1_000) return "£" + Math.round(v / 100) / 10 + "k";
  return "£" + Math.round(v);
}

function buildUserMessage(row: any): string {
  const lines: string[] = [];
  lines.push("# Operator profile");
  lines.push(`- Venue type: ${VENUE_LABEL[row.venue_type] ?? row.venue_type ?? "—"}`);
  lines.push(`- Sites: ${SITES_LABEL[row.sites] ?? row.sites ?? "—"}`);
  if (row.location) lines.push(`- Location: ${row.location}`);
  lines.push(`- Segment (peer group): ${row.segment ?? "—"}`);
  lines.push("");

  lines.push("# Their reported stack");
  const stack = row.stack ?? {};
  for (const catId of ["pos", "payments", "workforce", "inventory", "loyalty", "learning"]) {
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
  lines.push("");

  lines.push("# Your task");
  lines.push(
    "Conduct a Tech on Toast Stack Review for this operator. Diagnose gaps, name legacy systems they're stuck on, and challenge their current stack where it's wrong for their scale or trajectory. Lead with the biggest pain or opportunity. Use plain English and operator-friendly language. Be direct.",
  );
  lines.push("");
  lines.push(
    "**Critical: follow the OUTPUT BOUNDARIES section of your system prompt strictly.** Comment freely on tools they've already declared they use (it's their data) and name legacy systems they should leave (Access, Zonal, Polaris). But do NOT name specific replacement products in any category — describe the type of solution they need (e.g. \"a modern cloud POS with built-in inventory\", \"a loyalty / CRM layer\") and direct them to Tech on Toast for the matchmaking conversation.",
  );
  lines.push("");
  lines.push(
    "Format your response as markdown with these sections (omit any that don't apply): **What's working** (1–3 bullets, naming their current tools), **The biggest issue** (1 short paragraph diagnosing the structural problem), **What I'd change first** (numbered list of category-level changes with the why + ballpark cost/impact), **What I'd leave alone** (1–2 bullets, naming their current tools), **Watch out for** (any legacy systems / contract traps).",
  );
  lines.push(
    "End with a short closing paragraph titled **Next step** that points the operator to a Tech on Toast conversation — name their highest-priority change and direct them to book a call so Tech on Toast can match them to the right partner.",
  );
  lines.push(
    "Keep it under ~500 words. The operator just gave you their stack — you're writing a useful, opinionated, diagnostic review they'll actually read, ending with a clear call-to-action.",
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
  // rather than burning another Anthropic call.
  if (row.ai_feedback && typeof row.ai_feedback === "string" && row.ai_feedback.length > 50) {
    return new Response(
      JSON.stringify({ review: row.ai_feedback, cached: true }),
      { headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  const userMessage = buildUserMessage(row);

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  let reviewText = "";
  try {
    const response = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 2000,
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

    reviewText = response.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();

    console.log(
      `[stack-review] ok submission=${submissionId} cache_read=${response.usage?.cache_read_input_tokens ?? 0} cache_create=${response.usage?.cache_creation_input_tokens ?? 0} input=${response.usage?.input_tokens ?? 0} output=${response.usage?.output_tokens ?? 0}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[stack-review] anthropic error: ${msg}`);
    return new Response(
      JSON.stringify({ error: "review generation failed", detail: msg }),
      { status: 502, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  if (!reviewText) {
    return new Response(
      JSON.stringify({ error: "empty review returned" }),
      { status: 502, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

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

  // Fire a follow-up Slack message with the AI review. Best-effort and
  // non-blocking — the original numeric ping from slack-notify is unaffected.
  if (SLACK_WEBHOOK_URL) {
    postReviewToSlack(row, reviewText).catch((e) =>
      console.error("[stack-review] slack post threw", e)
    );
  }

  return new Response(
    JSON.stringify({ review: reviewText, cached: false }),
    { headers: { ...CORS, "Content-Type": "application/json" } },
  );
});

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
        text: "🤖 Tech on Toast review (Claude)",
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
      text: `Tech on Toast review for ${fullName} at ${company}`,
      blocks,
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.error(`[stack-review] slack returned ${res.status}: ${err}`);
  }
}
