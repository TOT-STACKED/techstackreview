/**
 * Shared Zoho CRM connector for Stacked.
 *
 * Called by contact-notify and slack-notify. Handles OAuth refresh,
 * upsert-by-email, first-touch Lead Source, and appending a note when a known
 * person enquires again.
 *
 * Zoho org is on the EU data centre - accounts.zoho.eu / www.zohoapis.eu.
 *
 * Secrets: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, optionally ZOHO_OWNER_IDS.
 * The refresh token lives in the integration_tokens table, put there once by
 * the zoho-bootstrap function. Zoho refresh tokens do not expire unless the
 * Self Client is revoked.
 */

import { createClient } from "jsr:@supabase/supabase-js@2"

const ACCOUNTS = "https://accounts.zoho.eu/oauth/v2/token"
const API = "https://www.zohoapis.eu/crm/v8"

/**
 * Default lead owner. Set ZOHO_OWNER_IDS to "id1,id2" to round-robin across
 * several owners - no redeploy needed, the env var wins over this.
 */
const DEFAULT_OWNER_ID = "" // redacted from the public repo - set ZOHO_OWNER_IDS

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
} as const

export type Source = (typeof SOURCE)[keyof typeof SOURCE]

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
}

let cached: { token: string; expires: number } | null = null

async function refreshToken(): Promise<string> {
    const { data } = await db
        .from("integration_tokens")
        .select("refresh_token")
        .eq("provider", "zoho")
        .maybeSingle()

    if (!data?.refresh_token) {
        throw new Error("No Zoho refresh token stored. Run zoho-bootstrap with a fresh grant code.")
    }
    return data.refresh_token
}

async function accessToken(): Promise<string> {
    if (cached && cached.expires > Date.now()) return cached.token

    const refresh = await refreshToken()
    const res = await fetch(ACCOUNTS, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: Deno.env.get("ZOHO_CLIENT_ID")!,
            client_secret: Deno.env.get("ZOHO_CLIENT_SECRET")!,
            refresh_token: refresh,
        }),
        signal: AbortSignal.timeout(8000),
    })

    const json = await res.json()
    if (!json.access_token) throw new Error(`Zoho token refresh failed: ${JSON.stringify(json)}`)

    // Five minutes of headroom so a token never dies mid-request.
    cached = { token: json.access_token, expires: Date.now() + (json.expires_in - 300) * 1000 }
    return cached.token
}

async function zoho(path: string, init: RequestInit = {}): Promise<any> {
    const call = async (token: string) =>
        await fetch(`${API}${path}`, {
            ...init,
            headers: {
                ...(init.headers ?? {}),
                Authorization: `Zoho-oauthtoken ${token}`,
                "Content-Type": "application/json",
            },
            signal: AbortSignal.timeout(10000),
        })

    let res = await call(await accessToken())

    // A 401 means the cached token died early. Drop it and try once more.
    if (res.status === 401) {
        cached = null
        res = await call(await accessToken())
    }

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
    if (input.enquiryTypes?.length) f.Enquiry_Type = input.enquiryTypes
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

/** Round-robin across the configured owners. Cursor survives cold starts. */
async function nextOwner(): Promise<string | null> {
    const ids = (Deno.env.get("ZOHO_OWNER_IDS") ?? DEFAULT_OWNER_ID)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)

    if (ids.length === 0) return null
    if (ids.length === 1) return ids[0]

    const { data } = await db
        .from("integration_tokens")
        .select("owner_cursor")
        .eq("provider", "zoho")
        .maybeSingle()

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
    })
}

export type UpsertResult =
    | { action: "created"; id: string }
    | { action: "updated"; id: string }
    | { action: "noted_on_contact"; id: string }
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

    // Already converted? Note it on the Contact rather than resurrecting them
    // as a Lead, which would put an existing customer back in the new-business
    // pipeline.
    const contactHit = await zoho(`/Contacts/search?email=${encodeURIComponent(email)}`)
    const contact = contactHit?.data?.[0]
    if (contact) {
        await addNote(contact.id, "Contacts", noteTitle, noteBody)
        return { action: "noted_on_contact", id: contact.id }
    }

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
        if (!existing.Company || existing.Company === "Not provided") {
            const n = names(input)
            if (n.Company !== "Not provided") payload.Company = n.Company
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

    const owner = await nextOwner()
    const created = await zoho("/Leads", {
        method: "POST",
        body: JSON.stringify({
            data: [{
                ...names(input),
                Email: email,
                Lead_Source: input.source,
                Lead_Status: input.leadStatus ?? "MAL",
                ...(owner ? { Owner: { id: owner } } : {}),
                ...mapFields(input),
                ...(input.message ? { Description: input.message.slice(0, 32000) } : {}),
            }],
            trigger: ["workflow"],
        }),
    })

    const id = created?.data?.[0]?.details?.id
    if (!id) throw new Error(`Zoho lead create failed: ${JSON.stringify(created)}`)

    // A deep review arriving before any stage-1 lead still deserves its detail
    // on the record, not just in the Description.
    if (input.noteTitle) await addNote(id, "Leads", noteTitle, noteBody)

    return { action: "created", id }
}
