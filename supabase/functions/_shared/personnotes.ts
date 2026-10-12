import { sb } from "./db.ts";

// Notes and a short history for each person, and the suppression list: people who are never listed, revealed or added again.

export type NoteKind = "note" | "revealed" | "pushed" | "pinned" | "dismissed" | "contacted" | "buyer";

/** Adds a line to a person's history. Never throws. */
export async function addNote(personId: string, kind: NoteKind, text: string) {
  try { await sb.from("cp_person_notes").insert({ person_id: personId, kind, text: text.slice(0, 600) }); } catch { /* history is a convenience */ }
}
export async function listNotes(personId: string) {
  const { data } = await sb.from("cp_person_notes").select("id,kind,text,created_at").eq("person_id", personId).order("created_at", { ascending: false }).limit(30);
  return data ?? [];
}

/** Pure: the key a person is suppressed under: their email when known, else shortened name, website and title. */
export const suppressKey = (o: { email?: string | null; first?: string | null; last?: string | null; domain?: string | null; title?: string | null }) =>
  o.email ? o.email.toLowerCase() : `${(o.first ?? "").toLowerCase()} ${(o.last ?? "").trim().charAt(0).toLowerCase()}.|${(o.domain ?? "").toLowerCase()}|${(o.title ?? "").toLowerCase().slice(0, 60)}`;

export async function suppressedSet(): Promise<Set<string>> {
  const { data } = await sb.from("cp_suppressed").select("key").limit(5000);
  return new Set((data ?? []).map((r) => r.key));
}

/** Never contact this person: remembers them (by email, and by name and company), then deletes everything stored about them. */
export async function suppressPerson(personId: string, reason?: string): Promise<{ ok: boolean; label?: string }> {
  const { data: p } = await sb.from("cp_people").select("id,account_id,first_name,last_name,title,email").eq("id", personId).maybeSingle();
  if (!p) return { ok: false };
  const { data: a } = await sb.from("cp_accounts").select("domain").eq("id", p.account_id).maybeSingle();
  const label = `${p.first_name} ${p.last_name}`.trim() + (a?.domain ? ` at ${a.domain}` : "");
  const rows = [{ key: suppressKey({ first: p.first_name, last: p.last_name, domain: a?.domain, title: p.title }), label, reason: reason ?? null }];
  if (p.email) rows.push({ key: suppressKey({ email: p.email }), label, reason: reason ?? null });
  await sb.from("cp_suppressed").upsert(rows, { onConflict: "key", ignoreDuplicates: true });
  await sb.from("cp_people").delete().eq("id", personId); // notes and movements go with it
  return { ok: true, label };
}

/** Everything stored about one person, for the owner to download. */
export async function exportPerson(personId: string) {
  const { data: p } = await sb.from("cp_people").select("*").eq("id", personId).maybeSingle();
  if (!p) return null;
  const [{ data: notes }, { data: events }, { data: acct }] = await Promise.all([
    sb.from("cp_person_notes").select("kind,text,created_at").eq("person_id", personId),
    sb.from("cp_watch_events").select("kind,title,url,detected_at").eq("person_id", personId),
    sb.from("cp_accounts").select("name,domain").eq("id", p.account_id).maybeSingle(),
  ]);
  const { reveal_handle: _h, ...rest } = p;
  return { exported_at: new Date().toISOString(), company: acct, person: rest, notes, movements: events };
}
