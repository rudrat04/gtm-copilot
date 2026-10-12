import { sb } from "./db.ts";
import { log } from "./log.ts";
import { HUNTER_MONTHLY_CAP, monthlyUsed, searchAndStore } from "./people.ts";
import { fitState, type FitState } from "./score.ts";
import { FIT_COLS } from "./firmo.ts";
import { contactsFor } from "./contacts.ts";
import { planBulkFind } from "./bulkfind.ts";
import icp from "./icp.json" with { type: "json" };

// Searches for people on the owner's behalf (before a hot alert, for the daily email, or to fix a running-dry list). It spends
// search credits, so it is deliberately stingy: only companies that fit (or that the owner follows), never one searched in the
// last 30 days, a small daily allowance, and a reserve of credits that is always left for the owner's own searches.

const DAY = 86_400_000;
export type AutoResult = "found" | "none" | "skipped" | "failed";

/** Pure: is this company worth spending a search on? Followed companies always; others only when they clearly fit. */
export const worthASearch = (fit: FitState, watched: boolean) => watched || fit === "matches";

/** Pure: how many credits may still be spent automatically this month (cap, minus the owner's reserve, minus what is used). */
export const creditsLeft = (used: number, cap: number, reserve: number) => Math.max(0, cap - reserve - used);

/** Searches already made automatically today. */
async function autoSearchesToday(): Promise<number> {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const { count } = await sb.from("cp_accounts").select("id", { count: "exact", head: true }).eq("people_search_source", "auto").gte("people_searched_at", start.toISOString());
  return count ?? 0;
}

export type AutoOpts = { ignoreDaily?: boolean; ignoreFit?: boolean };

/** One automatic search, if the rules allow it. Returns what happened so the email can say so honestly. */
export async function autoSearch(a: { id: string; domain: string }, opts: AutoOpts = {}): Promise<AutoResult & string> {
  const { data: row } = await sb.from("cp_accounts").select(`id,people_searched_at,${FIT_COLS}`).eq("id", a.id).maybeSingle();
  if (!row) return "skipped";
  if (row.people_searched_at && Date.now() - Date.parse(row.people_searched_at) < 30 * DAY) return "skipped"; // already searched recently
  if (!opts.ignoreFit && !worthASearch(fitState(row), !!row.watched_at)) return "skipped";
  if (!opts.ignoreDaily && (await autoSearchesToday()) >= icp.watch.alertSearches) return "skipped";
  if (creditsLeft(await monthlyUsed(), HUNTER_MONTHLY_CAP, icp.watch.alertReserve) <= 0) {
    await log("info", "auto_search_skipped", { account: a.domain, message: "Only the reserve is left" });
    return "skipped";
  }
  try {
    const r = await searchAndStore({ id: a.id, domain: a.domain }, { auto: true });
    await log("info", "auto_search", { account: a.domain, detail: { stored: r.stored, credits: r.credits } });
    return r.stored > 0 ? "found" : "none";
  } catch (e) {
    await log("warn", "auto_search_failed", { account: a.domain, message: (e as Error).message });
    return "failed";
  }
}

/** When was this company searched, and did it find anyone? Used for the honest line in emails. */
export async function searchStates(ids: string[]): Promise<Map<string, "none" | "searched" | "never">> {
  const out = new Map<string, "none" | "searched" | "never">();
  if (!ids.length) return out;
  const [{ data: accts }, { data: people }] = await Promise.all([
    sb.from("cp_accounts").select("id,people_searched_at").in("id", ids),
    sb.from("cp_people").select("account_id").in("account_id", ids).gte("relevance", 50),
  ]);
  const has = new Set((people ?? []).map((p) => p.account_id));
  for (const a of accts ?? []) out.set(a.id, has.has(a.id) ? "searched" : a.people_searched_at ? "none" : "never");
  return out;
}

/**
 * The "your list is running dry" fix: search the best companies that have nobody attached (at most `limit`), within the reserve,
 * and describe what was found. Spends 1 credit per company that returns people, sometimes 2. Only runs when the owner switched it on.
 */
export async function fixDryList(limit = 3): Promise<{ text: string; credits: number; searched: number }> {
  const { plan } = await planBulkFind(limit);
  const parts: string[] = [];
  let credits = 0, searched = 0;
  for (const p of plan) {
    if (creditsLeft(await monthlyUsed(), HUNTER_MONTHLY_CAP, icp.watch.alertReserve) <= 0) { parts.push(`${p.name}: not searched (only your reserve of credits is left)`); continue; }
    const before = await monthlyUsed();
    const r = await autoSearch({ id: p.id, domain: p.domain }, { ignoreDaily: true, ignoreFit: true });
    if (r === "skipped" || r === "failed") { parts.push(`${p.name}: not searched`); continue; }
    searched++;
    credits += Math.max(0, (await monthlyUsed()) - before);
    const people = (await contactsFor([p.id], true)).get(p.id) ?? [];
    parts.push(people.length ? `${p.name}: ${people.map((c) => `${c.name} (${c.title})`).join(", ")}` : `${p.name}: searched, found nobody`);
  }
  return { text: parts.join(" · "), credits, searched };
}
