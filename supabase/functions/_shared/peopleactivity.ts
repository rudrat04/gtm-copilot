import { sb } from "./db.ts";
import { log } from "./log.ts";
import { askClaude, BudgetError, parseJson } from "./claude.ts";
import { recordEvent } from "./movements.ts";
import { hashStr } from "./movements.ts";
import { teamSignals } from "./peoplesignals.ts";
import icp from "./icp.json" with { type: "json" };

// What the people you follow are doing: events and talks they join or speak at, podcasts, posts, awards, job moves, and what is happening
// in their own team. Two sources: (1) the model searches the public web for the person by full name (about 5 cents a person, so only
// a couple of people a day, each at most every two weeks), and (2) the company's fresh signals that concern their department (free).

export type Activity = { kind: string; title: string; date?: string; place?: string; url?: string; upcoming?: boolean };

/** Pure: keeps usable items from the model's answer. */
export function cleanActivity(raw: unknown): Activity[] {
  const items = (raw as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: Activity[] = [];
  for (const i of items as Record<string, unknown>[]) {
    const title = String(i.title ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (title.length < 8) continue;
    const url = String(i.url ?? "");
    out.push({ kind: ["event", "talk", "post", "podcast", "award", "move", "team"].includes(String(i.kind)) ? String(i.kind) : "event", title, date: String(i.date ?? "").slice(0, 30) || undefined, place: String(i.place ?? "").slice(0, 60) || undefined, url: /^https?:\/\//.test(url) ? url.slice(0, 300) : undefined, upcoming: i.upcoming === true });
  }
  return out.slice(0, 4);
}

/** Pure: the one line shown for an item. */
/** When did it happen? "2024-06-18" and "2025-04" are read; a bare past year is old news; anything unreadable is judged by when we found it. */
export function whenOf(date: string | undefined, now = new Date()): { ok: boolean; at: string | null } {
  const d = (date ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (m) return { ok: true, at: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toISOString() };
  m = /^(\d{4})-(\d{2})$/.exec(d);
  if (m) return { ok: true, at: new Date(Date.UTC(+m[1], +m[2] - 1, 15, 12)).toISOString() };
  m = /^(\d{4})$/.exec(d);
  if (m) return +m[1] < now.getUTCFullYear() ? { ok: false, at: null } : { ok: true, at: null };
  return { ok: true, at: null };
}
export const activityLine = (a: Activity) => [a.title, a.place, a.date].filter(Boolean).join(" · ");

/** Looks up a few followed people on the web. Spends AI (about 5 cents each), never more than `activityPerDay` people a day. */
export async function personActivity(limit = (icp.watch as { activityPerDay?: number }).activityPerDay ?? 2, onlyId?: string): Promise<number> {
  if (limit <= 0 && !onlyId) return 0;
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  let people;
  if (onlyId) { // "Check now": one person, whatever the daily allowance
    people = (await sb.from("cp_people").select("id,first_name,last_name,title,account_id,watch_notify").eq("id", onlyId).eq("preview", false)).data;
  } else {
    const { count: today } = await sb.from("cp_people").select("id", { count: "exact", head: true }).gte("activity_checked_at", dayStart.toISOString());
    const left = limit - (today ?? 0);
    if (left <= 0) return 0;
    people = (await sb.from("cp_people").select("id,first_name,last_name,title,account_id,watch_notify").not("watched_at", "is", null).eq("preview", false).neq("watch_notify", "off")
      .or(`activity_checked_at.is.null,activity_checked_at.lt.${since}`).order("activity_checked_at", { ascending: true, nullsFirst: true }).limit(left)).data;
  }
  if (!people?.length) return 0;
  const { data: accts } = await sb.from("cp_accounts").select("id,name,domain").in("id", people.map((p) => p.account_id));
  const co = new Map((accts ?? []).map((a) => [a.id, a]));
  let n = 0;
  for (const p of people) {
    const a = co.get(p.account_id);
    if (!a || (p.last_name ?? "").length < 2) continue;
    const full = `${p.first_name} ${p.last_name}`.trim();
    try {
      const raw = await askClaude({
        feature: "person_activity", maxTokens: 900,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
        system: "You research one named business contact using web search, for a sales rep who wants a real reason to reach out. Only report things you actually found in search results about THIS person at THIS company (ignore namesakes), from the last 120 days or upcoming. Never guess. Return one JSON object and nothing else.",
        user: `Person: ${full}, ${p.title} at ${a.name} (${a.domain}).\nFind their recent or upcoming public activity: events or conferences they speak at or attend (include city and month), podcasts or interviews, articles or posts they wrote, awards, a job move, or something their team announced.\nJSON: {"items":[{"kind":"event"|"talk"|"post"|"podcast"|"award"|"move"|"team","title":"one plain sentence","date":"YYYY-MM-DD or month","place":"city or online","url":"https://...","upcoming":true|false}]}. Use {"items":[]} if you found nothing.`,
      });
      let parsed: unknown = null;
      try { parsed = parseJson(raw); } catch { /* nothing found */ }
      for (const it of cleanActivity(parsed)) {
        const w = whenOf(it.date);
        if (!w.ok) continue;
        if (await recordEvent({ at: w.at, key: `activity:${p.id}:${hashStr(it.title)}`, kind: "activity", importance: it.upcoming ? "big" : "small", accountId: p.account_id, personId: p.id, subject: full, title: activityLine(it), url: it.url ?? null })) n++;
      }
      await log("info", "person_activity", { account: a.domain, detail: { found: cleanActivity(parsed).length } });
    } catch (e) {
      if (e instanceof BudgetError) break;
      await log("warn", "person_activity_failed", { account: a.domain, message: (e as Error).message });
    }
    await sb.from("cp_people").update({ activity_checked_at: new Date().toISOString() }).eq("id", p.id);
  }
  return n;
}

/** Free: a fresh company signal that concerns a followed person's own department becomes a movement for that person. */
export async function teamEvents(accountId: string, fresh: { kind: string; title: string; detail?: Record<string, unknown> | null }[]): Promise<number> {
  if (!fresh.length) return 0;
  const { data: people } = await sb.from("cp_people").select("id,first_name,last_name,title,department,watch_notify").eq("account_id", accountId).not("watched_at", "is", null).eq("preview", false).neq("watch_notify", "off");
  let n = 0;
  for (const p of people ?? []) {
    for (const line of teamSignals(p.department, p.title, fresh.map((f) => ({ ...f, detected_at: new Date().toISOString() })), 2)) {
      if (await recordEvent({ key: `team:${p.id}:${hashStr(line)}`, kind: "team", importance: /hiring|sales roles/i.test(line) ? "small" : "big", accountId, personId: p.id, subject: `${p.first_name} ${p.last_name}`.trim(), title: line })) n++;
    }
  }
  return n;
}
