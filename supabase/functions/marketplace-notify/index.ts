/**
 * marketplace-notify
 *
 * Receives a marketplace partner enquiry from the Airtable automation in the
 * TOT Website base (Forms table) and raises or updates a Zoho lead.
 *
 * All three tiers create a lead - Lite included. Someone already in the CRM
 * is merged into their existing lead by email.
 *
 * Secrets: MARKETPLACE_TOKEN, ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_OWNER_IDS
 */

import { upsertLead, SOURCE } from "../_shared/zoho.ts"

const TOKEN = Deno.env.get("MARKETPLACE_TOKEN") ?? ""

function clean(v: unknown): string {
    return typeof v === "string" ? v.trim() : ""
}

/**
 * The partner form packs its extra answers into one Comments blob rather than
 * separate columns: "Looking for", "Job role", "Sites", "Timeline",
 * "Partner package", "Page", then a Message section. Pulled apart here so Job
 * role can reach Designation and the rest reads sensibly on the note. Older
 * records are free text with none of these labels, which parses to an empty
 * map and falls through unharmed.
 */
function parseComments(raw: string): { fields: Record<string, string>; message: string } {
    const fields: Record<string, string> = {}
    let message = ""

    const messageAt = raw.search(/^\s*Message:\s*$/mi)
    const head = messageAt >= 0 ? raw.slice(0, messageAt) : raw
    if (messageAt >= 0) message = raw.slice(messageAt).replace(/^\s*Message:\s*/i, "").trim()

    for (const line of head.split("\n")) {
        const m = line.match(/^\s*([A-Za-z][A-Za-z ]{2,24}):\s*(.+?)\s*$/)
        if (m) fields[m[1].trim().toLowerCase()] = m[2].trim()
    }

    if (Object.keys(fields).length === 0 && !message) message = raw.trim()
    return { fields, message }
}

Deno.serve(async (req: Request) => {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 })

    if (TOKEN && req.headers.get("x-marketplace-token") !== TOKEN) {
        return new Response("Forbidden", { status: 403 })
    }

    let b: any
    try { b = await req.json() } catch { return new Response("Invalid JSON", { status: 400 }) }

    const email = clean(b.email).toLowerCase()
    if (!email || !email.includes("@")) {
        return new Response(JSON.stringify({ ok: true, skipped: "no email" }), { status: 200 })
    }

    const { fields, message } = parseComments(clean(b.comments))

    const partner = clean(b.partner)
    const tier = clean(b.tier) || fields["partner package"] || ""
    const page = clean(b.page) || fields["page"] || ""

    const detail = [
        partner ? `Partner: ${partner}` : null,
        tier ? `Partner package: ${tier}` : null,
        fields["looking for"] ? `Looking for: ${fields["looking for"]}` : null,
        fields["sites"] ? `Sites: ${fields["sites"]}` : null,
        fields["timeline"] ? `Timeline: ${fields["timeline"]}` : null,
        page ? `Page: ${page}` : null,
        message ? `\n${message}` : null,
    ].filter(Boolean).join("\n")

    try {
        const result = await upsertLead({
            email,
            firstName: clean(b.firstName) || null,
            lastName: clean(b.lastName) || null,
            company: clean(b.company) || null,
            phone: clean(b.phone) || null,
            jobTitle: fields["job role"] || null,
            source: SOURCE.marketplace,
            enquiryTypes: ["Tech"],
            pageUrl: page || null,
            noteTitle: `Marketplace enquiry${partner ? ` - ${partner}` : ""}`,
            message: detail,
        })

        console.error(`[marketplace] ${result.action} ${"id" in result ? result.id : result.reason} (${email}, partner=${partner || "?"}, tier=${tier || "?"})`)
        return new Response(JSON.stringify({ ok: true, action: result.action }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })
    } catch (e) {
        console.error("[marketplace] zoho upsert threw", String(e))
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 })
    }
})
