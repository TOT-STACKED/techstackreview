// Supabase Edge Function: slack-notify
//
// Invoked by Database Webhooks on INSERT into:
//   - public.submissions   → 🍞  "New Stack Review submission"          (stage 1)
//   - public.deep_reviews  → 🔥  "Sales-qualified Stack Review"        (stage 2)
//
// Required env vars (via `supabase secrets set`):
//   - SLACK_WEBHOOK_URL: Slack incoming webhook URL
//   - WEBHOOK_SECRET:    shared secret, presented as `Authorization: Bearer <secret>`
//
// Deploy: supabase functions deploy slack-notify --no-verify-jwt

// deno-lint-ignore-file
// @ts-nocheck — Deno edge runtime.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const SLACK_WEBHOOK_URL = Deno.env.get("SLACK_WEBHOOK_URL");
const WEBHOOK_SECRET    = Deno.env.get("WEBHOOK_SECRET");

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
  return {
    text: `New Stack Review submission from ${r.first_name ?? "someone"} at ${r.company ?? "an unnamed venue"}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "🍞 New Stack Review submission", emoji: true } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Name*\n${r.first_name ?? "—"}` },
          { type: "mrkdwn", text: `*Company*\n${r.company ?? "—"}` },
          { type: "mrkdwn", text: `*Email*\n${r.email ? `<mailto:${r.email}|${r.email}>` : "—"}` },
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
  return {
    text: `🔥 Sales-qualified: ${r.first_name ?? "someone"} at ${r.company ?? "an unnamed venue"}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "🔥 Sales-qualified Stack Review", emoji: true } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Name*\n${r.first_name ?? "—"}` },
          { type: "mrkdwn", text: `*Company*\n${r.company ?? "—"}` },
          { type: "mrkdwn", text: `*Email*\n${r.email ? `<mailto:${r.email}|${r.email}>` : "—"}` },
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
