/**
 * luma-notify
 *
 * 2026-10-04: fixed duplicate leads. Luma fires guest.registered and
 * ticket.registered ~20ms apart for the same person. The old dedupe key
 * included the event type, so both proceeded, both searched Zoho for the
 * email, neither saw a lead because the other had not finished inserting,
 * and both created one. 24 duplicate pairs out of 50 registrations.
 *
 * Two independent defences now, because either alone can fail:
 *   1. The claim key is the guest id only - no event type - so the second of
 *      the pair is dropped before it reaches Zoho.
 *   2. Zoho's own /Leads/upsert with duplicate_check_fields matches
 *      server-side and atomically, so even if two race through, the second
 *      updates rather than inserts.
 *
 * Also fixed: names. Luma sends user_first_name/user_last_name null for most
 * registrations but populates user_name. The old code never read it and fell
 * through to the email local-part, which is why records ended up with
 * something like "jane.smith" where a surname belongs.
 *
 * Signature: Luma uses Standard Webhooks - webhook-id, webhook-timestamp,
 * webhook-signature, HMAC-SHA256 over `{id}.{timestamp}.{body}`. Controlled
 * by LUMA_SIGNATURE_MODE: "log" (default) verifies and logs but processes
 * either way; "enforce" rejects failures. Start on log, confirm
 * `signature ok` appears, then switch. Enforcing before confirming risks
 * dropping real registrations.
 */

import { createClient } from "jsr:@supabase/supabase-js@2"
import { upsertLead, SOURCE } from "../_shared/zoho.ts"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const SIGNATURE_MODE = (Deno.env.get("LUMA_SIGNATURE_MODE") ?? "log").toLowerCase()

const db = createClient(SUPABASE_URL, SERVICE_ROLE)

const FREE_DOMAINS = [
    "gmail.com", "googlemail.com", "hotmail.com", "hotmail.co.uk", "outlook.com",
    "live.co.uk", "live.com", "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com",
    "aol.com", "protonmail.com", "proton.me", "msn.com", "btinternet.com",
    "sky.com", "virginmedia.com",
]

function isBusinessEmail(email: string): boolean {
    const domain = email.split("@")[1]?.toLowerCase() ?? ""
    return domain.length > 0 && !FREE_DOMAINS.includes(domain)
}

function money(amount: unknown, currency: unknown): string | null {
    const n = Number(amount)
    if (!Number.isFinite(n) || n === 0) return null
    const major = (n / 100).toFixed(2) // Luma reports minor units
    const cur = typeof currency === "string" ? currency.toUpperCase() : ""
    return cur ? `${cur} ${major}` : major
}

function titleCase(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

function splitFullName(full: string): { first: string | null; last: string | null } {
    const parts = full.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) return { first: null, last: null }
    if (parts.length === 1) return { first: null, last: parts[0] }
    return { first: parts[0], last: parts.slice(1).join(" ") }
}

/**
 * Last resort when Luma has no name at all. "jane.smith@example.com" becomes
 * Jane / Smith - a guess, but a legible one, and far better than leaving
 * "jane.smith" in the Last Name column. Digits are dropped so "jsmith72"
 * does not become "Jsmith 72".
 */
function nameFromEmail(email: string): { first: string | null; last: string | null } {
    const local = email.split("@")[0] ?? ""
    const bits = local.split(/[._\-+]+/).filter((b) => b && !/^\d+$/.test(b))
    if (bits.length === 0) return { first: null, last: local }
    if (bits.length === 1) return { first: null, last: titleCase(bits[0]) }
    return { first: titleCase(bits[0]), last: bits.slice(1).map(titleCase).join(" ") }
}

function resolveName(d: any, email: string): { first: string | null; last: string | null } {
    const first = typeof d.user_first_name === "string" ? d.user_first_name.trim() : ""
    const last = typeof d.user_last_name === "string" ? d.user_last_name.trim() : ""
    if (first || last) return { first: first || null, last: last || first }

    // The field Luma actually populates most of the time.
    const full = typeof d.user_name === "string" ? d.user_name.trim() : ""
    if (full) return splitFullName(full)

    return nameFromEmail(email)
}

/**
 * The env var wins over the table. Returns where the secret came from so the
 * diagnostic log can say which one was actually used - a stale
 * LUMA_WEBHOOK_SECRET would silently shadow a correct integration_tokens row.
 */
async function storedSecret(): Promise<{ secret: string; source: "env" | "db" } | null> {
    const env = Deno.env.get("LUMA_WEBHOOK_SECRET")
    if (env) return { secret: env, source: "env" }
    const { data } = await db
        .from("integration_tokens")
        .select("refresh_token")
        .eq("provider", "luma")
        .maybeSingle()
    return data?.refresh_token ? { secret: data.refresh_token, source: "db" } : null
}

async function hmac(key: Uint8Array, payload: string): Promise<Uint8Array> {
    const k = await crypto.subtle.importKey(
        "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    )
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(payload)))
}

/**
 * DIAGNOSTIC (2026-10-04): a live registration logged "signature mismatch"
 * against a textbook whsec_ secret, so instead of one scheme this tries every
 * combination of key, payload and encoding below and logs which one matches.
 * Once a real delivery names the winner, collapse this back to that single
 * scheme and set LUMA_SIGNATURE_MODE=enforce.
 *
 * Logging never includes the secret or a full signature - only the secret's
 * source and length, and the first 12 characters of signatures on a miss.
 */
async function verifySignature(req: Request, raw: string): Promise<string> {
    const id = req.headers.get("webhook-id")
    const ts = req.headers.get("webhook-timestamp")
    const sigHeader = req.headers.get("webhook-signature")
    if (!id || !ts || !sigHeader) return "no signature headers"

    const stored = await storedSecret()
    if (!stored) return "no stored secret"
    const { secret, source } = stored

    // Rejecting stale deliveries is what makes replay attacks pointless.
    const age = Math.abs(Date.now() / 1000 - Number(ts))
    if (!Number.isFinite(age) || age > 300) return `stale timestamp (${Math.round(age)}s)`

    const afterPrefix = secret.startsWith("whsec_") ? secret.slice(6) : secret
    const keys: Array<[string, Uint8Array | null]> = [
        // Standard Webhooks: the part after whsec_ is base64 of the raw key bytes.
        ["b64-decoded", (() => {
            try { return Uint8Array.from(atob(afterPrefix), (c) => c.charCodeAt(0)) } catch { return null }
        })()],
        ["raw-after-prefix", new TextEncoder().encode(afterPrefix)],
        ["raw-whole", new TextEncoder().encode(secret)],
    ]
    const payloads: Array<[string, string]> = [
        ["id.ts.body", `${id}.${ts}.${raw}`],
        ["ts.body", `${ts}.${raw}`],
        ["body", raw],
    ]

    // Header is a space-separated list of "v1,<sig>" - more than one during a
    // secret rotation.
    const offered = sigHeader.split(" ").map((p) => p.split(",").pop() ?? "")
    const offeredLower = offered.map((s) => s.toLowerCase())

    const misses: string[] = []
    for (const [keyName, key] of keys) {
        if (!key) { misses.push(`key=${keyName} (not valid base64)`); continue }
        for (const [payloadName, payload] of payloads) {
            const mac = await hmac(key, payload)
            const encodings: Array<[string, string, string[]]> = [
                ["base64", btoa(String.fromCharCode(...mac)), offered],
                ["hex", Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join(""), offeredLower],
            ]
            for (const [encName, computed, against] of encodings) {
                const label = `key=${keyName} payload=${payloadName} enc=${encName}`
                if (against.includes(computed)) {
                    console.error(`[luma] signature MATCH ${label} (secret=${source} len=${secret.length})`)
                    return "ok"
                }
                misses.push(`${label}:${computed.slice(0, 12)}`)
            }
        }
    }

    console.error(
        `[luma] signature NO MATCH secret=${source} len=${secret.length} body_bytes=${new TextEncoder().encode(raw).length}` +
        ` offered=[${offered.map((s) => s.slice(0, 12)).join(" ")}] candidates=[${misses.join(" | ")}]`,
    )
    return "mismatch"
}

/**
 * Keyed on the guest id ALONE. Including the event type was the bug: the two
 * events Luma sends for one person got different keys and both went through.
 */
async function claim(key: string): Promise<boolean> {
    if (!SUPABASE_URL || !SERVICE_ROLE) return true
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_notification`, {
            method: "POST",
            headers: {
                apikey: SERVICE_ROLE,
                Authorization: `Bearer ${SERVICE_ROLE}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ p_key: key, p_window_seconds: 86400 }),
            signal: AbortSignal.timeout(4000),
        })
        if (!res.ok) return true
        return (await res.json()) !== false
    } catch {
        return true // fail open: Zoho's upsert is the second line of defence
    }
}

Deno.serve(async (req: Request) => {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 })

    const raw = await req.text()

    const sig = await verifySignature(req, raw)
    if (sig !== "ok") {
        console.error(`[luma] signature ${sig} (mode=${SIGNATURE_MODE})`)
        if (SIGNATURE_MODE === "enforce") return new Response("Forbidden", { status: 403 })
    } else {
        console.error("[luma] signature ok")
    }

    let body: any
    try { body = JSON.parse(raw) } catch { return new Response("Invalid JSON", { status: 400 }) }

    const type = String(body?.type ?? "")
    const d = body?.data ?? {}
    const email = String(d.user_email ?? "").trim().toLowerCase()

    if (!email || !email.includes("@")) {
        return new Response(JSON.stringify({ ok: true, skipped: "no email" }), { status: 200 })
    }

    if (!isBusinessEmail(email)) {
        console.error(`[luma] ${type} skipped free-domain ${email}`)
        return new Response(JSON.stringify({ ok: true, skipped: "free email domain" }), { status: 200 })
    }

    const refund = type === "guest.refunded"

    // A refund is a genuinely different fact about the same guest, so it gets
    // its own claim. Registration and ticket purchase share one.
    const claimKey = refund
        ? `luma:refund:${d.id ?? email}`
        : `luma:guest:${d.id ?? email}`

    if (!(await claim(claimKey))) {
        console.error(`[luma] ${type} deduped ${email}`)
        return new Response(JSON.stringify({ ok: true, duplicate: true }), { status: 200 })
    }

    const ev = d.event ?? {}
    const tickets: any[] = Array.isArray(d.event_tickets) ? d.event_tickets : []
    const orders: any[] = Array.isArray(d.event_ticket_orders) ? d.event_ticket_orders : []

    const paid = orders.map((o) => money(o.amount, o.currency)).filter(Boolean)
    const refunded = orders.map((o) => money(o.amount_refunded, o.currency)).filter(Boolean)

    let answers: string | null = null
    const ra = d.registration_answers
    if (Array.isArray(ra) && ra.length) {
        answers = ra
            .map((a: any) => `${a?.label ?? a?.question ?? "Q"}: ${a?.answer ?? a?.value ?? ""}`)
            .join("\n")
    }

    const { first, last } = resolveName(d, email)
    const guessedName = !d.user_first_name && !d.user_last_name && !d.user_name

    const detail = [
        `Event: ${ev.name ?? "unknown"}`,
        ev.start_at ? `Date: ${String(ev.start_at).slice(0, 10)}` : null,
        ev.url ? `Link: ${ev.url}` : null,
        tickets.length ? `Tickets: ${tickets.map((t) => t.name).filter(Boolean).join(", ")}` : null,
        paid.length ? `Paid: ${paid.join(", ")}` : null,
        refunded.length ? `Refunded: ${refunded.join(", ")}` : null,
        d.approval_status ? `Status: ${d.approval_status}` : null,
        d.utm_source ? `UTM source: ${d.utm_source}` : null,
        d.custom_source ? `Source: ${d.custom_source}` : null,
        // Flagged so nobody mistakes an inferred name for one the guest typed.
        guessedName ? "Name inferred from email address - Luma supplied none" : null,
        answers ? `\nRegistration answers:\n${answers}` : null,
    ].filter(Boolean).join("\n")

    try {
        const result = await upsertLead({
            email,
            firstName: first,
            lastName: last,
            company: null, // Luma has no company field
            phone: d.phone_number ?? null,
            source: SOURCE.lumaEvent,
            enquiryTypes: ["Events"],
            pageUrl: ev.url ?? null,
            noteTitle: refund
                ? `Luma refund - ${ev.name ?? "event"}`
                : `Luma registration - ${ev.name ?? "event"}`,
            message: detail,
            noCreate: refund,
        })

        console.error(`[luma] ${type} -> zoho ${result.action} ${"id" in result ? result.id : result.reason} (${email})`)
        return new Response(JSON.stringify({ ok: true, action: result.action }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })
    } catch (e) {
        console.error("[luma] zoho upsert threw", String(e))
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 })
    }
})
