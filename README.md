# Tech Stack Review

Lead-gen benchmark tool for the Tech on Toast community. Operators click through the tools they use across 10 categories and receive a personalised report showing where they're behind their peers and the £ / hours/week sitting in their gaps.

- **Frontend:** single-file HTML (React via ESM CDN + Tailwind CDN). Drop-in or iframe anywhere.
- **Storage:** Supabase (single `submissions` table, anon-INSERT only).
- **Slack notifications:** Supabase Database Webhook → Slack incoming webhook. No backend code required.

## Repo layout

```
.
├── index.html                    # the whole app
├── tech-on-toast-logo.svg
├── supabase/
│   └── migrations/
│       └── 001_init.sql          # run in Supabase SQL editor
└── README.md
```

## Setup

### 1. Supabase — create the table

1. Open the Supabase project → **SQL Editor** → **New query**.
2. Paste the contents of [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql) and run it.
3. Confirm: **Table Editor → `submissions`** exists, RLS is **on**, and the `anon can insert submissions` policy is visible.

### 2. Supabase — wire the anon key into the frontend

1. Supabase → **Project Settings → API** → copy the **`anon` public** key.
2. In `index.html`, find the `SUPABASE_CONFIG` block near the top of the `<script type="module">` and replace:
   ```js
   const SUPABASE_ANON_KEY = "REPLACE_WITH_SUPABASE_ANON_KEY";
   ```
   with the real key. The URL is already filled in.

### 3. Slack — create an incoming webhook

1. Go to https://api.slack.com/apps → **Create New App** → *From scratch* → name it "Stack Benchmark" → pick your Tech on Toast workspace.
2. **Incoming Webhooks → Activate** → **Add New Webhook to Workspace** → pick channel (e.g. `#leads`).
3. Copy the webhook URL (`https://hooks.slack.com/services/T…/B…/…`). Keep it private — **don't commit it**.

### 4. Supabase → Slack — Database Webhook

In Supabase → **Database → Webhooks → Create a new hook**:

| Field | Value |
|---|---|
| Name | `submissions-to-slack` |
| Table | `public.submissions` |
| Events | **Insert** only |
| Type | **HTTP Request** |
| Method | `POST` |
| URL | _your Slack webhook URL_ |
| HTTP Headers | `Content-Type: application/json` |
| HTTP Params | _(none)_ |

**Payload** — Slack expects its own format, not Supabase's default. Switch the payload to **custom** and paste:

```json
{
  "text": "🍞 *New Stack Benchmark submission*",
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "🍞 New Stack Benchmark submission" }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Name:*\n{{record.first_name}}" },
        { "type": "mrkdwn", "text": "*Company:*\n{{record.company}}" },
        { "type": "mrkdwn", "text": "*Email:*\n{{record.email}}" },
        { "type": "mrkdwn", "text": "*Segment:*\n{{record.segment}} ({{record.sites}} sites)" },
        { "type": "mrkdwn", "text": "*Score:*\n{{record.score}} / 100" },
        { "type": "mrkdwn", "text": "*Coverage:*\n{{record.coverage_pct}}%" },
        { "type": "mrkdwn", "text": "*Upside:*\n£{{record.total_gbp_per_year}}/yr" },
        { "type": "mrkdwn", "text": "*Hours back:*\n{{record.total_hrs_per_week}} hrs/wk" }
      ]
    },
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*Top gaps:* {{record.gap_categories}}" }
    }
  ]
}
```

> **Note:** Supabase's webhook template variables use double-curly Mustache syntax. If you're on an older Supabase plan that doesn't support custom payloads, create a simple Edge Function as a proxy — ping me.

### 5. Host the frontend

Any static host works — GitHub Pages, Netlify, Vercel, or drop `index.html` + `tech-on-toast-logo.svg` into Webflow's asset manager and embed via `<iframe>`.

For local preview:
```bash
python3 -m http.server 8080
# then open http://localhost:8080/
```

## Data model

The `submissions` row captures both the raw stack responses and the computed report summary — so Slack/CRM can show a useful ping without replaying the calculation.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `created_at` | timestamptz | |
| `venue_type` | text | `indie` / `group` / `bar` / `qsr` / `hotel` / `other` |
| `sites` | text | `1` / `2-5` / `6-20` / `20+` |
| `segment` | text | derived peer segment |
| `stack` | jsonb | full per-category payload incl. `other` free-text |
| `first_name`, `email`, `company` | text | |
| `consent` | boolean | marketing opt-in |
| `score` | integer | 0–100 |
| `coverage_pct` | integer | % of 10 categories with a tool |
| `total_gbp_per_year` | integer | estimated annual upside |
| `total_hrs_per_week` | integer | estimated weekly hours saved |
| `gap_count` | integer | |
| `gap_categories` | text[] | human-readable category labels |

## Spam protection

- Hidden **honeypot** field on the gate form — bots fill it, we silently drop.
- For heavier abuse, consider fronting with Cloudflare Turnstile or moving the submission path through a Supabase Edge Function that validates the token.

## Legal / ROI disclaimer

Benchmark percentages and ROI figures are directional, derived from industry norms and community inputs. They're shown to help operators prioritise — not as a vendor endorsement or guaranteed saving.
