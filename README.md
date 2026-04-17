# Tech Stack Review

Lead-gen tool for the [Tech on Toast](https://www.techontoast.community) community. Operators click through the tools they use across 6 core categories (EPOS, Payments, Workforce, Inventory, Loyalty/CRM, Learning) and get back a personalised report: peer benchmark, score, and a costed list of opportunities — both **gaps** their peers have closed and **switching/renegotiation** upside from what they already run.

- **Frontend:** single-file HTML (React via ESM CDN + Tailwind CDN). Drop-in or iframe anywhere.
- **Storage:** Supabase (`submissions` table, anon-INSERT only via RLS).
- **Slack notifications:** Supabase Database Webhook → **Supabase Edge Function** (`slack-notify`) → Slack Incoming Webhook. The Slack URL stays server-side.

## Repo layout

```
.
├── index.html
├── tech-on-toast-logo.svg
├── supabase/
│   ├── migrations/
│   │   └── 001_init.sql               # run in Supabase SQL editor
│   └── functions/
│       └── slack-notify/
│           └── index.ts               # edge function that posts to Slack
└── README.md
```

## Setup

### 1. Supabase — create the table

1. Open the Supabase project → **SQL Editor** → **New query**.
2. Paste the contents of [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql) and run.
3. Confirm: **Table Editor → `submissions`** exists with RLS **on** and the `anon can insert submissions` policy visible.

### 2. Supabase — wire the anon key into the frontend

The anon key is already wired in [`index.html`](index.html) for this project. If you're forking, replace `SUPABASE_ANON_KEY` near the top of the `<script type="module">` block. The anon key is safe to expose — RLS restricts it to INSERT only.

### 3. Slack — create an Incoming Webhook

1. https://api.slack.com/apps → **Create New App** → *From scratch* → name it "Stack Review" → pick the Tech on Toast workspace.
2. **Incoming Webhooks → Activate** → **Add New Webhook to Workspace** → pick a channel (e.g. `#stack-review-leads`).
3. Copy the webhook URL (`https://hooks.slack.com/services/T…/B…/…`). **Don't commit it** — it goes into a Supabase secret next.

### 4. Deploy the edge function

You'll need the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
# from the repo root
supabase login
supabase link --project-ref kohnakdevwfudzgfjmab

# set secrets (never commit these)
supabase secrets set SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
supabase secrets set WEBHOOK_SECRET="$(openssl rand -hex 32)"

# deploy
supabase functions deploy slack-notify --no-verify-jwt
```

`--no-verify-jwt` is needed because the DB webhook authenticates with our own shared secret (`WEBHOOK_SECRET`), not a Supabase user JWT.

After deploy, the function URL is:

```
https://kohnakdevwfudzgfjmab.supabase.co/functions/v1/slack-notify
```

Test it:
```bash
curl -X POST https://kohnakdevwfudzgfjmab.supabase.co/functions/v1/slack-notify \
  -H "Authorization: Bearer <your WEBHOOK_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"record":{"first_name":"Test","company":"Acme","email":"test@example.com","segment":"indie-group","sites":"2-5","score":72,"coverage_pct":83,"total_gbp_per_year":48000,"total_hrs_per_week":22,"gap_categories":["Workforce","Loyalty / CRM"],"consent":true}}'
```
A Slack message should land in your channel.

### 5. Point a DB webhook at the function

In Supabase → **Database → Webhooks → Create a new hook**:

| Field | Value |
|---|---|
| Name | `submissions-to-slack` |
| Table | `public.submissions` |
| Events | **Insert** only |
| Type | **Supabase Edge Function** |
| Edge function | `slack-notify` |
| HTTP Headers | `Authorization: Bearer <your WEBHOOK_SECRET>` |

Save. Submit a test record through the app — you'll see it in Slack within seconds.

### 6. Host the frontend

Any static host works:
- **GitHub Pages** — Settings → Pages → Build from `main` branch `/` root. URL: `https://tot-stacked.github.io/techstackreview/`.
- **Netlify / Vercel** — drag the folder, instant URL.
- **Webflow** — upload `index.html` + `tech-on-toast-logo.svg` to assets and embed via `<iframe>`.

Local preview:
```bash
python3 -m http.server 8080
# open http://localhost:8080/
```

## Data model

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
| `coverage_pct` | integer | % of 6 categories covered |
| `total_gbp_per_year` | integer | estimated annual upside (gaps + switches) |
| `total_hrs_per_week` | integer | estimated weekly hours saved |
| `gap_count` | integer | |
| `gap_categories` | text[] | human-readable category labels |

## Spam protection

- Hidden **honeypot** field on the gate form — bots that fill it are silently dropped.
- For heavier abuse, front the submission with Cloudflare Turnstile or route through an Edge Function that validates the token.

## ROI disclaimer

Benchmark percentages and ROI figures are directional, derived from industry norms and community inputs. They help operators prioritise — not a vendor endorsement or guaranteed saving.
