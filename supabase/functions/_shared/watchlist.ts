import { sb } from "./db.ts";
import { normalizeDomain } from "./db.ts";
import { log } from "./log.ts";
import { collectSignals, saveSiteFacts, storedHiringSignals } from "./signals.ts";
import { scoreAccount } from "./score.ts";
import { storedPlSignals } from "./predictleads.ts";

// The watchlist: companies the owner chose to follow. They skip the fit bar, get the daily signal check, first call on
// PredictLeads, and alerts of their own (see watch.ts and today.ts).

const titleCase = (s: string) => s.replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Follows or unfollows an existing company. Following also brings it back from Removed and puts it in the daily check. */
export async function setWatched(accountId: string, on: boolean): Promise<{ error: string } | { ok: true }> {
  const { data: a } = await sb.from("cp_accounts").select("id,domain,status").eq("id", accountId).maybeSingle();
  if (!a) return { error: "Account not found" };
  const upd: Record<string, unknown> = { watched_at: on ? new Date().toISOString() : null };
  if (on) { upd.removed_at = null; if (a.status === "new") upd.status = "queued"; }
  await sb.from("cp_accounts").update(upd).eq("id", accountId);
  await log("info", on ? "watch_added" : "watch_removed", { account: a.domain });
  return { ok: true };
}

/** Adds a company by website (or follows it if we already know it), then reads its public signals once, free. */
export async function addToWatchlist(input: string): Promise<{ error: string } | { id: string; name: string; domain: string; created: boolean; signals: number }> {
  const domain = normalizeDomain(input);
  if (!domain) return { error: "That does not look like a website. Try something like example.com." };
  const { data: known } = await sb.from("cp_accounts").select("id,name,domain").eq("domain", domain).maybeSingle();
  if (known) {
    const r = await setWatched(known.id, true);
    return "error" in r ? r : { id: known.id, name: known.name, domain, created: false, signals: 0 };
  }
  const guess = titleCase(domain.split(".")[0]);
  const ins = await sb.from("cp_accounts").insert({ domain, name: guess, source: "watchlist", status: "queued", watched_at: new Date().toISOString() }).select("id,name,domain").single();
  if (ins.error || !ins.data) return { error: "Could not add that company." };
  const a = ins.data;
  let count = 0;
  try {
    const { site, signals, hiringUnknown, motion, jobTools } = await collectSignals(a.name, domain, "");
    const title = site?.title.split(/\s[|–—:-]\s|[|–—]/)[0].trim() ?? "";
    if (title.length >= 2 && title.length <= 40) await sb.from("cp_accounts").update({ name: title }).eq("id", a.id);
    await saveSiteFacts(a.id, { motion, jobTools });
    if (signals.length) await sb.from("cp_signals").upsert(signals.map((s) => ({ account_id: a.id, kind: s.kind, title: s.title.slice(0, 300), url: s.url, detail: s.detail ?? {} })), { onConflict: "account_id,kind,title", ignoreDuplicates: true });
    const { data: row } = await sb.from("cp_accounts").select("*").eq("id", a.id).single();
    const score = scoreAccount([...signals, ...(await storedPlSignals(a.id)), ...(hiringUnknown ? await storedHiringSignals(a.id) : [])], row ?? {}).score;
    await sb.from("cp_accounts").update({ priority_score: score, last_scanned_at: new Date().toISOString() }).eq("id", a.id);
    count = signals.length;
  } catch (e) {
    await log("warn", "watchlist_first_check_failed", { account: domain, message: (e as Error).message });
  }
  await log("info", "watch_added", { account: domain, detail: { created: true, signals: count } });
  return { id: a.id, name: a.name, domain, created: true, signals: count };
}
