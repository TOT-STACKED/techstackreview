/**
 * Shared Zoho CRM connector for Stacked.
 *
 * NOTE: this file is duplicated across contact-notify, slack-notify,
 * luma-notify and marketplace-notify. Supabase edge functions do not share
 * modules across deployments, so each carries its own copy and they WILL
 * drift - they already did once. The fix is to publish this to a versioned
 * URL and import it in all four.
 *
 * Lead creation goes through Zoho's /Leads/upsert with duplicate_check_fields
 * rather than search-then-create: the old approach raced and produced 24
 * duplicate pairs from Luma in a fortnight.
 *
 * Enquiry Type is whitelisted against the six valid picklist values. The
 * recruitment form was sending a person's name through and it landed in the
 * CRM as an enquiry type.
 */

import { createClient } from "jsr:@supabase/supabase-js@2"

const ACCOUNTS = "https://accounts.zoho.eu/oauth/v2/token"
const API = "https://www.zohoapis.eu/crm/v8"
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
    leadStatus?: string | null
    noteTitle?: string | null
    noCreate?: boolean
}

let cached: { token: string; expires: number } | null = null

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
    if (res.status === 401) { cached = null; res = await call(await accessToken()) }
    return res.status === 204 ? null : await res.json()
}

/** Score1 and URL_2 are Zoho's generated API names, not the labels. */
function mapFields(input: LeadInput): Record<string, unknown> {
    const f: Record<string, unknown> = {}
    if (input.phone) f.Phone = input.phone
    if (input.jobTitle) f.Designation = input.jobTitle

    const types = (input.enquiryTypes ?? []).filter((t) => ENQUIRY_TYPES.includes(t))
    const rejected = (input.enquiryTypes ?? []).filter((t) => !ENQUIRY_TYPES.includes(t))
    if (rejected.length) console.error(`[zoho] dropped invalid enquiry types: ${rejected.join(", ")}`)
    if (types.length) f.Enquiry_Type = types

    if (input.seniority) f.Seniority = input.seniority
    if (input.vertical) f.Vertical = [input.vertical]
    if (input.consent !== null && input.consent !== undefined) f.Marketing_Consent = input.consent
    if (input.pageUrl) f.Page_URL = input.pageUrl
    if (input.cvUrl) f.URL_2 = input.cvUrl
    if (input.annualUpside != null) f.Annual_Upside = input.annualUpside
    if (input.score != null) f.Score1 = Math.round(input.score)
    if (input.coveragePct != null) f.Coverage = Math.round(input.coveragePct)
    if (input.hoursSavedPerWeek != null) f.Hours_Saved_Per_Week = Math.round(input.hoursSavedPerWeek)
    return f
}

function names(input: LeadInput) {
    const first = input.firstName?.trim()
    const last = input.lastName?.trim()
    return {
        ...(first ? { First_Name: first } : {}),
        Last_Name: last || first || input.email.split("@")[0],
        Company: input.company?.trim() || "Not provided",
    }
}

async function nextOwner(): Promise<string | null> {
    const ids = (Deno.env.get("ZOHO_OWNER_IDS") ?? DEFAULT_OWNER_ID)
        .split(",").map((s) => s.trim()).filter(Boolean)
    if (ids.length === 0) return null
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

    // Already converted? Note it on the Contact rather than putting an
    // existing customer back into new business.
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
        if (!existing.Lead_Source) payload.Lead_Source = input.source
        if (input.leadStatus) payload.Lead_Status = input.leadStatus

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
            body: JSON.stringify({ data: [payload], $append_values: { Enquiry_Type: true } }),
        })
        await addNote(existing.id, "Leads", noteTitle, noteBody)
        return { action: "updated", id: existing.id }
    }

    if (input.noCreate) return { action: "skipped", reason: "no existing record, create suppressed" }

    const owner = await nextOwner()
    const res = await zoho("/Leads/upsert", {
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
            duplicate_check_fields: ["Email"],
            trigger: ["workflow"],
        }),
    })

    const row = res?.data?.[0]
    const id = row?.details?.id
    if (!id) throw new Error(`Zoho lead upsert failed: ${JSON.stringify(res)}`)
    if (input.noteTitle) await addNote(id, "Leads", noteTitle, noteBody)

    return { action: row?.action === "update" ? "updated" : "created", id }
}
