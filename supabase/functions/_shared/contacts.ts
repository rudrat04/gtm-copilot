import { sb } from "./db.ts";
import { autoSearch } from "./autosearch.ts";
import icp from "./icp.json" with { type: "json" };

// "Who do I contact?" for an account. Today, alerts and the morning email lead with a person, so every
// shown account needs one. Contacts come from the stored people search; a lookup is run automatically
// only for strong accounts and only a couple of times a day, to protect the free search credits.

export type Contact = {
  id: string;
  name: string;
  title: string;
  persona: string | null;
  email: string | null;
  email_status: string | null;
  revealed: boolean; // email enriched (revealed) by the owner
  pushed: boolean;   // already in HubSpot
  known: boolean;    // a HubSpot contact we did not add: someone may already be talking to them
  watched: boolean;  // the owner follows this person
  preview: boolean;  // listed for free, not revealed yet: no email until the owner spends a credit
  note: string | null; // why: "Already in your HubSpot..."
};

const maskEmail = (e: string | null) => (e ? `***@${e.split("@")[1]}` : null);

/** Best contact first, then the best one from a different persona, then the next best. */
export async function contactsFor(accountIds: string[], admin: boolean, limit = icp.contacts.perItem): Promise<Map<string, Contact[]>> {
  const out = new Map<string, Contact[]>();
  if (!accountIds.length) return out;
  const { data } = await sb.from("cp_people")
    .select("id,account_id,first_name,last_name,title,persona,email,email_status,relevance,email_confidence,email_revealed,hubspot_contact_id,hs_status,hs_note,watched_at,preview")
    .in("account_id", accountIds).gte("relevance", 50) // individual contributors are not the buyer
    .or("hs_status.is.null,hs_status.eq.known") // never suggest someone who opted out or whose address bounced
    .order("relevance", { ascending: false }).order("email_confidence", { ascending: false, nullsFirst: false });

  const by = new Map<string, NonNullable<typeof data>>();
  for (const p of data ?? []) (by.get(p.account_id) ?? by.set(p.account_id, []).get(p.account_id)!).push(p);

  for (const [id, all] of by) {
    // People nobody is already talking to come first; a known contact is still shown, marked, after them.
    const rows = [...all].sort((a, b) => Number(a.hs_status === "known") - Number(b.hs_status === "known"));
    const picked: typeof rows = [];
    if (rows[0]) picked.push(rows[0]);
    const other = rows.find((r) => r.persona !== rows[0].persona && !picked.includes(r));
    if (other) picked.push(other);
    for (const r of rows) if (picked.length < limit && !picked.includes(r)) picked.push(r);
    out.set(id, picked.slice(0, limit).map((p) => ({
      id: p.id,
      name: admin ? `${p.first_name} ${p.last_name}`.trim() : `${p.first_name} ${(p.last_name || "").charAt(0)}.`.trim(),
      title: p.title,
      persona: p.persona,
      email: admin ? p.email : maskEmail(p.email),
      email_status: p.email_status,
      revealed: !!p.email_revealed,
      pushed: !!p.hubspot_contact_id,
      known: p.hs_status === "known",
      watched: !!p.watched_at,
      preview: !!p.preview,
      note: p.hs_note ?? null,
    })));
  }
  return out;
}

/**
 * Finds people for a company that has none, under the owner's rules (see autosearch.ts): it must fit or be followed, a small
 * daily allowance, a reserve of credits left alone. Returns true when new people were stored.
 */
export async function autoFindContacts(a: { id: string; domain: string; priority_score?: number | null; watched?: boolean }): Promise<boolean> {
  const { count: existing } = await sb.from("cp_people").select("id", { count: "exact", head: true }).eq("account_id", a.id);
  if ((existing ?? 0) > 0) return false;
  return (await autoSearch(a)) === "found";
}
