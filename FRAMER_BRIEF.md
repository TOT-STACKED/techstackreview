# Stacked Marketplace — Framer Build Brief

_Single source of truth for the Framer rebuild of the Stacked (formerly Tech on Toast) technology marketplace. Paste sections into Framer AI, or hand to a designer/dev as-is._

_Last updated: 14 Aug 2026_

---

## 1. What this is

Stacked is the UK's operator-verified hospitality tech marketplace. Every partner listed here is scored by the operators actually using it — from live audit submissions, not vendor-supplied testimonials. That is our unfair advantage; the whole site should orbit it.

**One-line positioning:** _The only marketplace rated by the operators using it._

**One-paragraph elevator:** Stacked helps hospitality operators find the right tech faster, backed by live scores from the venues running each tool. Every profile carries real ratings, real venue counts, and a real breakdown of what operators use it for — no vendor spin, no pay-to-rank.

---

## 2. Brand system

- **Display type:** Chunko Bold (primary) / Archivo Black (fallback) — used for hero headlines and section titles. Chunky, confident, black-weight sans.
- **Body type:** DM Sans — all body, UI, form copy.
- **Mono:** JetBrains Mono — data, numbers-heavy tiles, code-style annotations.
- **Palette:**
  - Cream `#F5EDDD` (page background)
  - Peach `#F6D7B0` (hero/panel backgrounds)
  - Pink `#F5A9C4` (stat tiles, accents)
  - Deep burgundy `#5C1932` (contrast panel, badge)
  - Signal orange `#E85D3B` (primary CTA)
  - Ink `#1A1A1A` (all text)
- **Radius:** ~12–16px on tiles, ~24px on primary buttons.
- **Voice:** direct, jargon-light, operator-first. Never marketing-speak. See `CLAUDE.md` for the full voice guide the AI review uses — the marketplace copy should follow the same rules.

---

## 3. Data model — Airtable is source of truth

The Framer site reads Airtable REST directly (5-minute cache in `Partner.tsx`). Do not build against Framer CMS — it gets stale. Base: `appNvxXXaMWJfiX6X` (TOT Website).

**Tables you need:**

| Table | Purpose | Key fields |
|---|---|---|
| **Partners** | The marketplace tile + partner page source | Name, Slug, Package (Lite / Promote / Approved), Webflow Status, Summary, Description (richText), Website, Logo, Technology (link), Sector (link), Support (link), Integration (link), Features (link), Solution (link), SOS Score (formula), SOS Reviews (formula), Operators using (number), Operators (brands) (rollup), Venues using (rollup), Operator names (rollup) |
| **Venues** | Every operator/venue that has submitted a stack review | Venue, Industry, Region, Site count, Brand override, Effective sites (formula) |
| **Tech Usage** | Which venue uses which partner (self-reported) | Venue (link), Partner (link), Tool, Category, Source, Submission date |
| **Technology / Sector / Solution / Features / Support / Integration** | Taxonomy tables for the pill filters | Name, Slug, Partners (link) |
| **Reviews** | Operator reviews. `Approved` gate before they count toward live SOS | Venue or operator, Partner, Score (1–5 stars), Approved, Counted score (formula) |

**Slug convention:** kebab-case of the partner Name (`"ICR Touch"` → `"icr-touch"`). Framer's `/partners/:slug` route MUST query Airtable by the `Slug` field. If the marketplace tile links use a different slug than the Slug field, the partner page 404s. This has bit us before (Embargo, Workforce.com, Aloha) — the fix is always to keep tile-link and query on the same field.

**Package tiers — visible differences:**

| Tier | Hero band | Video slot | Primary CTA | Approved badge | Testimonial pull-quote |
|---|---|---|---|---|---|
| **Lite** | Grayscale | Hidden | "Is this your business?" only | ❌ | ❌ |
| **Promote** | Brand colour | Shown (with fallback if empty) | "Get in touch" | ❌ | ❌ |
| **Approved** | Brand colour | Shown (with fallback if empty) | "Get in touch" | ✅ | ✅ (if present) |

This tier gating is important — the BD proposition to Lite partners ("upgrade to Promote for £X") relies on visible difference.

---

## 4. Pages required

### 4.1 `/marketplace` — index

- **Hero (peach panel):**
  - Eyebrow: `OPERATOR-VERIFIED`
  - Headline: `THE ONLY MARKETPLACE RATED BY THE OPERATORS USING IT` (Chunko Bold, 3–4 line max at desktop)
  - Body: `Every partner listing carries live scores from real operators. See who uses what, what they rate it, and what they use it for — Stacked Verified data, built for the industry by the industry.`
  - Primary CTA: `Browse partners` (jumps to grid below)
- **Right-hand burgundy panel (about the Approved badge):**
  - Heading: `Approved Partners` with the pink Approved seal badge
  - Body: `The seal means our team has vetted the listing end-to-end. Every profile — Approved or not — carries live operator data: who's using it, what they use it for, and how they rate it.`
- **Browse by category grid:** 6 orange tiles (Point of Sale, Payments, People Management, Inventory & Stock, Loyalty & CRM, Learning & Development) + 2 secondary (Guest Feedback, Finance & Accounting). Each links to a filtered category page.
- **Featured partners strip:** 6–8 Approved partners, tile format below.
- **All partners grid:** paginated / infinite scroll. Filterable by category, sector, sites-size, SOS score.

### 4.2 `/marketplace/category/:categorySlug` — category page

- Filtered grid of partners in that category
- Left sidebar: filter chips (SOS score min, sector, sites-size, integrations)
- Sort: SOS score desc (default), venues desc, alphabetical

### 4.3 `/partners/:slug` — partner detail (the main page)

**Hero panel (peach, ~40vh):**
- Partner name in Chunko Bold display
- Approved seal badge top-right (Approved tier only)
- One-line summary
- Primary CTA: `Get in touch` (Promote/Approved) or `Is this your business?` (Lite)

**Metric row — 3 tiles:**
| Tile | Field | Format |
|---|---|---|
| Operators | `Operators (brands)` rollup | big number + "Operators" label |
| Venues | `Venues using` rollup | big number + "Venues" label |
| Operator score | `SOS Score` formula | `4.6★` — biggest visual weight, this is the buying signal |

Under the tiles: `Stacked-verified data, live from operator audits · How we score →` (small caption, links to methodology page)

**Operators who use it strip:**
- First 5 venue names as pills (from `Operator names` rollup)
- `+N` chip that expands inline (not a modal)

**Main content grid (2 col below):**

Left column:
- Video slot (partner-provided, falls back to logo lockup on brand colour if empty)
- **In their words** section (partner-authored `Description` richText)
- **What operators use it for** — horizontal bar chart of category breakdown from Tech Usage rows (e.g. Point of Sale 48%, Payments 32%, Mobile/QR 12%, Inventory 8%). Above chart: caption `Of the {N} venues using it, this is what they use it for.`

Right sidebar:
- **SOLUTION** — pills with icons (from `Solution` links)
- **TECHNOLOGY** — pills, tech spec (Cloud / iOS / Android / API from `Technology` links)
- **SECTOR** — max 3 pills; hide section if all 6 are selected (means "everyone", no signal)
- **INTEGRATION PARTNERS {N}** — show top 6 as pills, `+N more` chip; or logo strip (preferred)
- **SUPPORT** — inline sentence not chips: e.g. `24/7 UK-based support, dedicated account manager, in-person training included.`
- **INTERESTED?** — primary CTA (sticky on scroll), secondary `Is this your business?`

**Do NOT include** on the sidebar:
- Solution / Technology as vague taxonomy jargon ("Operations & Efficiency"). Every pill must be specific.
- More than 3 sectors — a filter that includes everyone doesn't filter anything.
- 22 integration pills as a wall — use a preview + expand.

### 4.4 Stack Review form (`/tech-stack-health` currently on Webflow)

Currently an iframe embed of `techstackreview` (github.com/TOT-STACKED/techstackreview). Stays as-is on Framer via iframe — do NOT rebuild the form itself. Just embed the same GitHub Pages URL.

For reference, current form captures (all lands in Airtable Master Lead Sheet + Lovable `business_submissions`):
- Venue: type, brand trading name, exact site count, region, contact details
- 6 core categories with tools + NPS (Point of Sale, Payments, People Management, Inventory & Stock Management, Loyalty & CRM, Learning & Development)
- 2 add-on categories with tools + NPS (Finance & Accounting, Guest Feedback)
- Uses WhatsApp for staff comms (yes/no)
- Has team knowledge base (yes/no)
- Contact email / phone / marketing consent

Data flows from form → Supabase `submissions` → trigger fires `slack-notify` edge function → fans out to Slack ping + Airtable Master Lead Sheet + Lovable portal tables. Twice-daily crons then push new venues and tech-usage rows into Airtable Venues + Tech Usage marketplace tables.

### 4.5 `/marketplace/how-we-score` — methodology page

- Explains the SOS Score model (0–10 NPS from operator audits, averaged and normalised to 0–5 stars, published once ≥2 responses)
- Data provenance (form → Supabase → Airtable), refresh cadence (twice daily)
- Anti-gaming disclosure: partners cannot pay to change their score, vendors cannot rate themselves

---

## 5. Component library — Framer components to build

- `<PartnerTile>` — logo, name, one-line summary, SOS score row (stars + n), venue count, top-3 categories, tier badge if Approved
- `<PartnerHero>` — full-bleed peach panel, name, summary, CTA, seal (tier-gated)
- `<StatTile>` — big number + label, colour-variant prop (peach/pink/burgundy)
- `<OperatorPillRow>` — venue-name pills, `+N` expand chip
- `<CategoryBarChart>` — horizontal bar chart of the Tech Usage category breakdown
- `<SidebarSection>` — heading + content slot, consistent spacing
- `<IntegrationPreview>` — first-6 logos/names, `+N more` link
- `<StickyCTAButton>` — sticks to sidebar on scroll
- `<TierGate>` — HOC that shows/hides slot content based on Partner.Package field
- `<TrustCaption>` — the "Stacked-verified data" line, always paired with a `How we score →` link

---

## 6. Copy library — canonical phrases

Use these verbatim; they've been tested against the AI review's tone rules in `CLAUDE.md`.

**Marketplace hero:**
> **OPERATOR-VERIFIED**  
> **THE ONLY MARKETPLACE RATED BY THE OPERATORS USING IT**  
> Every partner listing carries live scores from real operators. See who uses what, what they rate it, and what they use it for — Stacked Verified data, built for the industry by the industry.

**Approved partners card:**
> **Approved Partners**  
> The seal means our team has vetted the listing end-to-end. Every profile — Approved or not — carries live operator data: who's using it, what they use it for, and how they rate it.

**Data provenance caption (always paired with the metric row):**
> Stacked-verified data, live from operator audits · How we score →

**Partner page — "What operators use it for" caption:**
> Of the {N} venues using it, this is what they use it for.

**CTAs:**
- Primary (Promote/Approved): `Get in touch`
- Secondary / Lite: `Is this your business?`
- Marketplace nav: `Browse partners`
- Methodology: `How we score →`

**Language to avoid:**
- "The people who use the tech" → say **operators**
- `"Stacked Verified"` in quotation marks → drop quotes, treat as a proper noun
- "We recommend X" / "Switch to Y" / "Stay away from Z" → agnostic phrasing; see `CLAUDE.md` for the full ban list
- "Tech on Toast partner" / "approved partner" as generic labels — Approved is only the specific tier

---

## 7. Integrations & environment

**Airtable REST direct** (bypass Framer CMS):
- Base: `appNvxXXaMWJfiX6X`
- Auth: `MARKETPLACE_AIRTABLE_KEY` (Netlify env var; keep server-side)
- Cache: 5 min per query
- Rate limit: 5 req/s per base — cache aggressively

**Backend syncs** (already built, do not rebuild):
- `sos-sync` (approvedreporting.netlify.app/api/sos-sync) — twice daily 05:30 + 12:30 UTC. Reads Lovable NPS scores, writes SOS Score (manual) + SOS Reviews (manual) to Partners.
- `tech-usage-sync` (approvedreporting.netlify.app/api/tech-usage-sync) — twice daily 05:35 + 12:35 UTC. Reads Lovable business_submissions + tech_stack_entries, writes to Airtable Venues + Tech Usage. Idempotent per-venue diff.

**Partner-page routing gotcha:**
Framer's dynamic route generates the URL slug from a page setting. Whatever that is, the Airtable `Slug` field must match it exactly. When they diverge, the page 404s while the tile still shows. Sanity check every new partner: click the tile, confirm the URL matches Airtable's Slug field, not a normalised version of Name.

---

## 8. Category taxonomy (canonical — do not rename)

These 8 category labels are used across the form → Supabase → Airtable → Framer chain. Any deviation orphans the data.

| Slug | Label | Icon |
|---|---|---|
| `pos` | Point of Sale | 🧾 |
| `payments` | Payments | 💳 |
| `workforce` | People Management | 👥 |
| `inventory` | Inventory & Stock Management | 📦 |
| `loyalty` | Loyalty & CRM | ⭐ |
| `learning` | Learning & Development | 🎓 |
| `finance_ops` | Finance & Accounting | 📊 |
| `guest_feedback` | Guest Feedback | 💬 |

---

## 9. Definition of done

The Framer build ships when:

- [ ] Marketplace index renders with hero copy verbatim from §6
- [ ] Category filter grid works, sorts by SOS desc by default
- [ ] Partner page renders 3-stat metric row above the fold with data-provenance caption
- [ ] Package tier gating is verifiable (Lite / Promote / Approved show different hero + CTA + badge)
- [ ] Video fallback renders when the field is empty (never shows "Video unavailable")
- [ ] Slug query matches Airtable Slug field 1:1 — tested on all currently-live partners
- [ ] "Operators who use it" pills expand inline, not a modal
- [ ] Sticky CTA works on desktop + mobile
- [ ] `/marketplace/how-we-score` methodology page live and linked from every SOS caption
- [ ] Chunko Bold / DM Sans / JetBrains Mono fonts loading on every route
- [ ] All 8 category taxonomy labels match §8 exactly (no orphaned entries in the dashboards)

---

_Questions or edge cases as you build — check `techstackreview/CLAUDE.md` for the voice guide and the AI review's product knowledge. That's the same source of truth the review bot uses; keeping the marketplace aligned with it means no voice drift between the review the operator reads and the partner pages they click through to._
