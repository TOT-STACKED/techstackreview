// Supabase Edge Function: slack-notify
//
// Invoked by a Supabase Database Webhook on INSERT into public.submissions.
// Forwards a formatted Block Kit message to a Slack Incoming Webhook.
//
// Required env vars (set via `supabase secrets set`):
//   - SLACK_WEBHOOK_URL: your Slack incoming webhook (https://hooks.slack.com/services/...)
//   - WEBHOOK_SECRET:    shared secret that the DB webhook must present as `Authorization: Bearer <secret>`
//
// Deploy:
//   supabase functions deploy slack-notify --no-verify-jwt
//   supabase secrets set SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
//   supabase secrets set WEBHOOK_SECRET="<random-long-string>"
//
// DB webhook: Supabase → Database → Webhooks → New
//   Table:    public.submissions
//   Events:   Insert
//   Type:     HTTP Request
//   Method:   POST
//   URL:      https://<project-ref>.supabase.co/functions/v1/slack-notify
//   Headers:  Authorization: Bearer <WEBHOOK_SECRET>

// deno-lint-ignore-file
// @ts-nocheck — Deno edge runtime, not Node; globals resolved at deploy time.
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
  "indie-small": "Indie · 1 site",
  "indie-group": "Indie group · multi-site",
  "bar-pub":     "Bar / pub",
  "qsr":         "QSR / fast casual",
  "hotel":       "Hotel F&B",
}[s ?? ""] ?? s ?? "—");

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Shared-secret check — Supabase DB webhook must send Authorization: Bearer <WEBHOOK_SECRET>
  if (WEBHOOK_SECRET) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${WEBHOOK_SECRET}`) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  if (!SLACK_WEBHOOK_URL) {
    return new Response("SLACK_WEBHOOK_URL not set", { status: 500 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Supabase DB webhook wraps the row under `record`. Fall back to the raw body for flexibility.
  const r = body?.record ?? body ?? {};

  const gaps = Array.isArray(r.gap_categories) ? r.gap_categories : [];
  const gapText = gaps.length ? gaps.join(", ") : "_complete stack — no peer gaps_";

  const slackMessage = {
    text: `New Stack Benchmark submission from ${r.first_name ?? "someone"} at ${r.company ?? "an unnamed venue"}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🍞 New Stack Benchmark submission", emoji: true },
      },
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
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Top gap categories*\n${gapText}` },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Marketing consent: ${r.consent ? "✓ opted-in" : "✗ not opted-in"}  ·  submitted ${r.created_at ?? "just now"}`,
          },
        ],
      },
    ],
  };

  const slackRes = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(slackMessage),
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
