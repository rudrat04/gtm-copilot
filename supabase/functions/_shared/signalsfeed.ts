import { sb } from "./db.ts";
import { FIT_COLS } from "./firmo.ts";
import { fitState, heatOf } from "./score.ts";
import { aiHeat, aiMaps } from "./aiscore.ts";
import { inTeam, isLeader } from "./peoplesignals.ts";
import { eventDateOk, KIND_LABEL, type EventKind } from "./movements.ts";

// The Signals tab: everything that happened around your companies and people, in plain categories, newest first. Each item names the company
// and the people in it who would care (a hiring signal for sales roles goes with the sales leaders; funding goes with the founders and executives).
// Buying intent is a category of its own: someone visited your site, a competitor is in use, job posts mention your problem, or they asked for a demo.

export type Category = "Buying intent" | "Hiring" | "Funding" | "Leadership" | "Events" | "People activity" | "Tools and website" | "Competitors" | "News";
export const CATEGORIES: Category[] = ["Buying intent", "Hiring", "Funding", "Leadership", "Events", "People activity", "Tools and website", "Competitors", "News"];
const FUNDING = /\b(raises?|raised|funding|series [a-d]|seed round|valuation)\b/i;
const LEADERSHIP = /\b(appoints?|names?|hires?|joins as|promotes?)\b.*\b(head|vp|chief|cro|cmo|ceo|director)\b/i;

export type RawSignal = { kind: string; title: string; detail?: Record<string, unknown> | null };

/** Pure: which category a stored signal belongs to, and whether it counts as buying intent. */
export function categorize(s: RawSignal): { category: Category; intent: boolean } {
  const d = (s.detail ?? {}) as { ruleType?: string; newsType?: string; plType?: string; intentPage?: boolean };
  if (s.kind === "tech") {
    if (d.ruleType === "visit") return { category: "Buying intent", intent: true };
    if (d.ruleType === "competitor") return { category: "Buying intent", intent: true };
    if (d.ruleType === "pain") return { category: "Buying intent", intent: true };
    if (d.ruleType === "change") return { category: "Tools and website", intent: false };
    return { category: "Tools and website", intent: false };
  }
  if (s.kind === "hiring") return { category: "Hiring", intent: false };
  if (s.kind === "news") {
    if (d.newsType === "funding" || d.plType === "funding" || FUNDING.test(s.title)) return { category: "Funding", intent: false };
    if (d.newsType === "leadership" || d.plType === "hire" || LEADERSHIP.test(s.title)) return { category: "Leadership", intent: false };
    if (d.newsType === "event") return { category: "Events", intent: false };
    return { category: "News", intent: false };
  }
  return { category: "News", intent: false };
}

/** Pure: a category for a Watchlist movement. */
export function categorizeEvent(kind: string): { category: Category; intent: boolean } {
  if (["visit", "pain", "competitor_tool", "lead"].includes(kind)) return { category: "Buying intent", intent: true };
  if (kind === "competitor_event" || kind === "market") return { category: "Competitors", intent: false };
  if (kind === "funding") return { category: "Funding", intent: false };
  if (kind === "leadership" || kind === "job_change") return { category: "Leadership", intent: false };
  if (kind === "event") return { category: "Events", intent: false };
  if (kind === "activity" || kind === "mention") return { category: "People activity", intent: false };
  if (kind === "tool_change" || kind === "tool") return { category: "Tools and website", intent: false };
  if (kind === "hiring" || kind === "team") return { category: "Hiring", intent: false };
  return { category: "News", intent: false };
}

type P = { id: string; name: string; title: string | null; department: string | null; relevance: number; preview: boolean; revealed: boolean; decision_maker: boolean | null };

/** Pure: the people at the company who should hear about a signal, best first (at most 2). */
export function responsible(category: Category, text: string, people: P[]): P[] {
  const score = (p: P) => {
    let w = p.relevance / 10 + (p.decision_maker ? 2 : 0);
    if (category === "Hiring" && inTeam(p.department, p.title, text)) w += 8;
    else if (["Funding", "Leadership", "News", "Events"].includes(category) && isLeader(p.department, p.title)) w += 6;
    else if (category === "Buying intent" && (inTeam(p.department, p.title, "sales revenue") || isLeader(p.department, p.title))) w += 5;
    else if (inTeam(p.department, p.title, text)) w += 4;
    return w;
  };
  return [...people].sort((a, b) => score(b) - score(a)).slice(0, 2);
}

const age = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));

export async function signalsFeed(admin: boolean, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const [{ data: sigs }, { data: evs }] = await Promise.all([
    sb.from("cp_signals").select("account_id,kind,title,url,detail,detected_at").gt("detected_at", since).order("detected_at", { ascending: false }).limit(1500),
    sb.from("cp_watch_events").select("kind,title,url,account_id,person_id,subject,detected_at,event_at").gt("detected_at", since).order("detected_at", { ascending: false }).limit(300),
  ]);
  const ids = [...new Set([...(sigs ?? []).map((s) => s.account_id), ...(evs ?? []).map((e) => e.account_id).filter(Boolean) as string[]])];
  const { data: accts } = ids.length ? await sb.from("cp_accounts").select(`id,name,domain,removed_at,${FIT_COLS}`).in("id", ids) : { data: [] };
  const a = new Map((accts ?? []).filter((x) => !x.removed_at).map((x) => [x.id, x]));
  const { data: ppl } = ids.length ? await sb.from("cp_people").select("id,account_id,first_name,last_name,title,department,relevance,preview,email_revealed,decision_maker,todo_state").in("account_id", ids).gte("relevance", 50) : { data: [] };
  const by = new Map<string, P[]>();
  for (const p of ppl ?? []) if (p.todo_state !== "dismissed") (by.get(p.account_id) ?? by.set(p.account_id, []).get(p.account_id)!).push({ id: p.id, name: admin ? `${p.first_name} ${p.last_name}`.trim() : `${p.first_name} ${(p.last_name || "").charAt(0)}.`.trim(), title: p.title, department: p.department, relevance: p.relevance, preview: !!p.preview, revealed: !!p.email_revealed, decision_maker: p.decision_maker });
  const aiCo = await aiMaps("company", ids);
  const sigsBy = new Map<string, typeof sigs>();
  for (const s of sigs ?? []) (sigsBy.get(s.account_id) ?? sigsBy.set(s.account_id, []).get(s.account_id)!)!.push(s);

  const out: { market?: boolean; followed?: boolean; id: string; category: Category; intent: boolean; label: string; title: string; url: string | null; at: string; company: { id: string; name: string; domain: string; fit: string; heat: string }; who: string | null; people: P[] }[] = [];
  const seen = new Set<string>();
  const add = (accountId: string, cat: { category: Category; intent: boolean }, label: string, title: string, url: string | null, at: string, who: string | null, exempt = false) => {
    const c = a.get(accountId);
    if (!c) return;
    const key = `${accountId}|${title.toLowerCase().slice(0, 80)}`;
    if (seen.has(key)) return;
    const fit = fitState(c as never);
    if (!c.watched_at && !exempt && fit === "outside") return; // clearly outside your size or stage and not followed: not worth a signal
    seen.add(key);
    const heat = aiCo.has(accountId) ? aiHeat(aiCo.get(accountId)!.label) : heatOf((sigsBy.get(accountId) ?? []) as never, fit);
    out.push({ id: key, ...cat, followed: !!c.watched_at || exempt, label, title, url, at, company: { id: accountId, name: c.name as string, domain: c.domain as string, fit, heat }, who, people: responsible(cat.category, title, by.get(accountId) ?? []) });
  };
  for (const s of sigs ?? []) {
    const d = (s.detail ?? {}) as { salesOpenings?: number; published?: string };
    if (s.kind === "hiring" && d.salesOpenings != null) { if (Number(d.salesOpenings) > 0) add(s.account_id, { category: "Hiring", intent: false }, "Hiring", `${d.salesOpenings} sales or RevOps roles open`, s.url, s.detected_at, null); continue; }
    if (s.kind === "hn") continue; // a Hacker News mention alone is not a signal
    const cat = categorize(s);
    add(s.account_id, cat, cat.category === "Buying intent" ? ((s.detail as { ruleType?: string } | null)?.ruleType === "visit" ? "Visited your website" : (s.detail as { ruleType?: string } | null)?.ruleType === "competitor" ? "Uses a competitor" : "Mentions your problem") : cat.category, s.title.replace(/^Hiring:\s*/i, ""), s.url, d.published ?? s.detected_at, null);
  }
  const personIds = [...new Set((evs ?? []).map((e) => e.person_id).filter(Boolean) as string[])];
  const { data: wp } = personIds.length ? await sb.from("cp_people").select("id").in("id", personIds).not("watched_at", "is", null) : { data: [] };
  const watchedPeople = new Set((wp ?? []).map((x) => x.id));
  const maskName = (n: string | null) => { if (admin || !n) return n; const p = n.trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1].charAt(0)}.` : p[0]; };
  for (const e of evs ?? []) {
    if (!eventDateOk(e.event_at)) continue; // old news, or a date that cannot be right
    const at = e.event_at ?? e.detected_at; // the day it happened, when we know it
    const cat = categorizeEvent(e.kind);
    if (!e.account_id) { // competitor and market news belongs to no company: it gets its own card
      if (e.kind !== "competitor_event" && e.kind !== "market") continue;
      const key = `market|${e.title.toLowerCase().slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: key, ...cat, market: true, label: KIND_LABEL[e.kind as EventKind] ?? e.kind, title: e.title, url: e.url, at, company: { id: "", name: e.subject ?? "Market", domain: "", fit: "unknown", heat: "watching" }, who: null, people: [] });
      continue;
    }
    add(e.account_id, cat, KIND_LABEL[e.kind as EventKind] ?? e.kind, e.title, e.url, at, e.person_id ? maskName(e.subject) : e.subject, !!(e.person_id && watchedPeople.has(e.person_id)));
  }
  out.sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  const counts: Record<string, number> = {};
  for (const i of out) counts[i.category] = (counts[i.category] ?? 0) + 1;
  return { admin, categories: CATEGORIES, counts, total: out.length, today: out.filter((i) => age(i.at) < 1).length, intent: out.filter((i) => i.intent).length, items: out.slice(0, 200) };
}
