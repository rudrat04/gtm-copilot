import { sb } from "./db.ts";
import { log } from "./log.ts";
import { type HsContact, lookupContactsByEmail } from "./hubspot.ts";

// "Already known" guard. Before anyone is suggested as a contact, check HubSpot: a person who opted out or whose address bounces is
// never suggested, and a person who already exists there (not added by us) is marked so you do not cold-contact someone a colleague
// is already talking to. Read-only on HubSpot; nothing is sent.

export type GuardStatus = "known" | "opted_out" | "bounced";

/** Pure: what a HubSpot match means for one person. `ours` is true when we pushed this contact ourselves. */
export function guardStatus(c: HsContact | undefined, ours: boolean): { status: GuardStatus | null; note: string | null } {
  if (!c) return { status: null, note: null };
  if (c.optedOut) return { status: "opted_out", note: "Opted out of email in HubSpot" };
  if (c.bounced) return { status: "bounced", note: "Their address bounced before (HubSpot)" };
  if (ours) return { status: null, note: null };
  const when = c.lastContacted ? ` Last contacted ${new Date(c.lastContacted).toISOString().slice(0, 10)}.` : "";
  return { status: "known", note: `Already in your HubSpot.${when} Check before reaching out.` };
}

/** Checks people that have not been checked yet (one account, or up to `limit` overall). Never throws: HubSpot trouble is logged. */
export async function guardPeople(opts: { accountId?: string; limit?: number } = {}): Promise<{ checked: number; known: number; opted_out: number; bounced: number }> {
  const out = { checked: 0, known: 0, opted_out: 0, bounced: 0 };
  if (!Deno.env.get("HUBSPOT_TOKEN")) return out;
  try {
    let q = sb.from("cp_people").select("id,email,hubspot_contact_id").is("hs_checked_at", null).not("email", "is", null).limit(opts.limit ?? 100);
    if (opts.accountId) q = q.eq("account_id", opts.accountId);
    const { data: rows } = await q;
    if (!rows?.length) return out;
    const found = await lookupContactsByEmail(rows.map((r) => r.email!));
    const now = new Date().toISOString();
    for (const r of rows) {
      const { status, note } = guardStatus(found.get(r.email!.toLowerCase()), !!r.hubspot_contact_id);
      await sb.from("cp_people").update({ hs_status: status, hs_note: note, hs_checked_at: now }).eq("id", r.id);
      out.checked++;
      if (status) out[status]++;
    }
    await log("info", "people_guarded", { detail: out });
  } catch (e) {
    await log("warn", "people_guard_failed", { message: (e as Error).message });
  }
  return out;
}
