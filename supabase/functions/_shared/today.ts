import { sb } from "./db.ts";
import { log } from "./log.ts";
import { askClaude } from "./claude.ts";
import { tierOf } from "./score.ts";
import icp from "./icp.json" with { type: "json" };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FUNDING = /\b(raises?|raised|funding|series [a-d]|seed round|valuation|acquir)\b/i;

type SigRow = { account_id: string; kind: string; title: string; url: string | null; detail: Record<string, any> | null; detected_at: string };

export type TodayType = "meeting" | "follow_up" | "hot" | "new" | "revive";

export type TodayItem = {
  key: string;
  type: TodayType;
  label: string;
  urgency: number;
  account: { id: string; name: string; domain: string; tier: string; priority: number | null; fit: number | null; status: string; outreach: string } | null;
  headline: string;      // what to do, e.g. "Follow up: touch 2 of 4"
  reason: string;        // template line built from signals
  why: string | null;    // AI line, cached per signal set (owner generates it, everyone sees it)
  signals: { kind: string; title: string; url: string | null; first_seen: string; published: string | null; is_new: boolean }[];
  contact: { name: string; title: string; persona: string | null } | null;
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
    const facts = it.sigs.slice(0, 5).map((s) => `${s.kind}: ${s.title}${s.detail?.published ? ` (published ${ageLabel(s.detail.published)})` : ` (first seen ${ageLabel(s.detected_at)})`}`);
    const raw = await askClaude({
      feature: "why-today",
      maxTokens: 160,
      system: `You write ONE sentence (max 25 words) telling a sales rep at ${icp.seller.name} why to contact this account today. ${icp.seller.pitch} Use only the facts given. No hype, no invented numbers, no greeting. Plain text only, one sentence, finish it.`,
      user: `Company: ${it.name} (${it.tier.replace("_", " ")})\nSituation: ${it.type.replace("_", " ")}${it.touches ? `, ${it.touches} touch(es) so far` : ""}${it.lastAction ? `, ${it.lastAction}` : ""}\nSignals:\n${facts.join("\n") || "none"}`,
    });
    return raw.trim().replace(/^["']|["']$/g, "").slice(0, 220) || null;
  } catch {
    return null; // budget or API problem: the template line is shown instead
  }
}

export async function buildToday(admin: boolean) {
  const now = Date.now();
  const cfg = icp.today;

  const { data: accts } = await sb.from("cp_accounts")
    .select("id,name,domain,segment,priority_score,icp_score,why_now,status,outreach_status,touches,contacted_at,last_touch_at,next_followup_at,snoozed_until")
    .or("status.in.(queued,pushed),outreach_status.neq.open").limit(300);
  const accounts = accts ?? [];
  const ids = accounts.map((a) => a.id);

  const [{ data: sigRows }, { data: people }, { data: meetings }, { data: outcomes }, { data: whyRows }] = await Promise.all([
    ids.length ? sb.from("cp_signals").select("account_id,kind,title,url,detail,detected_at").in("account_id", ids).order("detected_at", { ascending: false }) : Promise.resolve({ data: [] }),
    ids.length ? sb.from("cp_people").select("account_id,first_name,last_name,title,persona,relevance").in("account_id", ids).order("relevance", { ascending: false }) : Promise.resolve({ data: [] }),
    sb.from("cp_meetings").select("id,title,starts_at,status,attendee_name,account_id,attendee_domain")
      .gt("starts_at", new Date(now).toISOString()).lt("starts_at", new Date(now + cfg.meetingHours * HOUR).toISOString()).eq("status", "briefed"),
    ids.length ? sb.from("cp_outcomes").select("account_id,kind,created_at").in("account_id", ids).order("created_at", { ascending: false }) : Promise.resolve({ data: [] }),
    ids.length ? sb.from("cp_why_today").select("account_id,signal_hash,text").in("account_id", ids) : Promise.resolve({ data: [] }),
  ]);

  const sigsBy = new Map<string, SigRow[]>();
  for (const s of (sigRows ?? []) as SigRow[]) (sigsBy.get(s.account_id) ?? sigsBy.set(s.account_id, []).get(s.account_id)!).push(s);
  const topPerson = new Map<string, any>();
  for (const p of people ?? []) if (!topPerson.has(p.account_id) && p.relevance > 0) topPerson.set(p.account_id, p);
  const lastOutcome = new Map<string, { kind: string; created_at: string }>();
  for (const o of outcomes ?? []) if (!lastOutcome.has(o.account_id)) lastOutcome.set(o.account_id, o);

  const sigView = (sigs: SigRow[]) => sigs.slice(0, 4).map((s) => ({
    kind: s.kind, title: s.title, url: s.url, first_seen: s.detected_at,
    published: s.detail?.published ?? null, is_new: now - Date.parse(s.detected_at) < 7 * DAY,
  }));
  const contactOf = (id: string) => {
    const p = topPerson.get(id);
    if (!p) return null;
    return { name: admin ? `${p.first_name} ${p.last_name}`.trim() : `${p.first_name} ${(p.last_name || "").charAt(0)}.`.trim(), title: p.title, persona: p.persona };
  };

  const items: TodayItem[] = [];
  const meta = new Map<string, { name: string; tier: string; type: string; touches: number; lastAction: string | null; sigs: SigRow[]; hash: string }>();

  for (const a of accounts) {
    const sigs = sigsBy.get(a.id) ?? [];
    const tier = tierOf(a.priority_score);
    const newest = sigs.length ? Date.parse(sigs[0].detected_at) : 0;
    const last = lastOutcome.get(a.id);
    const lastAction = last ? `${last.kind.replace("_", " ")} ${ageLabel(last.created_at)}` : null;
    const base = {
      account: { id: a.id, name: a.name, domain: a.domain, tier, priority: a.priority_score, fit: a.icp_score, status: a.status, outreach: a.outreach_status },
      signals: sigView(sigs), contact: contactOf(a.id), last_action: lastAction, meeting: null as TodayItem["meeting"],
      reason: reasonLine(sigs), why: null as string | null,
    };
    let it: Omit<TodayItem, "why"> & { why: string | null } | null = null;

    if (a.outreach_status === "contacted" && a.next_followup_at && Date.parse(a.next_followup_at) <= now) {
      const overdue = Math.floor((now - Date.parse(a.next_followup_at)) / DAY);
      const n = a.touches ?? 1;
      it = { ...base, key: `fu-${a.id}`, type: "follow_up", label: "Follow-up due", urgency: 600 + Math.min(overdue, 30) * 3 + (a.priority_score ?? 0) / 10,
        headline: `Follow up #${n} of ${icp.followUp.days.length}${overdue > 0 ? `, ${overdue}d overdue` : ""} · first contact ${ageLabel(a.contacted_at)}`, due: a.next_followup_at };
    } else if (a.outreach_status === "snoozed" && a.snoozed_until && Date.parse(a.snoozed_until) <= now) {
      it = { ...base, key: `sn-${a.id}`, type: "revive", label: "Snooze ended", urgency: 300 + (a.priority_score ?? 0) / 10,
        headline: "Snooze is over. Decide: reach out or snooze again", due: a.snoozed_until };
    } else if (a.outreach_status === "not_now" && tier === "tier_1" && last && newest > Date.parse(last.created_at)) {
      it = { ...base, key: `rv-${a.id}`, type: "revive", label: "Worth another look", urgency: 250 + (a.priority_score ?? 0) / 10,
        headline: "Marked not now, but a stronger signal appeared since", due: null };
    } else if (a.outreach_status === "open" && a.status === "queued" && tier !== "tier_3" && newest && now - newest < cfg.newDays * DAY) {
      const hot = now - newest < cfg.hotHours * HOUR;
      it = { ...base, key: `hot-${a.id}`, type: hot ? "hot" : "new", label: hot ? "Hot now" : "New this week",
        urgency: (hot ? 500 : 350) + (a.priority_score ?? 0) / 10, headline: hot ? "New signal in the last 48 hours" : "New signal this week", due: null };
    }
    if (it) {
      const h = hash(sigs.map((s) => s.title).sort().join("|") + `|${a.outreach_status}|${a.touches}|${it.type}`);
      meta.set(it.key, { name: a.name, tier, type: it.type, touches: a.touches ?? 0, lastAction, sigs, hash: h });
      it.why = (whyRows ?? []).find((w) => w.account_id === a.id && w.signal_hash === h)?.text ?? null;
      items.push(it as TodayItem);
    }
  }

  for (const m of meetings ?? []) {
    const acct = accounts.find((a) => a.id === m.account_id) ?? null;
    items.push({
      key: `mt-${m.id}`, type: "meeting", label: "Meeting", urgency: 1000 - (Date.parse(m.starts_at) - now) / HOUR,
      account: acct ? { id: acct.id, name: acct.name, domain: acct.domain, tier: tierOf(acct.priority_score), priority: acct.priority_score, fit: acct.icp_score, status: acct.status, outreach: acct.outreach_status } : null,
      headline: `${m.title ?? "Meeting"} with ${admin ? m.attendee_name : (m.attendee_name ?? "").split(" ")[0]}${m.attendee_domain ? ` (${m.attendee_domain})` : ""}`,
      reason: "A private brief was emailed to you when it was booked", why: null, signals: [], contact: null, last_action: null,
      due: m.starts_at, meeting: { title: m.title ?? "Meeting", starts_at: m.starts_at, briefed: true },
    });
  }

  items.sort((x, y) => y.urgency - x.urgency);
  const shown = items.slice(0, cfg.cap);

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

  const counts: Record<string, number> = {};
  for (const it of shown) counts[it.type] = (counts[it.type] ?? 0) + 1;
  await log("info", "today_built", { detail: { shown: shown.length, hidden: items.length - shown.length, counts, admin } });
  return { generated_at: new Date().toISOString(), cap: cfg.cap, counts, hidden: Math.max(0, items.length - shown.length), items: shown };
}
