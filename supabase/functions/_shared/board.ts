import { sb } from "./db.ts";
import { buildToday, type TodayItem } from "./today.ts";
import { peopleRows } from "./peoplerows.ts";
import { contactsFor } from "./contacts.ts";
import { tierOf } from "./score.ts";
import icp from "./icp.json" with { type: "json" };

// The To-do board: people to act on, in lanes by how soon. It is built from the same rules as the old Today list (follow-ups,
// meetings, fresh signals, revivals), then each item is given the person to contact as a full person row, people you pinned are added,
// people you dismissed are left out, and people you follow come up when something just happened to them.

export type Lane = "now" | "week" | "waiting" | "later";
type Person = Awaited<ReturnType<typeof peopleRows>>[number];
export type BoardItem = Omit<TodayItem, "type"> & { type: TodayItem["type"] | "pinned" | "watch" | "waiting"; lane: Lane; priority: number; person: Person | null; alt: Person | null; why_line: { label: string; text: string; url?: string | null } | null };

/** Things with a date or a reason of their own are never held back; only new outreach (fresh signals on companies that are Ready) counts toward the daily cap. */
const DATED = new Set(["meeting", "follow_up", "pinned", "waiting", "revive", "watch"]);
/** Pure: keeps today to `cap` new people to contact. The best by priority stay in Contact now or This week; the rest move to Worth a look. Returns how many moved. */
export function applyDailyCap<T extends { type: string; lane: Lane; priority: number }>(items: T[], cap: number): number {
  const fresh = items.filter((i) => !DATED.has(i.type) && (i.lane === "now" || i.lane === "week")).sort((a, b) => b.priority - a.priority);
  const over = fresh.slice(Math.max(0, cap));
  for (const i of over) i.lane = "later";
  return over.length;
}

/** Pure: which lane an item belongs in. Things with a date (a meeting, a due follow-up, a pinned person) are now; the rest by priority. */
export function laneOf(i: { type: string; priority: number }): Lane {
  if (i.type === "waiting") return "waiting";
  if (["meeting", "follow_up", "pinned"].includes(i.type)) return "now";
  return i.priority >= 70 ? "now" : i.priority >= 45 ? "week" : "later";
}

/** Pure: the first reason to give: what the person is doing, then what their team is doing, then the company's reason. */
export function whyLine(p: { activity: { kind: string; title: string; url: string | null; at: string }[]; team: string[] } | null, fallback: string): { label: string; text: string; url?: string | null } {
  const fresh = p?.activity.find((a) => Date.now() - Date.parse(a.at) < 21 * 86_400_000);
  if (fresh) return { label: fresh.kind === "team" ? "Their team" : "Their activity", text: fresh.title, url: fresh.url };
  if (p?.team[0]) return { label: "Their team", text: p.team[0] };
  return { label: "Why now", text: fallback };
}

/** Why a strong company has nobody to contact: nobody listed yet, people listed who are not your buyer types, or a search that found nobody. */
async function needsState(needs: { id: string; name: string; tier: string; priority: number | null; reason: string }[]) {
  if (!needs.length) return [];
  const ids = needs.map((n) => n.id);
  const [{ data: ppl }, { data: acc }] = await Promise.all([
    sb.from("cp_people").select("account_id").in("account_id", ids),
    sb.from("cp_accounts").select("id,people_previewed_at,people_searched_at").in("id", ids),
  ]);
  const n = new Map<string, number>();
  for (const p of ppl ?? []) n.set(p.account_id, (n.get(p.account_id) ?? 0) + 1);
  const looked = new Map((acc ?? []).map((a) => [a.id, !!(a.people_previewed_at || a.people_searched_at)]));
  return needs.map((x) => ({ ...x, people: n.get(x.id) ?? 0, state: (n.get(x.id) ?? 0) > 0 ? "no_match" : looked.get(x.id) ? "nobody" : "unlisted" }));
}

export async function buildBoard(admin: boolean) {
  const t = await buildToday(admin, { cap: 40 });
  const items = t.items as TodayItem[];
  const { data: states } = await sb.from("cp_people").select("id,account_id,todo_state").not("todo_state", "is", null);
  const pinned = (states ?? []).filter((s) => s.todo_state === "pinned").map((s) => s.id);
  const dismissed = new Set((states ?? []).filter((s) => s.todo_state === "dismissed").map((s) => s.id));
  // Followed people something just happened to.
  const { data: ev } = await sb.from("cp_watch_events").select("person_id").not("person_id", "is", null).in("kind", ["activity", "team", "job_change", "mention"]).gt("detected_at", new Date(Date.now() - 7 * 86_400_000).toISOString());
  const eventPeople = [...new Set((ev ?? []).map((e) => e.person_id as string))];
  // Waiting for a reply: contacted or replied, not due yet.
  const { data: waitA } = await sb.from("cp_accounts").select("id,name,domain,priority_score,outreach_status,next_followup_at,touches,contacted_at").is("removed_at", null).in("outreach_status", ["contacted", "replied"]).order("last_touch_at", { ascending: false }).limit(12);
  const dueIds = new Set(items.filter((i) => i.type === "follow_up").map((i) => i.account?.id));
  const waiting = (waitA ?? []).filter((a) => !dueIds.has(a.id) && !(a.next_followup_at && Date.parse(a.next_followup_at) <= Date.now()));
  const wmap = await contactsFor(waiting.map((a) => a.id), admin, 1);

  const wantIds = new Set<string>([...pinned, ...eventPeople]);
  for (const i of items) for (const c of (i.contacts ?? []).slice(0, 2)) wantIds.add(c.id);
  for (const a of waiting) for (const c of wmap.get(a.id) ?? []) wantIds.add(c.id);
  const rows = await peopleRows(admin, { personIds: [...wantIds] });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const out: BoardItem[] = [];
  const shownPeople = new Set<string>();
  for (const i of items) {
    const contacts = (i.contacts ?? []).filter((c) => !dismissed.has(c.id));
    if (!contacts.length && i.type !== "meeting" && i.type !== "follow_up") continue; // everyone here was set aside
    const person = contacts[0] ? byId.get(contacts[0].id) ?? null : null;
    const alt = contacts[1] ? byId.get(contacts[1].id) ?? null : null;
    if (person) shownPeople.add(person.id);
    const priority = Math.round(person ? person.priority : (i.account?.priority ?? 0));
    const base = { ...i, contacts, person, alt, priority, why_line: whyLine(person, i.why || i.reason) };
    out.push({ ...base, lane: laneOf({ type: i.type, priority }) } as BoardItem);
  }
  // Pinned people and followed people with news, when they are not already on the board.
  for (const id of [...pinned, ...eventPeople]) {
    const p = byId.get(id);
    if (!p || shownPeople.has(id) || dismissed.has(id)) continue;
    shownPeople.add(id);
    const type = pinned.includes(id) ? "pinned" : "watch";
    out.push({
      key: `${type}-${id}`, type, label: type === "pinned" ? "Pinned by you" : "Watchlist: news about them", urgency: 0, headline: type === "pinned" ? "You added this person to your to-do" : "Something just happened to someone you watch",
      account: { id: p.account_id, name: p.company, domain: p.domain, tier: tierOf(null), priority: null, fit: null, fit_state: p.company_fit, status: "", outreach: p.co.outreach ?? "open", firmo: "", watched: p.co.watched },
      reason: "", why: null, signals: [], contacts: [], last_action: null, due: null, meeting: null,
      lane: type === "pinned" ? "now" : (p.priority >= 70 ? "now" : "week"), priority: p.priority, person: p, alt: null, why_line: whyLine(p, p.lead.reasons[0] ?? ""),
    } as BoardItem);
  }
  for (const a of waiting) {
    const c = (wmap.get(a.id) ?? [])[0];
    const p = c ? byId.get(c.id) ?? null : null;
    out.push({
      key: `wait-${a.id}`, type: "waiting", label: a.outreach_status === "replied" ? "They replied" : `Contacted · touch ${a.touches}`, urgency: 0,
      headline: a.next_followup_at ? `Next follow-up ${new Date(a.next_followup_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "Waiting for the next step",
      account: { id: a.id, name: a.name, domain: a.domain, tier: tierOf(a.priority_score), priority: a.priority_score, fit: null, fit_state: p?.company_fit ?? "unknown", status: "", outreach: a.outreach_status, firmo: "", watched: false },
      reason: "", why: null, signals: [], contacts: [], last_action: null, due: a.next_followup_at, meeting: null,
      lane: "waiting", priority: p?.priority ?? a.priority_score ?? 0, person: p, alt: null, why_line: null,
    } as BoardItem);
  }
  const capped = applyDailyCap(out, (icp.today as { cap?: number }).cap ?? 8);
  out.sort((x, y) => y.priority - x.priority);
  const lanes = { now: 0, week: 0, waiting: 0, later: 0 } as Record<Lane, number>;
  for (const i of out) lanes[i.lane]++;
  return { generated_at: t.generated_at, lanes, items: out, needs: await needsState(t.needs), debriefs: t.debriefs, leads: t.leads, blocked: t.blocked, hidden: t.hidden, capped, attention: undefined as unknown };
}
