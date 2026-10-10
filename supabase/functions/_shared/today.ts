import { sb } from "./db.ts";
import { log } from "./log.ts";
import { askClaude } from "./claude.ts";
import { fitState, type FitState, tierOf } from "./score.ts";
import { firmoLine, fitBreakdown } from "./firmo.ts";
import { autoFindContacts, type Contact, contactsFor } from "./contacts.ts";
import icp from "./icp.json" with { type: "json" };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FUNDING = /\b(raises?|raised|funding|series [a-d]|seed round|valuation|acquir)\b/i;

// deno-lint-ignore no-explicit-any -- JSON payloads from external APIs
type SigRow = { account_id: string; kind: string; title: string; url: string | null; detail: Record<string, any> | null; detected_at: string };

export type TodayType = "meeting" | "follow_up" | "hot" | "new" | "revive";

export type TodayItem = {
  key: string;
  type: TodayType;
  label: string;
  urgency: number;
  account: { id: string; name: string; domain: string; tier: string; priority: number | null; fit: number | null; fit_state: FitState; status: string; outreach: string; firmo: string } | null;
  headline: string;      // what to do, e.g. "Follow up: touch 2 of 4"
  reason: string;        // template line built from signals
  why: string | null;    // AI line, cached per signal set (owner generates it, everyone sees it)
  signals: { kind: string; title: string; url: string | null; first_seen: string; published: string | null; is_new: boolean }[];
  contacts: Contact[];  // who to contact: best first, then the next best persona
  last_action: string | null;
  due: string | null;
  meeting: { title: string; starts_at: string; briefed: boolean } | null;
};

export function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

const ageLabel = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const d = Math.floor((Date.now() - t) / DAY);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
};

/** Plain-English reason from the strongest two signals. No AI. */
export function reasonLine(sigs: SigRow[]): string {
  const parts: string[] = [];
  const hiring = sigs.find((s) => s.kind === "hiring" && s.detail && "salesOpenings" in s.detail);
  if (hiring && Number(hiring.detail?.salesOpenings) > 0) parts.push(`Hiring ${hiring.detail!.salesOpenings} sales/RevOps ${Number(hiring.detail!.salesOpenings) === 1 ? "role" : "roles"}`);
  const news = sigs.filter((s) => s.kind === "news");
  const funding = news.find((s) => FUNDING.test(s.title));
  if (funding) parts.push(`Funding news${funding.detail?.published ? ` (${ageLabel(funding.detail.published)})` : ""}`);
  else if (news[0]) parts.push(`In the news: ${news[0].title.slice(0, 60)}`);
  if (sigs.some((s) => s.kind === "hn")) parts.push("Hacker News mention");
  return parts.slice(0, 2).join(" · ") || "No fresh signal, follow your plan";
}

/** One short, grounded sentence for the rep. The only AI in the Today list. */
export async function generateWhy(it: { name: string; tier: string; type: string; touches: number; lastAction: string | null; sigs: SigRow[] }): Promise<string | null> {
  try {
    const facts = it.sigs.slice(0, 5).map((s) => s.kind === "hiring" && s.detail && "salesOpenings" in s.detail
      ? `hiring (current status, not a new event): ${s.title}`
      : `${s.kind}: ${s.title}${s.detail?.published ? ` (published ${ageLabel(s.detail.published)})` : ` (first seen ${ageLabel(s.detected_at)})`}`);
    const raw = await askClaude({
      feature: "why-today",
      maxTokens: 160,
      system: `You write ONE sentence (max 25 words) telling a sales rep at ${icp.seller.name} why to contact this account today. ${icp.seller.pitch} Use only the facts given. No hype, no invented numbers, no greeting. Only say "just" or "new" about something published or first seen in the last 7 days; otherwise name how long ago it was. Do not describe roles as leadership or senior unless the title says so. Plain text only, one sentence, finish it.`,
      user: `Company: ${it.name} (${it.tier.replace("_", " ")})\nSituation: ${it.type.replace("_", " ")}${it.touches ? `, ${it.touches} touch(es) so far` : ""}${it.lastAction ? `, ${it.lastAction}` : ""}\nSignals:\n${facts.join("\n") || "none"}`,
    });
    return raw.trim().replace(/^["']|["']$/g, "").slice(0, 220) || null;
  } catch {
    return null; // budget or API problem: the template line is shown instead
  }
}

/** Companies the rep cannot act on yet: a good signal but no named person to contact. */
export type NeedsContact = { id: string; name: string; tier: string; priority: number | null; reason: string };

export async function buildToday(admin: boolean, opts: { autoFind?: boolean } = {}) {
  const now = Date.now();
  const cfg = icp.today;

  const { data: accts } = await sb.from("cp_accounts")
    .select("id,name,domain,segment,priority_score,icp_score,why_now,status,outreach_status,touches,contacted_at,last_touch_at,next_followup_at,snoozed_until,employee_band,employees,stage,raised_usd,hq_city,country,firmo_at")
    .or("status.in.(queued,pushed),outreach_status.neq.open").limit(300);
  const accounts = accts ?? [];
  const ids = accounts.map((a) => a.id);

  const [{ data: sigRows }, { data: meetings }, { data: outcomes }, { data: whyRows }] = await Promise.all([
    ids.length ? sb.from("cp_signals").select("account_id,kind,title,url,detail,detected_at").in("account_id", ids).order("detected_at", { ascending: false }) : Promise.resolve({ data: [] }),
    sb.from("cp_meetings").select("id,title,starts_at,status,attendee_name,account_id,attendee_domain")
      .gt("starts_at", new Date(now).toISOString()).lt("starts_at", new Date(now + cfg.meetingHours * HOUR).toISOString()).eq("status", "briefed"),
    ids.length ? sb.from("cp_outcomes").select("account_id,kind,created_at").in("account_id", ids).order("created_at", { ascending: false }) : Promise.resolve({ data: [] }),
    ids.length ? sb.from("cp_why_today").select("account_id,signal_hash,text").in("account_id", ids) : Promise.resolve({ data: [] }),
  ]);

  const sigsBy = new Map<string, SigRow[]>();
  for (const s of (sigRows ?? []) as SigRow[]) (sigsBy.get(s.account_id) ?? sigsBy.set(s.account_id, []).get(s.account_id)!).push(s);
  const lastOutcome = new Map<string, { kind: string; created_at: string }>();
  for (const o of outcomes ?? []) if (!lastOutcome.has(o.account_id)) lastOutcome.set(o.account_id, o);

  const sigView = (sigs: SigRow[]) => sigs.slice(0, 4).map((s) => ({
    kind: s.kind, title: s.title, url: s.url, first_seen: s.detected_at,
    published: s.detail?.published ?? null,
    is_new: !(s.kind === "hiring" && s.detail && "salesOpenings" in s.detail) && now - Date.parse(s.detected_at) < 7 * DAY,
  }));
  const items: TodayItem[] = [];
  const meta = new Map<string, { name: string; tier: string; type: string; touches: number; lastAction: string | null; sigs: SigRow[]; hash: string }>();

  for (const a of accounts) {
    const rawSigs = sigsBy.get(a.id) ?? [];
    const isSummary = (s: SigRow) => s.kind === "hiring" && !!s.detail && "salesOpenings" in s.detail;
    const summaries = rawSigs.filter(isSummary); // newest first, so the first one is current
    const sigs = rawSigs.filter((s) => !isSummary(s) || s === summaries[0]);
    const tier = tierOf(a.priority_score);
    // "Fresh" means something real appeared: a news item or a newly posted role. A changed role count or a
    // Hacker News mention is not a reason to call an account hot.
    const meaningful = rawSigs.filter((s) => s.kind === "news" || (s.kind === "hiring" && !isSummary(s)));
    const seenAt = (s: SigRow) => {
      const pub = s.kind === "news" && s.detail?.published ? Date.parse(s.detail.published) : NaN;
      return Number.isNaN(pub) ? Date.parse(s.detected_at) : pub; // a news item is as fresh as its publish date
    };
    const newest = meaningful.length ? Math.max(...meaningful.map(seenAt)) : 0;
    const fit = fitBreakdown(a);
    const clearMiss = fit.known && fit.size === 0; // clearly outside the target company size
    const last = lastOutcome.get(a.id);
    const lastAction = last && last.kind !== "reopened" ? `${last.kind.replace("_", " ")} ${ageLabel(last.created_at)}` : null;
    const base = {
      account: { id: a.id, name: a.name, domain: a.domain, tier, priority: a.priority_score, fit: a.icp_score, fit_state: fitState(a), status: a.status, outreach: a.outreach_status, firmo: firmoLine(a) },
      signals: sigView(sigs), contacts: [] as Contact[], last_action: lastAction, meeting: null as TodayItem["meeting"],
      reason: reasonLine(sigs), why: null as string | null,
    };
    let it: Omit<TodayItem, "why"> & { why: string | null } | null = null;

    if (a.outreach_status === "meeting" && a.next_followup_at && Date.parse(a.next_followup_at) <= now) {
      const overdue = Math.floor((now - Date.parse(a.next_followup_at)) / DAY);
      it = { ...base, key: `post-${a.id}`, type: "follow_up", label: "After the meeting", urgency: 650 + Math.min(overdue, 30) * 3 + (a.priority_score ?? 0) / 10,
        headline: `Send the recap and agree the next step${overdue > 0 ? `, ${overdue}d overdue` : ""}`, due: a.next_followup_at };
    } else if (a.outreach_status === "contacted" && a.next_followup_at && Date.parse(a.next_followup_at) <= now) {
      const overdue = Math.floor((now - Date.parse(a.next_followup_at)) / DAY);
      const n = a.touches ?? 1;
      it = { ...base, key: `fu-${a.id}`, type: "follow_up", label: "Follow-up due", urgency: 600 + Math.min(overdue, 30) * 3 + (a.priority_score ?? 0) / 10,
        headline: `Follow up #${n} of ${icp.followUp.days.length}${overdue > 0 ? `, ${overdue}d overdue` : ""} · first contact ${ageLabel(a.contacted_at)}`, due: a.next_followup_at };
    } else if (a.outreach_status === "snoozed" && a.snoozed_until && Date.parse(a.snoozed_until) <= now) {
      it = { ...base, key: `sn-${a.id}`, type: "revive", label: "Snooze ended", urgency: 300 + (a.priority_score ?? 0) / 10,
        headline: "Snooze is over. Decide: reach out or snooze again", due: a.snoozed_until };
    } else if (a.outreach_status === "not_now" && tier === "tier_1" && !clearMiss && last && newest > Date.parse(last.created_at)) {
      it = { ...base, key: `rv-${a.id}`, type: "revive", label: "Worth another look", urgency: 250 + (a.priority_score ?? 0) / 10,
        headline: "Marked not now, but a stronger signal appeared since", due: null };
    } else if (a.outreach_status === "open" && a.status === "queued" && tier !== "tier_3" && !clearMiss && newest && now - newest < cfg.newDays * DAY) {
      const hot = now - newest < cfg.hotHours * HOUR;
      it = { ...base, key: `hot-${a.id}`, type: hot ? "hot" : "new", label: hot ? "Hot now" : "New this week",
        urgency: (hot ? 500 : 350) + (a.priority_score ?? 0) / 10, headline: hot ? "New signal in the last 48 hours" : "New signal this week", due: null };
    }
    if (it) {
      const h = hash("v3|" + sigs.map((s) => s.title).sort().join("|") + `|${a.outreach_status}|${a.touches}|${it.type}`); // v3 invalidates older cached sentences
      meta.set(it.key, { name: a.name, tier, type: it.type, touches: a.touches ?? 0, lastAction, sigs, hash: h });
      it.why = (whyRows ?? []).find((w) => w.account_id === a.id && w.signal_hash === h)?.text ?? null;
      items.push(it as TodayItem);
    }
  }

  for (const m of meetings ?? []) {
    const acct = accounts.find((a) => a.id === m.account_id) ?? null;
    items.push({
      key: `mt-${m.id}`, type: "meeting", label: "Meeting", urgency: 1000 - (Date.parse(m.starts_at) - now) / HOUR,
      account: acct ? { id: acct.id, name: acct.name, domain: acct.domain, tier: tierOf(acct.priority_score), priority: acct.priority_score, fit: acct.icp_score, fit_state: fitState(acct), status: acct.status, outreach: acct.outreach_status, firmo: firmoLine(acct) } : null,
      headline: `${m.title ?? "Meeting"} with ${admin ? m.attendee_name : (m.attendee_name ?? "").split(" ")[0]}${m.attendee_domain ? ` (${m.attendee_domain})` : ""}`,
      reason: "A private brief was emailed to you when it was booked", why: null, signals: [], contacts: [], last_action: null,
      due: m.starts_at, meeting: { title: m.title ?? "Meeting", starts_at: m.starts_at, briefed: true },
    });
  }

  items.sort((x, y) => y.urgency - x.urgency);

  // Today leads with a person. A new-signal item with nobody to contact is not actionable, so it waits in
  // "needs contact" (and shows in the Queue). Follow-ups and meetings stay: you already know the person.
  const gated = items.filter((i) => i.type !== "meeting");
  await attachContacts(gated, admin);
  if (opts.autoFind) {
    let found = false;
    for (const it of gated) {
      if (it.contacts.length || it.type === "follow_up" || !it.account) continue;
      const a = accounts.find((x) => x.id === it.account!.id);
      if (a && (await autoFindContacts({ id: a.id, domain: a.domain, priority_score: a.priority_score }))) found = true;
    }
    if (found) await attachContacts(gated, admin);
  }
  const waits = (i: TodayItem) => i.type !== "meeting" && i.type !== "follow_up" && !i.contacts.length;
  const needs: NeedsContact[] = items.filter(waits).map((i) => ({ id: i.account!.id, name: i.account!.name, tier: i.account!.tier, priority: i.account!.priority, reason: i.reason }));
  const ready = items.filter((i) => !waits(i));
  const shown = ready.slice(0, cfg.cap);

  // Owner view: write any missing "Why today" sentences (cached per signal set, so each costs once).
  if (admin) {
    for (const it of shown) {
      const m = meta.get(it.key);
      if (!m || it.why) continue;
      const text = await generateWhy(m);
      if (text) {
        it.why = text;
        await sb.from("cp_why_today").upsert({ account_id: it.account!.id, signal_hash: m.hash, text });
      }
    }
  }

  const { count: debriefs } = await sb.from("cp_meetings").select("id", { count: "exact", head: true })
    .eq("status", "briefed").is("outcome", null).lt("starts_at", new Date(now).toISOString()).gt("starts_at", new Date(now - 7 * DAY).toISOString());
  const counts: Record<string, number> = {};
  for (const it of shown) counts[it.type] = (counts[it.type] ?? 0) + 1;
  await log("info", "today_built", { detail: { shown: shown.length, hidden: ready.length - shown.length, needs: needs.length, counts, admin } });
  return { generated_at: new Date().toISOString(), cap: cfg.cap, counts, hidden: Math.max(0, ready.length - shown.length), needs, debriefs: debriefs ?? 0, items: shown };
}


/** Fills in who to contact for each item, from the stored people search. Safe to call again after a lookup. */
export async function attachContacts(items: TodayItem[], admin: boolean) {
  const ids = [...new Set(items.map((i) => i.account?.id).filter(Boolean) as string[])];
  const map = await contactsFor(ids, admin);
  for (const it of items) if (it.account) it.contacts = map.get(it.account.id) ?? [];
}
