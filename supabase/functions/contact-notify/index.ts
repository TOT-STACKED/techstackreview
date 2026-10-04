/**
 * contact-notify
 *
 * Receives a submission from the Stacked website contact form and posts it
 * into Slack, then forwards it to Zoho CRM and Airtable.
 *
 * Deploy: supabase functions deploy contact-notify --no-verify-jwt
 *
 * The --no-verify-jwt matters. Without it every visitor's browser would need
 * to carry an anon key, which means the key sits in the published site JS.
 * Origin checking and the shared token below do the gatekeeping instead.
 *
 * Secrets:
 *   SLACK_CONTACT_WEBHOOK_URL, STACKED_FORM_TOKEN
 *   AIRTABLE_TOKEN / AIRTABLE_LEADS_BASE / AIRTABLE_LEADS_TABLE (optional)
 *   ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET, optionally ZOHO_OWNER_IDS
 *
 * KNOWN ISSUE (unrelated to Zoho): AIRTABLE_LEADS_TABLE defaults to
 * "Master Lead Sheet", which is not a table in that base - its tables are
 * Master View, Partner Pipeline and Slack_Data - and the field names below do
 * not match Master View's either. This leg has never written a row. Left as
 * found; fixing it needs a decision about which table and fields it should
 * target.
 *
 * Both forwards are best effort. Slack is the alert that matters, so a
 * failure in Airtable or Zoho is logged and swallowed rather than costing the
 * notification or showing the visitor an error.
 *
 * Duplicate suppression: a recruitment form once fired seven times for one
 * candidate, so identical submissions inside DEDUPE_WINDOW_SECONDS are
 * answered normally and dropped before Slack. It fails open - if the check
 * itself errors the notification goes out, because a stray duplicate beats a
 * lost lead.
 */

import { upsertLead, SOURCE, type Source } from "./zoho.ts"

const SLACK_WEBHOOK_URL = Deno.env.get("SLACK_CONTACT_WEBHOOK_URL") ?? ""
const FORM_TOKEN = Deno.env.get("STACKED_FORM_TOKEN") ?? ""

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""

const AIRTABLE_TOKEN = Deno.env.get("AIRTABLE_TOKEN") ?? ""
const AIRTABLE_BASE = Deno.env.get("AIRTABLE_LEADS_BASE") ?? ""
const AIRTABLE_TABLE = Deno.env.get("AIRTABLE_LEADS_TABLE") ?? "Master Lead Sheet"

const DEDUPE_WINDOW_SECONDS = 120

/**
 * Exact origins that may post. weareservice.co.uk is the SERVICE 2027 event
 * site, a separate Framer project; its form posts here too, and before it was
 * listed every live submission came back 403.
 */
const ALLOWED_ORIGINS = [
    "https://wearestacked.io",
    "https://www.wearestacked.io",
    "https://weareservice.co.uk",
    "https://www.weareservice.co.uk",
]

const ALLOWED_SUFFIXES = [".framer.website", ".framer.app", ".framercanvas.com"]

function isAllowedOrigin(origin: string): boolean {
    if (!origin) return true // curl and server to server calls send no origin
    if (ALLOWED_ORIGINS.includes(origin)) return true
    return ALLOWED_SUFFIXES.some((suffix) => {
        try { return new URL(origin).hostname.endsWith(suffix) } catch { return false }
    })
}

/**
 * Always echo the caller's origin back, even when refusing it. Returning a
 * different origin makes the browser discard the response, so a plain 403
 * arrives as an unreadable CORS error instead of a status the console prints.
 */
function corsHeaders(origin: string): Record<string, string> {
    return {
        "Access-Control-Allow-Origin": origin || "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, x-stacked-token",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
    }
}

function json(body: unknown, status: number, origin: string): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    })
}

interface Submission {
    name?: string
    email?: string
    company?: string
    jobTitle?: string
    phone?: string
    seniority?: string
    vertical?: string
    enquiryTypes?: string[]
    message?: string
    consent?: boolean | null
    source?: string
    page?: string
    referrer?: string
    utm?: string
    formMode?: string
    hp?: string
    submittedAt?: string
    cvUrl?: string
    cvName?: string
    cvError?: string
}

/** Free inboxes do not count as an operator, same rule as the Stack Review. */
const FREE_DOMAINS = [
    "gmail.com", "googlemail.com", "hotmail.com", "hotmail.co.uk", "outlook.com",
    "live.co.uk", "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "aol.com",
    "protonmail.com", "proton.me",
]

function isBusinessEmail(email: string): boolean {
    const domain = email.split("@")[1]?.toLowerCase() ?? ""
    return domain.length > 0 && !FREE_DOMAINS.includes(domain)
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : ""
}

/**
 * Identity of a submission for duplicate purposes. Deliberately ignores
 * submittedAt and anything else stamped per attempt, because two copies of
 * one enquiry differ in exactly those fields.
 */
function dedupeKey(sub: Submission): string {
    return [
        clean(sub.email).toLowerCase(),
        clean(sub.source),
        (sub.enquiryTypes ?? []).join(","),
        clean(sub.message).slice(0, 200),
    ].join("|")
}

async function claimNotification(key: string): Promise<boolean> {
    if (!SUPABASE_URL || !SERVICE_ROLE) return true
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_notification`, {
            method: "POST",
            headers: {
                apikey: SERVICE_ROLE,
                Authorization: `Bearer ${SERVICE_ROLE}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ p_key: key, p_window_seconds: DEDUPE_WINDOW_SECONDS }),
            signal: AbortSignal.timeout(4000),
        })
        if (!res.ok) {
            console.error("dedupe claim failed", res.status, (await res.text()).slice(0, 300))
            return true
        }
        return (await res.json()) !== false
    } catch (error) {
        console.error("dedupe claim threw", String(error))
        return true
    }
}

/**
 * One emoji per enquiry type so the channel is scannable. Types not listed
 * fall back to FALLBACK_EMOJI, so adding a new enquiry type in Framer never
 * breaks the message.
 */
const TYPE_EMOJI: Record<string, string> = {
    Tech: ":hammer_and_wrench:",
    "Tech Support": ":rotating_light:",
    Recruitment: ":wave:",
    "Get Hired": ":raising_hand:",
    "Find Talent": ":telescope:",
    Events: ":tada:",
    Podcast: ":studio_microphone:",
    Other: ":sparkles:",
}
const FALLBACK_EMOJI = ":sparkles:"

const GMAIL_ACCOUNT = "hello@wearestacked.io"

/** A founder filling in a form is not a normal Tuesday. */
const SENIOR_TITLES = ["Founder or C-suite", "Director"]

function emojiFor(type: string): string {
    return TYPE_EMOJI[type] ?? FALLBACK_EMOJI
}

function slackBlocks(sub: Submission) {
    const name = clean(sub.name) || "Someone"
    const email = clean(sub.email).toLowerCase()
    const company = clean(sub.company)
    const types = (sub.enquiryTypes ?? []).filter(Boolean)
    const heading = types.length ? types.join(", ") : "General"
    const lead = types.length ? emojiFor(types[0]) : FALLBACK_EMOJI
    const quick = clean(sub.formMode) === "compact"
    const dot = "  ·  "

    const blocks: unknown[] = [
        { type: "header", text: { type: "plain_text", text: `${lead} New enquiry`, emoji: true } },
    ]

    const rows: string[] = []
    const addRow = (label: string, value: string) => {
        if (value) rows.push(`*${label}*: ${value}`)
    }

    const seniority = clean(sub.seniority)
    const crown = SENIOR_TITLES.includes(seniority) ? " :crown:" : ""

    addRow("Enquiry", types.map((t) => `${emojiFor(t)} ${t}`).join(", "))
    addRow("Name", name + crown)
    if (company && company.toLowerCase() !== "not provided") addRow("Company", company)
    addRow("Job title", clean(sub.jobTitle))
    addRow("Seniority", seniority)
    addRow("Vertical", clean(sub.vertical))
    if (email) addRow("Email", `<mailto:${email}|${email}>`)
    const phone = clean(sub.phone)
    if (phone) addRow("Phone", `<tel:${phone.replace(/[^\d+]/g, "")}|${phone}>`)
    const cvUrl = clean(sub.cvUrl)
    if (cvUrl) addRow("CV", `<${cvUrl}|${clean(sub.cvName) || "Download"}>`)
    addRow("Source", clean(sub.source) || "Website")

    blocks.push({ type: "section", text: { type: "mrkdwn", text: rows.join("\n") } })

    const message = clean(sub.message)
    if (message) {
        const trimmed = message.length > 2500 ? message.slice(0, 2500) + "..." : message
        blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: `*Notes*:\n>${trimmed.replace(/\n/g, "\n>")}` },
        })
    }

    if (email) {
        const compose = new URL("https://mail.google.com/mail/")
        compose.searchParams.set("view", "cm")
        compose.searchParams.set("fs", "1")
        compose.searchParams.set("to", email)
        compose.searchParams.set("su", `Your enquiry to Stacked (${heading})`)
        if (GMAIL_ACCOUNT) compose.searchParams.set("authuser", GMAIL_ACCOUNT)

        const elements: unknown[] = [{
            type: "button",
            text: { type: "plain_text", text: "Reply in Gmail", emoji: true },
            url: compose.toString(),
        }]
        if (cvUrl) {
            elements.push({
                type: "button",
                text: { type: "plain_text", text: "Open CV", emoji: true },
                url: cvUrl,
            })
        }
        blocks.push({ type: "actions", elements })
    }

    const context: string[] = []
    if (quick) context.push(":zap: Quick form")
    const page = clean(sub.page)
    if (page) {
        try { context.push(`<${page}|${new URL(page).pathname}>`) } catch { context.push(page) }
    }
    if (email && !isBusinessEmail(email)) context.push(":postbox: Free email domain")
    if (sub.consent === false) context.push(":no_bell: No marketing consent")
    if (clean(sub.cvError)) context.push(":warning: CV attached but upload failed")
    if (clean(sub.utm)) context.push(clean(sub.utm))

    if (context.length) {
        blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: context.join(dot) }] })
    }

    return { text: `${lead} New enquiry from ${name} (${heading})`, blocks }
}

async function forwardToAirtable(sub: Submission): Promise<void> {
    if (!AIRTABLE_TOKEN || !AIRTABLE_BASE) return

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}`
    const body = {
        typecast: true,
        records: [{
            fields: {
                Name: clean(sub.name),
                Email: clean(sub.email),
                Company: clean(sub.company),
                "Job title": clean(sub.jobTitle),
                Phone: clean(sub.phone),
                Seniority: clean(sub.seniority),
                Vertical: clean(sub.vertical),
                "Enquiry type": (sub.enquiryTypes ?? []).join(", "),
                Message: clean(sub.message),
                Source: clean(sub.source) || "Website",
                Page: clean(sub.page),
            },
        }],
    }

    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${AIRTABLE_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    })

    if (!res.ok) {
        console.error("airtable forward failed", res.status, await res.text())
    }
}

/**
 * Which Lead Source this submission gets, on first touch only. The page is
 * more trustworthy than the source string, which is set per form instance in
 * Framer and drifts. Candidate and employer are deliberately separated.
 */
function sourceFor(sub: Submission): Source {
    const hay = `${clean(sub.page)} ${clean(sub.source)}`.toLowerCase()
    if (hay.includes("weareservice") || hay.includes("service 2027")) return SOURCE.service
    if (hay.includes("get-hired") || hay.includes("get hired")) return SOURCE.candidate
    if (hay.includes("find-talent") || hay.includes("find talent")) return SOURCE.employer
    return SOURCE.website
}

/**
 * The form collects one name field, Zoho wants two and refuses a Lead with no
 * Last Name. Split on the first space; when there is no space the whole thing
 * becomes the surname rather than being dropped.
 */
function splitName(full: string): { firstName: string | null; lastName: string | null } {
    const parts = full.trim().split(/\s+/)
    if (parts.length < 2) return { firstName: null, lastName: parts[0] ?? null }
    return { firstName: parts[0], lastName: parts.slice(1).join(" ") }
}

async function forwardToZoho(sub: Submission): Promise<void> {
    const email = clean(sub.email).toLowerCase()
    const { firstName, lastName } = splitName(clean(sub.name))

    const result = await upsertLead({
        email,
        firstName,
        lastName,
        company: clean(sub.company) || null,
        phone: clean(sub.phone) || null,
        jobTitle: clean(sub.jobTitle) || null,
        source: sourceFor(sub),
        // The recruitment component sends its own enquiryType prop, which has
        // been seen carrying a person's name. zoho.ts drops anything off the
        // picklist, so junk no longer reaches the CRM.
        enquiryTypes: (sub.enquiryTypes ?? []).filter(Boolean),
        seniority: clean(sub.seniority) || null,
        vertical: clean(sub.vertical) || null,
        consent: typeof sub.consent === "boolean" ? sub.consent : null,
        pageUrl: clean(sub.page) || null,
        message: clean(sub.message) || null,
        cvUrl: clean(sub.cvUrl) || null,
    })

    console.error(`[zoho] ${result.action} ${"id" in result ? result.id : result.reason} (${email})`)
}

Deno.serve(async (req: Request) => {
    const origin = req.headers.get("origin") ?? ""

    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405, origin)
    if (!isAllowedOrigin(origin)) return json({ error: "origin not allowed", origin }, 403, origin)
    if (FORM_TOKEN && req.headers.get("x-stacked-token") !== FORM_TOKEN) {
        return json({ error: "bad token" }, 403, origin)
    }

    let sub: Submission
    try { sub = await req.json() } catch { return json({ error: "bad json" }, 400, origin) }

    // Honeypot. Answer normally so the bot has nothing to learn from.
    if (clean(sub.hp)) return json({ ok: true }, 200, origin)

    const name = clean(sub.name)
    const email = clean(sub.email)
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: "name and a valid email are required" }, 400, origin)
    }

    if (!SLACK_WEBHOOK_URL) {
        console.error("SLACK_CONTACT_WEBHOOK_URL is not set")
        return json({ error: "not configured" }, 500, origin)
    }

    const claimed = await claimNotification(dedupeKey(sub))
    if (!claimed) {
        console.info(`[dedupe] suppressed repeat submission from ${email.toLowerCase()}`)
        return json({ ok: true, duplicate: true }, 200, origin)
    }

    const slackRes = await fetch(SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slackBlocks(sub)),
    })

    if (!slackRes.ok) {
        console.error("slack post failed", slackRes.status, await slackRes.text())
        return json({ error: "slack post failed" }, 502, origin)
    }

    await Promise.allSettled([
        forwardToAirtable(sub).catch((e) => console.error("airtable forward threw", String(e))),
        forwardToZoho(sub).catch((e) => console.error("zoho forward threw", String(e))),
    ])

    return json({ ok: true }, 200, origin)
})
