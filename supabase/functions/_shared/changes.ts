import { sb } from "./db.ts";
import { worthShowing } from "./fitgate.ts";
import { FIT_COLS } from "./firmo.ts";
import { searchStates } from "./autosearch.ts";

// "What changed since yesterday" for the morning email: new signals, new people, replies and new leads, plus the alerts that were
// held back (no fit and nobody to contact) and the companies waiting for a contact. Read-only, no credits.

export type Changes = {
  signals: { name: string; title: string; more: number }[];
  people: { name: string; who: string }[];
  moves: string[];
  held: { name: string; title: string }[];
  waiting: { name: string; state: "none" | "searched" | "never" }[];
};
export const emptyChanges = (): Changes => ({ signals: [], people: [], moves: [], held: [], waiting: [] });
export const hasChanges = (c: Changes) => !!(c.signals.length || c.people.length || c.moves.length || c.held.length);

const MOVE_LABEL: Record<string, string> = { replied: "replied", meeting: "booked a meeting", debrief_went_well: "had a meeting that went well", debrief_follow_up: "needs a follow-up after a meeting" };

/** One line per change, ready for the plain-text email. The HTML email uses the same strings. */
export function changeLines(c: Changes): string[] {
  const out: string[] = [];
  for (const s of c.signals) out.push(`New signal: ${s.name}, ${s.title.slice(0, 90)}${s.more ? ` (+${s.more} more)` : ""}`);
  for (const p of c.people) out.push(`New people found: ${p.name}, ${p.who}`);
  for (const m of c.moves) out.push(m);
  for (const h of c.held) out.push(`Held back (no fit, nobody to contact): ${h.name}, ${h.title.slice(0, 80)}`);
  return out;
}

export async function changesSince(sinceIso: string, needs: { id: string; name: string }[] = []): Promise<Changes> {
  const c = emptyChanges();
  const { data: accts } = await sb.from("cp_accounts").select(`id,name,priority_score,${FIT_COLS}`).is("removed_at", null).limit(500);
  const byId = new Map((accts ?? []).map((a) => [a.id, a]));
  const shown = (id: string) => { const a = byId.get(id); return !!a && (!!a.watched_at || worthShowing(a)); };

  const { data: sigs } = await sb.from("cp_signals").select("account_id,kind,title,detail,detected_at").gt("detected_at", sinceIso).order("detected_at", { ascending: false }).limit(300);
  const real = (sigs ?? []).filter((s) => shown(s.account_id) && (s.kind === "news" || s.kind === "tech" || (s.kind === "hiring" && !(s.detail && "salesOpenings" in s.detail))));
  const per = new Map<string, typeof real>();
  for (const s of real) (per.get(s.account_id) ?? per.set(s.account_id, []).get(s.account_id)!).push(s);
  c.signals = [...per.entries()].sort((a, b) => (byId.get(b[0])!.priority_score ?? 0) - (byId.get(a[0])!.priority_score ?? 0)).slice(0, 6)
    .map(([id, list]) => ({ name: byId.get(id)!.name, title: list[0].title, more: list.length - 1 }));

  const { data: ppl } = await sb.from("cp_people").select("account_id,first_name,last_name,title,relevance,hs_status").gt("created_at", sinceIso).gte("relevance", 50).order("relevance", { ascending: false }).limit(60);
  const pp = new Map<string, string[]>();
  for (const p of ppl ?? []) {
    if (!byId.has(p.account_id) || p.hs_status === "opted_out" || p.hs_status === "bounced") continue;
    const l = pp.get(p.account_id) ?? pp.set(p.account_id, []).get(p.account_id)!;
    if (l.length < 2) l.push(`${p.first_name} ${p.last_name} (${p.title})`.replace("  ", " "));
  }
  c.people = [...pp.entries()].slice(0, 5).map(([id, who]) => ({ name: byId.get(id)!.name, who: who.join(", ") }));

  const { data: oc } = await sb.from("cp_outcomes").select("account_id,kind").gt("created_at", sinceIso).in("kind", Object.keys(MOVE_LABEL)).limit(20);
  for (const o of oc ?? []) if (byId.has(o.account_id)) c.moves.push(`${byId.get(o.account_id)!.name} ${MOVE_LABEL[o.kind]}`);
  const { data: leads } = await sb.from("cp_leads").select("name,company,label").gt("created_at", sinceIso).limit(5);
  for (const l of leads ?? []) c.moves.push(`New inbound lead: ${(l.name ?? "").split(" ")[0]}${l.company ? ` (${l.company})` : ""}${l.label ? `, ${l.label}` : ""}`);

  const { data: held } = await sb.from("cp_alerts").select("account_id,signal_hash").eq("deferred", true).gt("sent_at", sinceIso).limit(10);
  for (const h of held ?? []) {
    const s = (sigs ?? []).find((x) => x.account_id === h.account_id);
    if (byId.has(h.account_id)) c.held.push({ name: byId.get(h.account_id)!.name, title: s?.title ?? "a new signal" });
  }

  const states = await searchStates(needs.map((n) => n.id));
  c.waiting = needs.map((n) => ({ name: n.name, state: states.get(n.id) ?? "never" }));
  return c;
}
