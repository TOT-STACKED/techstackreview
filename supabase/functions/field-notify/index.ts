// Supabase Edge Function: field-notify
//
// Invoked by a database trigger on public.field_visits (Stacked Field, the
// agents' venue-visit app in approved-reporting) when a visit with a contact
// email is saved, or its tech or contact details change. Raises or updates a
// Zoho Lead (source "Field Tech Check") and leaves a note listing the tech
// the agent saw.
//
// Visits without a contact email are skipped: Zoho leads are matched on
// email (Chris's call, 31 Oct 2026). They still reach Slack and Airtable
// from approved-reporting.
//
// Required env vars: WEBHOOK_SECRET (as slack-notify), plus the Zoho ones in
// ../_shared/zoho.ts.
//
// Deploy with verify_jwt = false, like the other functions here.

// deno-lint-ignore-file
// @ts-nocheck — Deno edge runtime.
import { createClient } from "jsr:@supabase/supabase-js@2"
import { upsertLead, SOURCE } from "../_shared/zoho.ts"

const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET")
const VISIT_URL = "https://partners.wearestacked.io/field/visits/"

const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
)

/** Field categories, as the app labels them. Anything else is a review category key. */
const CATEGORY: Record<string, string> = {
    pos: "POS / till",
    payments: "Card terminals",
    ordering: "Order & pay at table",
    kiosk: "Self-order kiosks",
    kds: "Kitchen screens",
    handhelds: "Handheld ordering",
    reservations: "Bookings & waitlist",
    loyalty: "Loyalty & CRM",
    guest_wifi: "Guest Wi-Fi",
    guest_feedback: "Guest feedback",
    signage: "Digital menus & signage",
}

/** Only values already used on the Zoho Vertical picklist (see slack-notify). */
const VERTICAL: Record<string, string> = {
    restaurant: "Restaurants",
    pub: "Pubs and Bars",
    bar: "Pubs and Bars",
    nightclub: "Pubs and Bars",
    qsr: "QSR and Fast Casual",
    hotel: "Hotels",
    other: "Other",
}

const label = (key: string) =>
    CATEGORY[key] ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())

function techLines(stack: Record<string, any> | null): string[] {
    return Object.entries(stack ?? {}).map(([key, e]) => {
        const seen = e?.none
            ? "none seen"
            : [...(e?.tools ?? []), e?.other?.trim()].filter(Boolean).join(", ")
        return seen ? `${label(key)}: ${seen}` : null
    }).filter(Boolean) as string[]
}

async function agentName(id: string | null): Promise<string | null> {
    if (!id) return null
    const { data } = await db.from("field_agents").select("name, email").eq("id", id).maybeSingle()
    return data?.name || data?.email || null
}

Deno.serve(async (req) => {
    if (WEBHOOK_SECRET && req.headers.get("Authorization") !== `Bearer ${WEBHOOK_SECRET}`) {
        return new Response("unauthorized", { status: 401 })
    }
    const payload = await req.json().catch(() => ({}))
    const v = payload?.record
    if (!v?.id) return new Response("no record", { status: 400 })
    if (!v.contact_email) return Response.json({ skipped: "no contact email" })

    const [first, ...rest] = String(v.contact_name ?? "").trim().split(/\s+/).filter(Boolean)
    const day = String(v.visited_at ?? new Date().toISOString()).slice(0, 10)
    const tech = techLines(v.stack)
    const agent = await agentName(v.agent_id)
    const message = [
        `Field visit to ${v.venue_name} on ${day}${agent ? ` by ${agent}` : ""}`,
        [v.address, v.postcode].filter(Boolean).join(", ") || null,
        v.contact_role ? `Contact: ${v.contact_name ?? ""} (${v.contact_role})` : null,
        v.demo_interest ? `Interested in a demo: ${v.demo_interest}` : null,
        tech.length ? `\nTech seen:\n${tech.map((t) => `- ${t}`).join("\n")}` : "\nNo tech logged yet.",
        v.notes ? `\nNotes: ${v.notes}` : null,
        `\n${VISIT_URL}${v.id}`,
    ].filter(Boolean).join("\n")

    try {
        const result = await upsertLead({
            email: v.contact_email,
            firstName: first ?? null,
            lastName: rest.join(" ") || null,
            company: v.venue_name ?? null,
            phone: v.contact_phone ?? null,
            jobTitle: v.contact_role ?? null,
            source: SOURCE.intelligence,
            enquiryTypes: ["Tech"],
            vertical: VERTICAL[v.venue_type] ?? null,
            noteTitle: `Field visit - ${v.venue_name} - ${day}`,
            message,
        })
        console.error(`[zoho] field visit ${v.id} ${result.action} ${"id" in result ? result.id : result.reason}`)
        return Response.json(result)
    } catch (e) {
        console.error(`[zoho] field visit ${v.id} failed`, e)
        return new Response(String(e?.message ?? e), { status: 500 })
    }
})
