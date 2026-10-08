/**
 * Shared Zoho CRM connector for Stacked.
 *
 * Imported as "../_shared/zoho.ts" by contact-notify, slack-notify,
 * luma-notify and marketplace-notify, and bundled into each at deploy time.
 * Until 2026-10-04 each function carried its own copy and they drifted: only
 * marketplace-notify had the Contacts fix below, so the other three kept
 * losing enquiries. Keep it to this one copy.
 *
 * Zoho org is on the EU data centre - accounts.zoho.eu / www.zohoapis.eu.
 *
 * Secrets: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_OWNER_IDS (required,
 * comma-separated user ids). The refresh token lives in the integration_tokens
 * table, put there once by the zoho-bootstrap function. Zoho refresh tokens do
 * not expire unless the Self Client is revoked.
 *
 * 2026-10-04: the Contacts pre-check has been REMOVED. It existed to stop a
 * converted customer being resurrected as a new lead, on the assumption that
 * Contacts meant converted customers. It does not: the module holds a bulk
 * import of several thousand hospitality records loaded on 24 September, so
 * the check was silently turning real enquiries into notes on dormant records
 * nobody watches - a marketplace enquiry from Pizzarova was swallowed that
 * way. Every enquiry now creates or updates a Lead.
 *
 * Consequence, accepted deliberately: a genuine existing customer who
 * enquires will appear in the new-business pipeline as a lead.
 *
 * Lead creation goes through /Leads/upsert with duplicate_check_fields rather
 * than search-then-create: the old approach raced and produced 24 duplicate
 * pairs from Luma in a fortnight.
 *
 * Enquiry Type is whitelisted against the six valid picklist values. The
 * recruitment form was sending a person's name through.
 */

import { createClient } from "jsr:@supabase/supabase-js@2"

const ACCOUNTS = "https://accounts.zoho.eu/oauth/v2/token"
const API = "https://www.zohoapis.eu/crm/v8"

const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
)

/** Must match the Zoho picklist exactly, hyphen and all - not an en dash. */
export const SOURCE = {
    website: "Website",
    candidate: "Recruitment - Candidate",
    employer: "Recruitment - Employer",
    intelligence: "Field Tech Check",
    service: "SERVICE 2027",
    lumaEvent: "Luma Event",
    marketplace: "Marketplace Partner",
} as const

export type Source = (typeof SOURCE)[keyof typeof SOURCE]

/** The only values the Enquiry Type multiselect may hold. */
const ENQUIRY_TYPES = ["Tech", "Tech Support", "Recruitment", "Events", "Podcast", "Other"]

export interface LeadInput {
    email: string
    firstName?: string | null
    lastName?: string | null
    company?: string | null
    phone?: string | null
    jobTitle?: string | null
    source: Source
    enquiryTypes?: string[] | null
    seniority?: string | null
    vertical?: string | null
    consent?: boolean | null
    pageUrl?: string | null
    message?: string | null
    cvUrl?: string | null
    annualUpside?: number | null
    score?: number | null
    coveragePct?: number | null
    hoursSavedPerWeek?: number | null
    /**
     * Overrides the default MAL on create, and is applied on update too.
     * Used by the deep review, which is by definition sales-qualified.
     */
    leadStatus?: string | null
    /** Title for the note this enquiry leaves on the record. */
    noteTitle?: string | null
    /** Update an existing lead but never create one (e.g. a Luma refund). */
    noCreate?: boolean
}

let cached: { token: string; expires: number } | null = null

/**
 * Zoho occasionally sits on a request past our timeout ("Signal timed out."),
 * which used to fail the whole sync and lose the lead (first seen
 * 2026-10-08). One retry after a short pause. Only for calls that are safe to
 * repeat: search, PUT and /Leads/upsert all are; POST /Notes is not, since a
 * late success plus a retry would leave the note twice.
 */
async function withTimeoutRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn()
    } catch (e) {
        if (!(e instanceof DOMException && e.name === "TimeoutError")) throw e
        console.error("[zoho] request timed out, retrying once")
        await new Promise((r) => setTimeout(r, 1000))
        return await fn()
    }
}

async function refreshToken(): Promise<string> {
    const { data } = await db
        .from("integration_tokens").select("refresh_token")
        .eq("provider", "zoho").maybeSingle()
    if (!data?.refresh_token) {
        throw new Error("No Zoho refresh token stored. Run zoho-bootstrap with a fresh grant code.")
    }
    return data.refresh_token
}

async function accessToken(): Promise<string> {
    if (cached && cached.expires > Date.now()) return cached.token
    const refresh = await refreshToken()
    const res = await withTimeoutRetry(() => fetch(ACCOUNTS, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: Deno.env.get("ZOHO_CLIENT_ID")!,
            client_secret: Deno.env.get("ZOHO_CLIENT_SECRET")!,
            refresh_token: refresh,
        }),
        signal: AbortSignal.timeout(8000),
    }))
    const json = await res.json()
    if (!json.access_token) throw new Error(`Zoho token refresh failed: ${JSON.stringify(json)}`)
    // Five minutes of headroom so a token never dies mid-request.
    cached = { token: json.access_token, expires: Date.now() + (json.expires_in - 300) * 1000 }
    return cached.token
}

async function zoho(path: string, init: RequestInit = {}, retry = true): Promise<any> {
    const once = (token: string) =>
        fetch(`${API}${path}`, {
            ...init,
            headers: {
                ...(init.headers ?? {}),
                Authorization: `Zoho-oauthtoken ${token}`,
                "Content-Type": "application/json",
            },
            signal: AbortSignal.timeout(10000),
        })
    const call = (token: string) => retry ? withTimeoutRetry(() => once(token)) : once(token)

    let res = await call(await accessToken())
    // A 401 means the cached token died early. Drop it and try once more.
    if (res.status === 401) { cached = null; res = await call(await accessToken()) }
    // 204 on a search means no match, which is a normal answer here.
    return res.status === 204 ? null : await res.json()
}

/**
 * Left side is Zoho's API name as it was actually created, which is not
 * always the label. Score1 and URL_2 are Zoho's doing: "Score" collided with
 * the stock Visitor_Score field, and the CV Link field was left named "URL 2".
 * Renaming the labels later will not change these.
 */
function mapFields(input: LeadInput): Record<string, unknown> {
    const f: Record<string, unknown> = {}
    if (input.phone) f.Phone = input.phone
    if (input.jobTitle) f.Designation = input.jobTitle

    // Anything off the picklist is dropped rather than written. A form sending
    // free text must not be able to put rubbish in a picklist.
    const types = (input.enquiryTypes ?? []).filter((t) => ENQUIRY_TYPES.includes(t))
    const rejected = (input.enquiryTypes ?? []).filter((t) => !ENQUIRY_TYPES.includes(t))
    if (rejected.length) console.error(`[zoho] dropped invalid enquiry types: ${rejected.join(", ")}`)
    if (types.length) f.Enquiry_Type = types

    if (input.seniority) f.Seniority = input.seniority
    if (input.vertical) f.Vertical = [input.vertical] // multiselect, wants an array
    if (input.consent !== null && input.consent !== undefined) f.Marketing_Consent = input.consent
    if (input.pageUrl) f.Page_URL = input.pageUrl
    if (input.cvUrl) f.URL_2 = input.cvUrl
    if (input.annualUpside != null) f.Annual_Upside = input.annualUpside
    if (input.score != null) f.Score1 = Math.round(input.score)
    if (input.coveragePct != null) f.Coverage = Math.round(input.coveragePct) // 83 means 83%
    if (input.hoursSavedPerWeek != null) f.Hours_Saved_Per_Week = Math.round(input.hoursSavedPerWeek)
    return f
}

/** Zoho rejects a Lead with no Last Name and treats Company as near-mandatory. */
function names(input: LeadInput) {
    const first = input.firstName?.trim()
    const last = input.lastName?.trim()
    return {
        ...(first ? { First_Name: first } : {}),
        Last_Name: last || first || input.email.split("@")[0],
        Company: input.company?.trim() || "Not provided",
    }
}

/**
 * Round-robin across ZOHO_OWNER_IDS. Cursor survives cold starts. There is no
 * hardcoded fallback: an unset secret fails the create loudly rather than
 * quietly assigning leads to whoever the code last named.
 */
async function nextOwner(): Promise<string> {
    const ids = (Deno.env.get("ZOHO_OWNER_IDS") ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean)
    if (ids.length === 0) throw new Error("ZOHO_OWNER_IDS is not set - cannot assign a lead owner.")
    if (ids.length === 1) return ids[0]

    const { data } = await db
        .from("integration_tokens").select("owner_cursor")
        .eq("provider", "zoho").maybeSingle()
    const cursor = (data?.owner_cursor ?? 0) % ids.length
    await db.from("integration_tokens").update({ owner_cursor: cursor + 1 }).eq("provider", "zoho")
    return ids[cursor]
}

async function addNote(parentId: string, module: string, title: string, body: string) {
    await zoho("/Notes", {
        method: "POST",
        body: JSON.stringify({
            data: [{
                Note_Title: title.slice(0, 120),
                Note_Content: body.slice(0, 32000),
                Parent_Id: { id: parentId },
                se_module: module,
            }],
        }),
    }, false) // not idempotent - see withTimeoutRetry

}

export type UpsertResult =
    | { action: "created"; id: string }
    | { action: "updated"; id: string }
    | { action: "skipped"; reason: string }

export async function upsertLead(input: LeadInput): Promise<UpsertResult> {
    const email = input.email?.trim().toLowerCase()
    if (!email || !email.includes("@")) return { action: "skipped", reason: "no usable email" }

    const day = new Date().toISOString().slice(0, 10)
    const noteTitle = input.noteTitle ?? `${input.source} enquiry - ${day}`
    const noteBody = [
        `Source: ${input.source}`,
        input.enquiryTypes?.length ? `Enquiry type: ${input.enquiryTypes.join(", ")}` : null,
        input.pageUrl ? `Page: ${input.pageUrl}` : null,
        input.score != null ? `Score: ${input.score}/100` : null,
        input.coveragePct != null ? `Coverage: ${input.coveragePct}%` : null,
        input.annualUpside != null ? `Annual upside: GBP ${input.annualUpside}` : null,
        input.hoursSavedPerWeek != null ? `Hours back per week: ${input.hoursSavedPerWeek}` : null,
        input.message ? `\n${input.message}` : null,
    ].filter(Boolean).join("\n")

    // No Contacts pre-check - see the header. Every enquiry becomes a Lead.
    const leadHit = await zoho(`/Leads/search?email=${encodeURIComponent(email)}`)
    const existing = leadHit?.data?.[0]

    if (existing) {
        const payload: Record<string, unknown> = { id: existing.id, ...mapFields(input) }

        // First-touch attribution: never overwrite how they originally arrived.
        if (!existing.Lead_Source) payload.Lead_Source = input.source

        // A deep review qualifies the lead, so its status is allowed to move a
        // record forward. Nothing else sets this on update.
        if (input.leadStatus) payload.Lead_Status = input.leadStatus

        // Fill in a company only if we are improving on nothing.
        const n = names(input)
        if (!existing.Company || existing.Company === "Not provided") {
            if (n.Company !== "Not provided") payload.Company = n.Company
        }
        // Repair a placeholder surname if we now have something better.
        const localPart = email.split("@")[0]
        if (existing.Last_Name === localPart && n.Last_Name !== localPart) {
            payload.Last_Name = n.Last_Name
            if (n.First_Name) payload.First_Name = n.First_Name
        }

        await zoho("/Leads", {
            method: "PUT",
            // Keeps existing multiselect picks instead of replacing them, so a
            // second enquiry about Events does not erase the first about Tech.
            body: JSON.stringify({ data: [payload], $append_values: { Enquiry_Type: true } }),
        })
        await addNote(existing.id, "Leads", noteTitle, noteBody)
        return { action: "updated", id: existing.id }
    }

    // A refund for somebody who was never a lead is not a reason to make one.
    if (input.noCreate) return { action: "skipped", reason: "no existing record, create suppressed" }

    const owner = await nextOwner()

    // /Leads/upsert rather than /Leads: Zoho matches on Email server-side and
    // atomically, so two concurrent requests cannot both insert.
    const res = await zoho("/Leads/upsert", {
        method: "POST",
        body: JSON.stringify({
            data: [{
                ...names(input),
                Email: email,
                Lead_Source: input.source,
                Lead_Status: input.leadStatus ?? "MAL",
                Owner: { id: owner },
                ...mapFields(input),
                ...(input.message ? { Description: input.message.slice(0, 32000) } : {}),
            }],
            duplicate_check_fields: ["Email"],
            trigger: ["workflow"],
        }),
    })

    const row = res?.data?.[0]
    const id = row?.details?.id
    if (!id) throw new Error(`Zoho lead upsert failed: ${JSON.stringify(res)}`)

    // A deep review arriving before any stage-1 lead still deserves its detail
    // on the record, not just in the Description.
    if (input.noteTitle) await addNote(id, "Leads", noteTitle, noteBody)

    // Zoho reports whether it inserted or matched - the only honest way to
    // know a race was caught.
    return { action: row?.action === "update" ? "updated" : "created", id }
}
