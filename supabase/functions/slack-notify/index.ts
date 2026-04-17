// Supabase Edge Function: slack-notify
//
// Invoked by Database Webhooks on INSERT into:
//   - public.submissions   → 🍞  "New Stack Review submission"          (stage 1)
//   - public.deep_reviews  → 🔥  "Sales-qualified Stack Review"        (stage 2)
//
// Also (for stage 1 only) forwards the submission into the Tech on Toast
// "approved reporting" Supabase so the portal's dashboards pick it up.
//
// Required env vars (via `supabase secrets set`):
//   - SLACK_WEBHOOK_URL:        Slack incoming webhook URL
//   - WEBHOOK_SECRET:           shared secret, presented as `Authorization: Bearer <secret>`
//   - STACKCOLLECT_SUPABASE_URL (optional): portal Supabase base URL
//   - STACKCOLLECT_SUPABASE_KEY (optional): portal anon key
//
// Deploy: supabase functions deploy slack-notify --no-verify-jwt

// deno-lint-ignore-file
// @ts-nocheck — Deno edge runtime.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const SLACK_WEBHOOK_URL          = Deno.env.get("SLACK_WEBHOOK_URL");
const WEBHOOK_SECRET             = Deno.env.get("WEBHOOK_SECRET");
const STACKCOLLECT_SUPABASE_URL  = Deno.env.get("STACKCOLLECT_SUPABASE_URL");
const STACKCOLLECT_SUPABASE_KEY  = Deno.env.get("STACKCOLLECT_SUPABASE_KEY");

const fmtGBP = (n: number) => {
  if (!n) return "£0";
  if (n >= 1_000_000) return "£" + (n / 1_000_000).toFixed(1) + "m";
  if (n >= 1_000) return "£" + Math.round(n / 100) / 10 + "k";
  return "£" + Math.round(n);
};

const segmentLabel = (s?: string) => ({
  "indie-small": "Indie, 1 site",
  "indie-group": "Indie group, multi-site",
  "bar-pub":     "Bar / pub",
  "qsr":         "QSR / fast casual",
  "hotel":       "Hotel F&B",
}[s ?? ""] ?? s ?? "—");

function buildSubmissionMessage(r: any) {
  const gaps = Array.isArray(r.gap_categories) ? r.gap_categories : [];
  const gapText = gaps.length ? gaps.join(", ") : "_complete stack, no peer gaps_";
  const fullName = [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || "—";
  const phoneDisplay = r.phone_number
    ? `<tel:${String(r.phone_number).replace(/\s+/g, "")}|${r.phone_number}>`
    : "—";
  return {
    text: `New Stack Review submission from ${fullName} at ${r.company ?? "an unnamed venue"}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "🍞 New Stack Review submission", emoji: true } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Name*\n${fullName}` },
          { type: "mrkdwn", text: `*Company*\n${r.company ?? "—"}` },
          { type: "mrkdwn", text: `*Email*\n${r.email ? `<mailto:${r.email}|${r.email}>` : "—"}` },
          { type: "mrkdwn", text: `*Phone*\n${phoneDisplay}` },
          { type: "mrkdwn", text: `*Segment*\n${segmentLabel(r.segment)} · ${r.sites ?? "?"} sites` },
        ],
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Score*\n${r.score ?? "—"} / 100` },
          { type: "mrkdwn", text: `*Coverage*\n${r.coverage_pct ?? "—"}%` },
          { type: "mrkdwn", text: `*Annual upside*\n${fmtGBP(Number(r.total_gbp_per_year) || 0)}` },
          { type: "mrkdwn", text: `*Hours back / wk*\n+${r.total_hrs_per_week ?? 0}` },
        ],
      },
      { type: "section", text: { type: "mrkdwn", text: `*Top gap categories*\n${gapText}` } },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Marketing consent: ${r.consent ? "✓ opted-in" : "✗ not opted-in"}  ·  submitted ${r.created_at ?? "just now"}` }],
      },
    ],
  };
}

const painLabel = (v?: string) => ({
  pos: "EPOS", payments: "Payments", workforce: "Workforce",
  inventory: "Inventory", loyalty: "Loyalty / CRM", learning: "Learning",
  everything: "Everything hurts", unsure: "Not sure yet",
}[v ?? ""] ?? v ?? "—");

const renewalLabel = (v?: string) => ({
  "<3m": "< 3 months", "3-12m": "3–12 months", "12m+": "12+ months", "unsure": "Not sure",
}[v ?? ""] ?? v ?? "—");

const spendLabel = (v?: string) => ({
  "<5k": "Under £5k", "5-20k": "£5k–£20k", "20-50k": "£20k–£50k",
  "50-100k": "£50k–£100k", "100k+": "£100k+", "skip": "Prefer not to say",
}[v ?? ""] ?? v ?? "—");

const dmLabel = (v?: string) => ({
  me: "Me", "ops-fd": "Ops / FD", owner: "Founder or owner", varies: "Varies by category", other: "Other",
}[v ?? ""] ?? v ?? "—");

const introLabel = (v?: string) => ({
  yes: "✅ Yes, set one up", maybe: "📨 Maybe, email me details", no: "❌ No thanks",
}[v ?? ""] ?? v ?? "—");

function buildDeepReviewMessage(r: any) {
  const growth = [r.growth_goal, r.growth_goal_other].filter(Boolean).join(" · ");
  const fullName = [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || "—";
  const phoneDisplay = r.phone_number
    ? `<tel:${String(r.phone_number).replace(/\s+/g, "")}|${r.phone_number}>`
    : "—";
  return {
    text: `🔥 Sales-qualified: ${fullName} at ${r.company ?? "an unnamed venue"}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "🔥 Sales-qualified Stack Review", emoji: true } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Name*\n${fullName}` },
          { type: "mrkdwn", text: `*Company*\n${r.company ?? "—"}` },
          { type: "mrkdwn", text: `*Email*\n${r.email ? `<mailto:${r.email}|${r.email}>` : "—"}` },
          { type: "mrkdwn", text: `*Phone*\n${phoneDisplay}` },
          { type: "mrkdwn", text: `*Stage 1 upside*\n${fmtGBP(Number(r.total_gbp_per_year) || 0)} · score ${r.score ?? "—"}/100` },
        ],
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Biggest pain*\n${painLabel(r.pain_category)}` },
          { type: "mrkdwn", text: `*Contract renewal*\n${renewalLabel(r.renewal_window)}` },
          { type: "mrkdwn", text: `*Annual tech spend*\n${spendLabel(r.tech_spend_band)}` },
          { type: "mrkdwn", text: `*Decision maker*\n${dmLabel(r.decision_maker)}` },
        ],
      },
      { type: "section", text: { type: "mrkdwn", text: `*Top growth goal*\n${growth || "—"}` } },
      { type: "section", text: { type: "mrkdwn", text: `*Open to partner intro?*\n${introLabel(r.open_to_intro)}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Submitted ${r.created_at ?? "just now"}` }] },
    ],
  };
}

// ---- Portal / approved-reporting sync ----
// Maps a stage-1 submissions row into the portal's normalized shape and inserts
// (1) a business_submissions row then (2) one tech_stack_entries row per tool.
// Silent on error so the Slack ping still goes through even if the portal is
// misconfigured. Best-effort only.
const VERTICAL_LABEL: Record<string, string> = {
  indie: "Independent restaurant",
  group: "Multi-site restaurant group",
  bar:   "Bar / pub",
  qsr:   "QSR / fast casual",
  hotel: "Hotel F&B",
  other: "Other",
};
const SIZE_LABEL: Record<string, string> = {
  "1":    "1 site",
  "2-5":  "2–5 sites",
  "6-20": "6–20 sites",
  "20+":  "20+ sites",
};
const CATEGORY_LABEL: Record<string, string> = {
  pos:       "EPOS",
  payments:  "Payments",
  workforce: "Workforce",
  inventory: "Inventory",
  loyalty:   "Loyalty / CRM",
  learning:  "Learning",
};

async function syncToStackcollect(r: any) {
  if (!STACKCOLLECT_SUPABASE_URL || !STACKCOLLECT_SUPABASE_KEY) return;

  const headers = {
    apikey: STACKCOLLECT_SUPABASE_KEY,
    Authorization: `Bearer ${STACKCOLLECT_SUPABASE_KEY}`,
    "Content-Type": "application/json",
  };

  const contactName = [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || null;
  const biz = {
    business_name:        r.company ?? null,
    industry:             "Hospitality",
    size:                 SIZE_LABEL[r.sites] ?? r.sites ?? null,
    location:             null,
    contact_name:         contactName,
    contact_email:        r.email ?? null,
    role:                 null,
    phone_number:         r.phone_number ?? null,
    number_of_locations:  SIZE_LABEL[r.sites] ?? r.sites ?? null,
    vertical:             VERTICAL_LABEL[r.venue_type] ?? r.venue_type ?? null,
    submission_type:      "external",
    marketing_consent:    !!r.consent,
  };

  try {
    const bizRes = await fetch(`${STACKCOLLECT_SUPABASE_URL}/rest/v1/business_submissions`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify(biz),
    });
    if (!bizRes.ok) {
      console.error("[stackcollect] business_submissions insert failed", bizRes.status, await bizRes.text().catch(() => ""));
      return;
    }
    const bizRows = await bizRes.json();
    const bizRow = Array.isArray(bizRows) ? bizRows[0] : bizRows;
    if (!bizRow?.id) return;

    const stack = r.stack ?? {};
    const entries: Array<{ submission_id: string; category: string; tool_name: string }> = [];
    for (const [catId, sRaw] of Object.entries<any>(stack)) {
      const s = sRaw || {};
      const catLabel = CATEGORY_LABEL[catId] ?? catId;
      for (const t of (s.tools ?? [])) {
        if (t) entries.push({ submission_id: bizRow.id, category: catLabel, tool_name: String(t) });
      }
      const other = (s.other ?? "").toString().trim();
      if (other) entries.push({ submission_id: bizRow.id, category: catLabel, tool_name: other });
    }

    if (entries.length > 0) {
      const entriesRes = await fetch(`${STACKCOLLECT_SUPABASE_URL}/rest/v1/tech_stack_entries`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify(entries),
      });
      if (!entriesRes.ok) {
        console.error("[stackcollect] tech_stack_entries insert failed", entriesRes.status, await entriesRes.text().catch(() => ""));
      }
    }
  } catch (e) {
    console.error("[stackcollect] sync threw", e);
  }
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  if (WEBHOOK_SECRET) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${WEBHOOK_SECRET}`) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  if (!SLACK_WEBHOOK_URL) return new Response("SLACK_WEBHOOK_URL not set", { status: 500 });

  let body: any;
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }

  const r = body?.record ?? body ?? {};
  const tbl = body?.table ?? "submissions";

  const message = tbl === "deep_reviews"
    ? buildDeepReviewMessage(r)
    : buildSubmissionMessage(r);

  // Fan-out to the portal's Supabase on stage 1 submissions. Best-effort, non-blocking.
  if (tbl === "submissions") {
    // Deliberately not awaited — Slack should fire regardless of portal sync outcome.
    syncToStackcollect(r).catch((e) => console.error("[stackcollect] unhandled", e));
  }

  const slackRes = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });

  if (!slackRes.ok) {
    const errText = await slackRes.text().catch(() => "");
    return new Response(`Slack responded ${slackRes.status}: ${errText}`, { status: 502 });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
