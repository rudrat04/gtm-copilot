import { sb } from "./db.ts";
import { log } from "./log.ts";
import { searchAndStore } from "./people.ts";
import { tierOf } from "./score.ts";
import { fitBreakdown } from "./firmo.ts";
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
};

const maskEmail = (e: string | null) => (e ? `***@${e.split("@")[1]}` : null);

/** Best contact first, then the best one from a different persona, then the next best. */
export async function contactsFor(accountIds: string[], admin: boolean, limit = icp.contacts.perItem): Promise<Map<string, Contact[]>> {
  const out = new Map<string, Contact[]>();
  if (!accountIds.length) return out;
  const { data } = await sb.from("cp_people")
    .select("id,account_id,first_name,last_name,title,persona,email,email_status,relevance,email_confidence,email_revealed,hubspot_contact_id")
    .in("account_id", accountIds).gte("relevance", 50) // individual contributors are not the buyer
    .order("relevance", { ascending: false }).order("email_confidence", { ascending: false, nullsFirst: false });

  const by = new Map<string, NonNullable<typeof data>>();
  for (const p of data ?? []) (by.get(p.account_id) ?? by.set(p.account_id, []).get(p.account_id)!).push(p);

  for (const [id, rows] of by) {
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
    })));
  }
  return out;
}

/**
 * Finds people for a strong account that has never been searched. Skips weak accounts, accounts already
 * searched, and anything past the daily limit. Returns true when new people were stored.
 */
export async function autoFindContacts(a: { id: string; domain: string; priority_score: number | null }): Promise<boolean> {
  if (tierOf(a.priority_score) === "tier_3") return false;
  // Do not spend a search credit on a company that clearly misses the target size or stage.
  const { data: firm } = await sb.from("cp_accounts").select("employees,stage,country,firmo_at").eq("id", a.id).maybeSingle();
  if (firm) {
    const f = fitBreakdown(firm);
    if (f.known && (f.size === 0 || f.stage === 0)) {
      await log("info", "auto_contact_skipped", { account: a.domain, message: "Outside the target size or stage" });
      return false;
    }
  }
  const { count: existing } = await sb.from("cp_people").select("id", { count: "exact", head: true }).eq("account_id", a.id);
  if ((existing ?? 0) > 0) return false;

  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const { count: today } = await sb.from("cp_provider_usage").select("id", { count: "exact", head: true })
    .eq("provider", "hunter").eq("action", "domain_search").gte("created_at", dayStart.toISOString());
  if ((today ?? 0) >= icp.contacts.autoPerDay) {
    await log("info", "auto_contact_skipped", { account: a.domain, message: "Daily automatic lookup limit reached" });
    return false;
  }
  try {
    const r = await searchAndStore({ id: a.id, domain: a.domain });
    await log("info", "auto_contact_lookup", { account: a.domain, detail: { stored: r.stored, credits: r.credits } });
    return r.stored > 0;
  } catch (e) {
    await log("warn", "auto_contact_failed", { account: a.domain, message: (e as Error).message });
    return false;
  }
}
