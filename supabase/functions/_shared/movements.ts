import { sb } from "./db.ts";
import { log } from "./log.ts";
import { isEventHeadline, newsRaw, type Signal } from "./signals.ts";
import { googleConfigured, ownerEmail, sendMail } from "./google.ts";
import { button, esc as h, h2, layout, link, list } from "./emailhtml.ts";
import { lookupContactsByEmail } from "./hubspot.ts";
import { guardStatus } from "./guard.ts";
import { HUNTER_MONTHLY_CAP, monthlyUsed, provider, rank } from "./people.ts";
import { creditsLeft } from "./autosearch.ts";
import icp from "./icp.json" with { type: "json" };

// Movements on followed companies and people (and on competitors): every one is stored as an event, shown in the Watchlist tab,
// and emailed: big ones at once (grouped, at most 3 emails a day), the rest in the daily email. All free except the optional
// title re-check, which spends search credits inside the owner's reserve.

export type EventKind = "funding" | "leadership" | "event" | "competitor_event" | "news" | "hiring" | "tool" | "competitor_tool" | "deal" | "lead" | "people" | "mention" | "contact" | "job_change";
export type WatchEvent = { key: string; kind: EventKind; importance: "big" | "small"; accountId?: string | null; personId?: string | null; subject?: string | null; title: string; url?: string | null };

export const KIND_LABEL: Record<EventKind, string> = {
  funding: "Funding", leadership: "Leadership change", event: "Hosting an event", competitor_event: "Competitor event", news: "In the news", hiring: "Hiring",
  tool: "Uses a tool you track", competitor_tool: "Uses a competitor", deal: "HubSpot deal", lead: "Inbound lead", people: "People found", mention: "Mentioned in the news",
  contact: "HubSpot contact changed", job_change: "Job change",
};
export const MAX_WATCHED = { companies: 40, people: 40 };

export const hashStr = (s: string) => { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0; return (x >>> 0).toString(36); };

const LEADER = /\b(head|vp|vice president|chief|cro|director)\b/i;

/** Pure: which movements do these fresh signals on a followed company amount to? */
export function eventsFromSignals(account: { id: string }, fresh: Signal[]): WatchEvent[] {
  const out: WatchEvent[] = [];
  for (const s of fresh) {
    const d = (s.detail ?? {}) as Record<string, unknown>;
    const key = (k: string) => `${k}:${account.id}:${hashStr(s.title)}`;
    const base = { accountId: account.id, title: s.title.slice(0, 240), url: s.url ?? null };
    if (s.kind === "news") {
      const plType = String(d.plType ?? ""), nt = String(d.newsType ?? "");
      if (plType === "FUNDING" || nt === "funding") out.push({ ...base, key: key("funding"), kind: "funding", importance: "big" });
      else if (plType === "NEW_CRO" || plType === "NEW_VP_SALES" || nt === "leadership") out.push({ ...base, key: key("leadership"), kind: "leadership", importance: "big" });
      else if (nt === "event") out.push({ ...base, key: key("event"), kind: "event", importance: "big" });
      else out.push({ ...base, key: key("news"), kind: "news", importance: "small" });
    } else if (s.kind === "hiring" && !("salesOpenings" in d)) {
      out.push({ ...base, key: key("hiring"), kind: "hiring", importance: LEADER.test(s.title) ? "big" : "small" });
    } else if (s.kind === "tech" && d.ruleType) {
      out.push({ ...base, key: key("tool"), kind: d.ruleType === "competitor" ? "competitor_tool" : "tool", importance: d.ruleType === "competitor" ? "big" : "small" });
    }
  }
  return out;
}

/** Stores an event once (the key dedupes). Returns true when it is new. */
export async function recordEvent(e: WatchEvent): Promise<boolean> {
  const { data, error } = await sb.from("cp_watch_events").upsert({
    key: e.key, kind: e.kind, importance: e.importance, account_id: e.accountId ?? null, person_id: e.personId ?? null, subject: e.subject ?? null, title: e.title, url: e.url ?? null,
  }, { onConflict: "key", ignoreDuplicates: true }).select("id");
  if (error) { await log("warn", "watch_event_failed", { message: error.message, detail: { key: e.key } }); return false; }
  return (data ?? []).length > 0;
}

/** Records an event only if the company is followed (used by hooks in other jobs). */
export async function recordIfWatched(accountId: string, e: Omit<WatchEvent, "accountId">) {
  const { data } = await sb.from("cp_accounts").select("watched_at").eq("id", accountId).maybeSingle();
  if (data?.watched_at) await recordEvent({ ...e, accountId });
}

/** Competitors hosting events (news, free). Names come from the owner's competitor list; a domain is reduced to its name. */
export async function competitorEvents(): Promise<number> {
  const names = ((icp.company as { competitors?: string[] }).competitors ?? []).map((c) => c.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\.[a-z]{2,}.*$/, "")).filter(Boolean).slice(0, 5);
  let n = 0;
  for (const name of names) {
    const items = await newsRaw(`"${name}" (webinar OR conference OR summit OR keynote OR "launch event" OR meetup OR hosts OR hosting)`, 30);
    for (const i of items.filter((x) => isEventHeadline(x.title, name)).slice(0, 2)) {
      if (await recordEvent({ key: `competitor_event::${hashStr(i.title)}`, kind: "competitor_event", importance: "big", subject: name, title: i.title.slice(0, 240), url: i.url ?? null })) n++;
    }
  }
  return n;
}

/** Followed people mentioned in the news (free; up to `limit` people a run, the longest-unchecked first). */
export async function personMentions(limit = 8): Promise<number> {
  const { data: people } = await sb.from("cp_people").select("id,first_name,last_name,account_id,watch_checked_at,watch_notify").not("watched_at", "is", null).neq("watch_notify", "off")
    .order("watch_checked_at", { ascending: true, nullsFirst: true }).limit(limit);
  if (!people?.length) return 0;
  const { data: accts } = await sb.from("cp_accounts").select("id,name").in("id", people.map((p) => p.account_id));
  const company = new Map((accts ?? []).map((a) => [a.id, a.name]));
  let n = 0;
  for (const p of people) {
    const full = `${p.first_name} ${p.last_name}`.trim(), co = company.get(p.account_id) ?? "";
    const items = await newsRaw(`"${full}" "${co}"`, 30);
    for (const i of items.filter((x) => x.title.toLowerCase().includes(p.last_name.toLowerCase()) && x.title.toLowerCase().includes(co.toLowerCase())).slice(0, 2)) {
      if (await recordEvent({ key: `mention:${p.id}:${hashStr(i.title)}`, kind: "mention", importance: "small", accountId: p.account_id, personId: p.id, title: i.title.slice(0, 240), url: i.url ?? null })) n++;
    }
    await sb.from("cp_people").update({ watch_checked_at: new Date().toISOString() }).eq("id", p.id);
  }
  return n;
}

/** Followed people whose HubSpot record changed (opted out, bounced, now known there). One batch read, no credits. */
export async function watchedPeopleHubspot(): Promise<number> {
  if (!Deno.env.get("HUBSPOT_TOKEN")) return 0;
  const { data: people } = await sb.from("cp_people").select("id,account_id,first_name,last_name,email,hs_status,hubspot_contact_id").not("watched_at", "is", null).not("email", "is", null).limit(40);
  if (!people?.length) return 0;
  let n = 0;
  try {
    const found = await lookupContactsByEmail(people.map((p) => p.email!));
    for (const p of people) {
      const { status, note } = guardStatus(found.get(p.email!.toLowerCase()), !!p.hubspot_contact_id);
      if (status === (p.hs_status ?? null)) continue;
      await sb.from("cp_people").update({ hs_status: status, hs_note: note, hs_checked_at: new Date().toISOString() }).eq("id", p.id);
      if (status && await recordEvent({ key: `contact:${p.id}:${status}`, kind: "contact", importance: status === "known" ? "small" : "big", accountId: p.account_id, personId: p.id, title: `${p.first_name} ${p.last_name}: ${note}` })) n++;
    }
  } catch (e) { await log("warn", "watch_hubspot_failed", { message: (e as Error).message }); }
  return n;
}

/** Optional (owner opt-in): once a month per company, re-read the people there and spot a changed job title. Spends search credits, inside the reserve. */
export async function titleRecheck(maxCompanies = 2): Promise<number> {
  if (!icp.watch.titleCheck) return 0;
  const { data: people } = await sb.from("cp_people").select("id,account_id,first_name,last_name,title,email").not("watched_at", "is", null).not("email", "is", null);
  const byAccount = new Map<string, NonNullable<typeof people>>();
  for (const p of people ?? []) (byAccount.get(p.account_id) ?? byAccount.set(p.account_id, []).get(p.account_id)!).push(p);
  if (!byAccount.size) return 0;
  const { data: accts } = await sb.from("cp_accounts").select("id,domain,employees").in("id", [...byAccount.keys()]);
  const { data: st } = await sb.from("cp_state").select("key,value").like("key", "title_check:%");
  const last = new Map((st ?? []).map((r) => [r.key.slice(12), Date.parse(r.value)]));
  const due = (accts ?? []).filter((a) => !last.get(a.id) || Date.now() - last.get(a.id)! > 30 * 86_400_000).slice(0, maxCompanies);
  let n = 0;
  for (const a of due) {
    if (creditsLeft(await monthlyUsed(), HUNTER_MONTHLY_CAP, icp.watch.alertReserve) <= 0) break;
    try {
      const found = await provider().search(a.domain);
      for (const p of byAccount.get(a.id)!) {
        const now = found.people.find((f) => f.email?.toLowerCase() === p.email!.toLowerCase());
        if (!now || norm(now.title) === norm(p.title)) continue;
        const r = rank(now.title, a.employees, now.department);
        await sb.from("cp_people").update({ title: now.title, persona: r.persona, relevance: r.relevance, seniority: r.seniority }).eq("id", p.id);
        if (await recordEvent({ key: `job_change:${p.id}:${hashStr(now.title)}`, kind: "job_change", importance: "big", accountId: a.id, personId: p.id, title: `${p.first_name} ${p.last_name}: now ${now.title} (was ${p.title})` })) n++;
      }
    } catch (e) { await log("warn", "title_recheck_failed", { account: a.domain, message: (e as Error).message }); }
    await sb.from("cp_state").upsert({ key: `title_check:${a.id}`, value: new Date().toISOString(), updated_at: new Date().toISOString() });
  }
  return n;
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

type Row = { id: string; kind: EventKind; title: string; url: string | null; account_id: string | null; person_id: string | null; subject: string | null; detected_at: string };
const ago = (iso: string) => { const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000); return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`; };

/** The lines for one event, with the company or competitor named. Shared by the instant email, the daily email and the tab. */
export function eventLine(e: { kind: EventKind; title: string; detected_at: string }, who: string): string {
  return `${who}: ${KIND_LABEL[e.kind]}. ${e.title.slice(0, 140)} (${ago(e.detected_at)})`;
}

/** Emails the big movements that have not been sent, as one grouped message. At most 3 such emails a day; the rest wait for the daily email. */
export async function sendMovementEmail(): Promise<number> {
  if (!googleConfigured()) return 0;
  const day = new Date().toISOString().slice(0, 10);
  const { data: cnt } = await sb.from("cp_state").select("value").eq("key", `move_mail:${day}`).maybeSingle();
  if (Number(cnt?.value ?? 0) >= 3) return 0;
  const { data: ev } = await sb.from("cp_watch_events").select("id,kind,title,url,account_id,person_id,subject,detected_at").eq("importance", "big").is("emailed_at", null).gt("detected_at", new Date(Date.now() - 3 * 86_400_000).toISOString()).order("detected_at", { ascending: false }).limit(30);
  const rows = (ev ?? []) as Row[];
  if (!rows.length) return 0;
  const ids = [...new Set(rows.map((r) => r.account_id).filter(Boolean) as string[])];
  const { data: accts } = ids.length ? await sb.from("cp_accounts").select("id,name,domain,watched_at,watch_notify").in("id", ids) : { data: [] };
  const a = new Map((accts ?? []).map((x) => [x.id, x]));
  const pids = [...new Set(rows.map((r) => r.person_id).filter(Boolean) as string[])];
  const { data: ppl } = pids.length ? await sb.from("cp_people").select("id,watch_notify,watched_at").in("id", pids) : { data: [] };
  const p = new Map((ppl ?? []).map((x) => [x.id, x]));
  const send = rows.filter((r) => {
    if (r.person_id) { const x = p.get(r.person_id); return !!x?.watched_at && x.watch_notify === "instant"; }
    if (r.account_id) { const x = a.get(r.account_id); return !!x?.watched_at && x.watch_notify === "instant"; }
    return true; // a competitor event
  });
  if (!send.length) return 0;
  const who = (r: Row) => (r.account_id ? a.get(r.account_id)?.name ?? "A followed company" : r.subject ?? "Competitor");
  const lines = send.map((r) => eventLine(r, who(r)));
  const first = send[0];
  const subject = send.length === 1 ? `Watchlist: ${who(first)}, ${KIND_LABEL[first.kind].toLowerCase()}` : `Watchlist: ${send.length} movements (${[...new Set(send.map((r) => who(r)))].slice(0, 3).join(", ")})`;
  const page = icp.owner.pageUrl;
  const html = layout([
    `<div style="font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#78716c">Watchlist</div>`,
    h2(`${send.length} movement${send.length === 1 ? "" : "s"}`),
    list(send.map((r) => `<b>${h(who(r))}</b> <span style="color:#78716c">· ${h(KIND_LABEL[r.kind])}</span><br>${r.url ? link(r.url, r.title.slice(0, 140)) : h(r.title.slice(0, 140))} <span style="color:#78716c">(${h(ago(r.detected_at))})</span>`)),
    `<div style="margin-top:14px">${button(`${page}#watchlist`, "Open the Watchlist")}</div>`,
  ].join(""), "F1rstword · you choose what to be told in Setup · outreach stays manual");
  try {
    await sendMail(ownerEmail(), subject, [`Watchlist movements`, ...lines.map((l) => `- ${l}`), `\nOpen: ${page}`].join("\n"), html);
  } catch (e) {
    await log("error", "movement_email_failed", { message: (e as Error).message });
    return 0;
  }
  await sb.from("cp_watch_events").update({ emailed_at: new Date().toISOString() }).in("id", send.map((r) => r.id));
  await sb.from("cp_state").upsert({ key: `move_mail:${day}`, value: String(Number(cnt?.value ?? 0) + 1), updated_at: new Date().toISOString() });
  await log("info", "movement_email_sent", { detail: { events: send.length } });
  return send.length;
}

