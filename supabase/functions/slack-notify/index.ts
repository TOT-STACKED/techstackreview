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
const AIRTABLE_API_KEY           = Deno.env.get("AIRTABLE_API_KEY");
// Alerts channel for silent sync failures. Was diagnosed Jul 2026 when Sprout
// & Popeyes submissions never made it to the portal — the failures were only
// logged to Supabase function logs (which nobody watches). Posts here on any
// sync/forward catch so the on-call sees it in real time.
// Falls back to SLACK_WEBHOOK_URL (the new-submission channel) so alerts are
// on by default; override with SYNC_ALERT_SLACK_WEBHOOK_URL to route them
// into a dedicated #sync-alerts channel.
const SYNC_ALERT_SLACK_WEBHOOK_URL =
  Deno.env.get("SYNC_ALERT_SLACK_WEBHOOK_URL") || SLACK_WEBHOOK_URL;

async function alertSyncFailure(stage: string, r: any, error: any) {
  if (!SYNC_ALERT_SLACK_WEBHOOK_URL) return;
  const msg = (error && error.message) ? error.message : String(error);
  const company = r?.company ?? "unknown";
  const submissionId = r?.id ?? "unknown";
  const email = r?.email ?? "unknown";
  const text = `:rotating_light: *Stack review sync failure* — \`${stage}\`\n*Company:* ${company}\n*Submission ID:* \`${submissionId}\`\n*Email:* ${email}\n*Error:* \`\`\`${msg.slice(0, 800)}\`\`\``;
  try {
    await fetch(SYNC_ALERT_SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (_) {
    // Alert itself failed — nothing we can safely do. Original error is already logged.
  }
}

// Master Lead Sheet → "Master View" table. Forward just the contact details
// of every new submission so the sales pipeline picks up the lead. IDs are
// stable identifiers (not secrets); only the API key is a secret.
const AIRTABLE_BASE_ID  = "apphtL2hcdRu2EDPV";
const AIRTABLE_TABLE_ID = "tblUkL8xKL4ZNUFKV";
// Field IDs on the Master View table (resolved via the Airtable schema).
const AIRTABLE_FIELDS = {
  businessName:  "fldaIprcZqrPGRxen",
  firstName:     "fld26qV2h9PnWZpKD",
  lastName:      "fldnMvs9tjp2RHVeY",
  contactEmail:  "fldRdQUlKtkwn6eHK",
  contactNumber: "fldmNvuo4hUotbcjY",
  location:      "fldTwzHji3JbrvHPU",
  size:          "fldwUdKgqSG6E2JZ1", // singleLineText
  vertical:      "fldd84s7oTrjUn5Oe", // singleSelect — mapped from venue_type below
  source:        "fldMgrGbR7iFwSxij", // singleSelect — tag every Stack Review lead "Tech Check"
  date:          "fldRND3uaiduLQouI", // date
  leadStatus:    "fldf4TNAglyB9s2gP", // singleSelect — every new lead enters at "MAL"
};

// Map the form's raw venue_type → the Master View "Vertical" dropdown options.
// `other` (and anything unmapped) is left blank rather than guessed.
const VERTICAL_TO_AIRTABLE: Record<string, string> = {
  indie: "Restaurant",
  group: "Restaurant",
  bar:   "Bar",
  qsr:   "QSR",
  hotel: "Hotel",
};

// Forward contact details (only) to the Master Lead Sheet in Airtable.
// Best-effort, non-blocking — Slack + portal sync are unaffected if this fails.
async function forwardToAirtable(r: any) {
  if (!AIRTABLE_API_KEY) return;
  const fields: Record<string, string> = {};
  if (r.company)      fields[AIRTABLE_FIELDS.businessName]  = String(r.company);
  if (r.first_name)   fields[AIRTABLE_FIELDS.firstName]     = String(r.first_name);
  if (r.last_name)    fields[AIRTABLE_FIELDS.lastName]      = String(r.last_name);
  if (r.email)        fields[AIRTABLE_FIELDS.contactEmail]  = String(r.email);
  if (r.phone_number) fields[AIRTABLE_FIELDS.contactNumber] = String(r.phone_number);
  if (r.location)     fields[AIRTABLE_FIELDS.location]      = String(r.location);
  // Size: human label (e.g. "2–5 sites"); falls back to the raw value.
  if (r.sites)        fields[AIRTABLE_FIELDS.size]          = SIZE_LABEL[r.sites] ?? String(r.sites);
  // Vertical: map venue_type to an existing dropdown option; skip if unmapped.
  const vertical = VERTICAL_TO_AIRTABLE[r.venue_type];
  if (vertical)       fields[AIRTABLE_FIELDS.vertical]      = vertical;
  // Date: the submission date (YYYY-MM-DD) for the Master View "Date" column.
  if (r.created_at)   fields[AIRTABLE_FIELDS.date]          = String(r.created_at).slice(0, 10);
  // Constant: every Stack Review lead is tagged "Tech Check" as its Source.
  fields[AIRTABLE_FIELDS.source] = "Tech Check";
  // Constant: every new lead enters the pipeline at "MAL" (Marketing Accepted Lead).
  fields[AIRTABLE_FIELDS.leadStatus] = "MAL";

  // Nothing useful to write (e.g. honeypot/empty record) — skip.
  if (!fields[AIRTABLE_FIELDS.contactEmail] && !fields[AIRTABLE_FIELDS.businessName]) return;

  try {
    const res = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AIRTABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        // typecast lets Airtable resolve the "Tech Check" singleSelect option
        // by name (it already exists, so no new option is created).
        body: JSON.stringify({ records: [{ fields }], typecast: true }),
      },
    );
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      console.error(`[airtable] forward failed ${res.status}: ${bodyText}`);
      await alertSyncFailure("airtable-forward", r, `HTTP ${res.status}: ${bodyText}`);
    } else {
      console.error(`[airtable] lead forwarded: ${r.company ?? r.email ?? "?"}`);
    }
  } catch (e) {
    console.error("[airtable] forward threw", e);
    await alertSyncFailure("airtable-forward", r, e);
  }
}

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

function summarizeNps(productNps: any): { line: string; detractors: string[]; count: number } {
  const entries = productNps && typeof productNps === "object"
    ? Object.entries(productNps).filter(([, v]) => typeof v === "number")
    : [];
  if (!entries.length) return { line: "_no product NPS captured_", detractors: [], count: 0 };
  const scores = entries.map(([, v]) => v as number);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const promoters = scores.filter((s) => s >= 9).length;
  const detractorPairs = entries.filter(([, v]) => (v as number) <= 6) as Array<[string, number]>;
  const detractorsList = detractorPairs.map(([name, v]) => `${name} (${v})`);
  const line = `avg *${avg.toFixed(1)}/10* across ${entries.length} product${entries.length === 1 ? "" : "s"} · ${promoters} promoter${promoters === 1 ? "" : "s"} · ${detractorPairs.length} detractor${detractorPairs.length === 1 ? "" : "s"}`;
  return { line, detractors: detractorsList, count: entries.length };
}

function buildSubmissionMessage(r: any) {
  const gaps = Array.isArray(r.gap_categories) ? r.gap_categories : [];
  const gapText = gaps.length ? gaps.join(", ") : "_complete stack, no peer gaps_";
  const fullName = [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || "—";
  const phoneDisplay = r.phone_number
    ? `<tel:${String(r.phone_number).replace(/\s+/g, "")}|${r.phone_number}>`
    : "—";
  const nps = summarizeNps(r.product_nps);
  const npsBlocks: any[] = [
    { type: "section", text: { type: "mrkdwn", text: `*Product NPS*\n${nps.line}` } },
  ];
  if (nps.detractors.length) {
    npsBlocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*⚠ Detractors (≤6)*\n${nps.detractors.join(", ")}` },
    });
  }
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
      ...npsBlocks,
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Marketing consent: ${r.consent ? "✓ opted-in" : "✗ not opted-in"}  ·  submitted ${r.created_at ?? "just now"}` }],
      },
    ],
  };
}

const painLabel = (v?: string) => ({
  pos: "Point of Sale", payments: "Payments", workforce: "People Management",
  inventory: "Inventory & Stock Management", loyalty: "Loyalty & CRM", learning: "Learning & Development",
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
// Values land verbatim in tech_stack_entries.category on the approved-
// reporting portal. Must exactly match the portal's 25-category taxonomy —
// off-list values become orphaned categories in the dashboards.
// Legacy `finance_ops` retained (never sent by the current frontend, kept
// here as a safety net) and remapped to the canonical Analytics & Reporting.
const CATEGORY_LABEL: Record<string, string> = {
  pos:       "Point of Sale",
  payments:  "Payments",
  workforce: "People Management",
  inventory: "Inventory & Stock Management",
  loyalty:   "Loyalty & CRM",
  learning:  "Learning & Development",
  finance_ops: "Finance & Accounting",
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
    location:             r.location ?? null,
    contact_name:         contactName,
    contact_email:        r.email ?? null,
    role:                 null,
    phone_number:         r.phone_number ?? null,
    number_of_locations:  SIZE_LABEL[r.sites] ?? r.sites ?? null,
    vertical:             VERTICAL_LABEL[r.venue_type] ?? r.venue_type ?? null,
    submission_type:      "external",
    marketing_consent:    !!r.consent,
    // Forwarded from submissions.uses_whatsapp (techstackreview migration 008).
    // Lets the portal surface the WhatsApp Yes/No panel without reading the
    // source submissions table cross-project. Older rows have null.
    uses_whatsapp:        r.uses_whatsapp ?? null,
    // Forwarded from submissions.brand_trading_name + submissions.site_count
    // (techstackreview migration 010). brand_trading_name identifies the
    // umbrella operator for a multi-site chain; site_count is the exact number
    // of physical venues that operator runs. Both populate the corresponding
    // manual fields on Airtable Venues via approved-reporting's tech-usage-sync,
    // so marketplace partner tiles read real site counts, not just row counts.
    brand_trading_name:   r.brand_trading_name ?? null,
    site_count:           typeof r.site_count === "number" ? r.site_count : null,
    // Forwarded from submissions.has_knowledge_base (techstackreview migration
    // 009). Identifies operators without a team knowledge base — the natural
    // audience for the free Stacked Chat offering.
    has_knowledge_base:   r.has_knowledge_base ?? null,
  };

  try {
    const bizRes = await fetch(`${STACKCOLLECT_SUPABASE_URL}/rest/v1/business_submissions`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify(biz),
    });
    if (!bizRes.ok) {
      const bodyText = await bizRes.text().catch(() => "");
      console.error("[stackcollect] business_submissions insert failed", bizRes.status, bodyText);
      await alertSyncFailure("stackcollect-business", r, `HTTP ${bizRes.status}: ${bodyText}`);
      return;
    }
    const bizRows = await bizRes.json();
    const bizRow = Array.isArray(bizRows) ? bizRows[0] : bizRows;
    if (!bizRow?.id) return;

    const stack = r.stack ?? {};
    const entries: Array<{ submission_id: string; category: string; tool_name: string; nps: number | null }> = [];
    for (const [catId, sRaw] of Object.entries<any>(stack)) {
      const s = sRaw || {};
      // Portal-side agreement: never send a blank category. Fall back to
      // "Other" (a canonical value on their taxonomy) when the catId isn't
      // in CATEGORY_LABEL and there's no usable string to fall back to.
      const catLabel = (CATEGORY_LABEL[catId] || String(catId || "").trim() || "Other");
      const catNps = (s.nps && typeof s.nps === "object") ? s.nps : {};
      for (const t of (s.tools ?? [])) {
        if (!t) continue;
        const score = catNps[t];
        entries.push({
          submission_id: bizRow.id,
          category: catLabel,
          tool_name: String(t),
          nps: typeof score === "number" ? score : null,
        });
      }
      const other = (s.other ?? "").toString().trim();
      if (other) {
        const score = catNps[`__other__:${other}`];
        entries.push({
          submission_id: bizRow.id,
          category: catLabel,
          tool_name: other,
          nps: typeof score === "number" ? score : null,
        });
      }
    }

    if (entries.length > 0) {
      const url = `${STACKCOLLECT_SUPABASE_URL}/rest/v1/tech_stack_entries`;
      // Legacy writes always go without the `nps` column — the portal's
      // tech_stack_entries table is the system of record for tools, not NPS.
      // NPS lands in the dedicated nps_scores table below.
      const legacyEntries = entries.map(({ nps: _nps, ...rest }) => rest);
      const entriesRes = await fetch(url, {
        method: "POST",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify(legacyEntries),
      });
      if (!entriesRes.ok) {
        const bodyText = await entriesRes.text().catch(() => "");
        console.error("[stackcollect] tech_stack_entries insert failed", entriesRes.status, bodyText);
        await alertSyncFailure("stackcollect-entries", r, `HTTP ${entriesRes.status}: ${bodyText}`);
      }
    }

    // Fan-out per-product NPS into the portal's unified nps_scores table.
    // Both submission_id (the FK the portal's per-operator dashboards join
    // on) and external_id (kept for backward compat with earlier rows) point
    // at the same business_submissions row. Setting only external_id
    // previously caused NPS ratings to appear in vendor aggregates but not
    // on the operator's own record — the "Flora/Bado bug" the portal team
    // fixed by hand.
    //
    // Dedupe by (submission_id, vendor) — the portal has a unique index
    // (nps_scores_product_selection_unique_idx) that permits one rating per
    // vendor per submission. Operators sometimes pick the same tool in two
    // categories (e.g. a POS with built-in inventory listed under both POS
    // and Inventory); before this dedupe the whole batch rolled back and the
    // operator lost ALL their NPS scores (the "Boxpark bug", Jul 2026).
    // Keep the first occurrence — categories are just labels on the score.
    const seenVendors = new Set<string>();
    const npsRows = entries
      .filter(e => typeof e.nps === "number")
      .filter(e => {
        const key = String(e.tool_name).trim().toLowerCase();
        if (seenVendors.has(key)) return false;
        seenVendors.add(key);
        return true;
      })
      .map(e => ({
        source:           "techstackreview",
        touchpoint:       "product-selection",
        score:            e.nps,
        vendor:           e.tool_name,
        category:         e.category,
        respondent_name:  contactName,
        respondent_email: r.email ?? null,
        company:          r.company ?? null,
        submission_id:    bizRow.id,
        external_id:      bizRow.id,
      }));
    if (npsRows.length > 0) {
      const npsRes = await fetch(`${STACKCOLLECT_SUPABASE_URL}/rest/v1/nps_scores`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify(npsRows),
      });
      if (!npsRes.ok) {
        const bodyText = await npsRes.text().catch(() => "");
        console.error("[stackcollect] nps_scores insert failed", npsRes.status, bodyText);
        await alertSyncFailure("stackcollect-nps", r, `HTTP ${npsRes.status}: ${bodyText}`);
      }
    }
  } catch (e) {
    console.error("[stackcollect] sync threw", e);
    await alertSyncFailure("stackcollect-sync", r, e);
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

  // Fan-out to the portal's Supabase + Master Lead Sheet on stage 1 submissions.
  //
  // MUST await here (Promise.allSettled so a single failure doesn't cascade).
  // These used to be fire-and-forget for a "fast Slack" win — but Deno Deploy /
  // Supabase Edge terminates the isolate as soon as the response returns, and
  // Lovable's sync makes THREE sequential REST hops (business_submissions →
  // tech_stack_entries → nps_scores). Airtable's single POST usually completed
  // in time, so the Master Lead Sheet stayed populated while Lovable silently
  // dropped every submission. Diagnosed 2026-08-13 when Adventure Golf +
  // Fulham Shore appeared in Airtable but never in the portal.
  //
  // Cost: Slack ping arrives ~1–2s later. Acceptable — sync completeness > latency.
  if (tbl === "submissions") {
    const results = await Promise.allSettled([
      syncToStackcollect(r),
      forwardToAirtable(r),
    ]);
    for (const [i, res] of results.entries()) {
      if (res.status === "rejected") {
        const stage = i === 0 ? "stackcollect-unhandled" : "airtable-unhandled";
        console.error(`[${stage}]`, res.reason);
        await alertSyncFailure(stage, r, res.reason);
      }
    }
  }

  const slackRes = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });

  if (!slackRes.ok) {
    const errText = await slackRes.text().catch(() => "");
    console.error(`[slack-notify] Slack returned ${slackRes.status}: ${errText}`);
    return new Response(`Slack responded ${slackRes.status}: ${errText}`, { status: 502 });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
