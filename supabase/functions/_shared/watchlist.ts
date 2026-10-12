import { sb } from "./db.ts";
import { normalizeDomain } from "./db.ts";
import { log } from "./log.ts";
import { collectSignals, saveSiteFacts, storedHiringSignals } from "./signals.ts";
import { scoreAccount } from "./score.ts";
import { storedPlSignals } from "./predictleads.ts";
import { KIND_LABEL, MAX_WATCHED, type EventKind } from "./movements.ts";
import { fitState, heatOf } from "./score.ts";
import { FIT_COLS } from "./firmo.ts";
import { loadProfile } from "./profile.ts";

// The watchlist: companies the owner chose to follow. They skip the fit bar, get the daily signal check, first call on
// PredictLeads, and alerts of their own (see watch.ts and today.ts).

const titleCase = (s: string) => s.replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Follows or unfollows an existing company. Following also brings it back from Removed and puts it in the daily check. */
export async function setWatched(accountId: string, on: boolean): Promise<{ error: string } | { ok: true }> {
  const { data: a } = await sb.from("cp_accounts").select("id,domain,status").eq("id", accountId).maybeSingle();
  if (!a) return { error: "Account not found" };
  if (on) {
    const { count } = await sb.from("cp_accounts").select("id", { count: "exact", head: true }).not("watched_at", "is", null).is("removed_at", null);
    const { data: already } = await sb.from("cp_accounts").select("watched_at").eq("id", accountId).maybeSingle();
    if (!already?.watched_at && (count ?? 0) >= MAX_WATCHED.companies) return { error: "You can follow up to 40 companies. Unfollow one first." };
  }
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

// ---- People, notify settings and the Watchlist tab ----

/** Follows or unfollows a person we already know. Limited to MAX_WATCHED.people. */
export async function setPersonWatched(personId: string, on: boolean): Promise<{ error: string } | { ok: true }> {
  const { data: p } = await sb.from("cp_people").select("id,account_id").eq("id", personId).maybeSingle();
  if (!p) return { error: "Person not found" };
  if (on) {
    const { count } = await sb.from("cp_people").select("id", { count: "exact", head: true }).not("watched_at", "is", null);
    if ((count ?? 0) >= MAX_WATCHED.people) return { error: `You can follow up to ${MAX_WATCHED.people} people. Unfollow someone first.` };
  }
  await sb.from("cp_people").update({ watched_at: on ? new Date().toISOString() : null }).eq("id", personId);
  return { ok: true };
}

/** Adds a person we do not have yet (a name, a company website and optionally a title); no email, no credits. */
export async function addPersonToWatchlist(input: { name: string; domain: string; title?: string }): Promise<{ error: string } | { id: string; name: string }> {
  const name = input.name.trim().replace(/\s+/g, " ");
  const [first, ...rest] = name.split(" ");
  if (!first || !rest.length) return { error: "Enter their first and last name." };
  const co = await addToWatchlist(input.domain);
  if ("error" in co) return co;
  const { data: have } = await sb.from("cp_people").select("id").eq("account_id", co.id).ilike("first_name", first).ilike("last_name", rest.join(" ")).maybeSingle();
  let id = have?.id as string | undefined;
  if (!id) {
    const ins = await sb.from("cp_people").insert({ account_id: co.id, provider: "manual", first_name: first, last_name: rest.join(" "), title: (input.title ?? "").slice(0, 80) || "Unknown title", relevance: 0, seniority: "ic" }).select("id").single();
    if (ins.error || !ins.data) return { error: "Could not add that person." };
    id = ins.data.id;
  }
  const r = await setPersonWatched(id!, true);
  return "error" in r ? r : { id: id!, name };
}

export async function setNotify(kind: "company" | "person", id: string, notify: string): Promise<boolean> {
  if (!["instant", "daily", "off"].includes(notify)) return false;
  const { error } = await sb.from(kind === "company" ? "cp_accounts" : "cp_people").update({ watch_notify: notify }).eq("id", id);
  return !error;
}

export async function markSeen(): Promise<void> {
  await sb.from("cp_watch_events").update({ seen_at: new Date().toISOString() }).is("seen_at", null);
}

/** Everything the Watchlist tab shows. Public viewers get companies and movements; people are shown as "First L.". */
export async function watchlistView(admin: boolean) {
  const [{ data: accts }, { data: ppl }, { data: ev }] = await Promise.all([
    sb.from("cp_accounts").select(`id,name,domain,priority_score,watch_notify,watched_at,outreach_status,${FIT_COLS}`).not("watched_at", "is", null).is("removed_at", null).order("watched_at", { ascending: false }),
    sb.from("cp_people").select("id,account_id,first_name,last_name,title,persona,watch_notify,watched_at").not("watched_at", "is", null).order("watched_at", { ascending: false }),
    sb.from("cp_watch_events").select("id,kind,importance,title,url,account_id,person_id,subject,detected_at,seen_at").order("detected_at", { ascending: false }).limit(80),
  ]);
  const ids = [...new Set([...(ppl ?? []).map((p) => p.account_id), ...(ev ?? []).map((e) => e.account_id).filter(Boolean) as string[]])];
  const known = new Map((accts ?? []).map((a) => [a.id, a]));
  const missing = ids.filter((i) => !known.has(i));
  const { data: more } = missing.length ? await sb.from("cp_accounts").select("id,name,domain").in("id", missing) : { data: [] };
  const nameOf = new Map<string, { name: string; domain: string }>([...(accts ?? []).map((a) => [a.id, { name: a.name, domain: a.domain }] as const), ...(more ?? []).map((a) => [a.id, { name: a.name, domain: a.domain }] as const)]);
  const pname = (p: { first_name: string; last_name: string }) => (admin ? `${p.first_name} ${p.last_name}`.trim() : `${p.first_name} ${(p.last_name || "").charAt(0)}.`.trim());
  const pById = new Map((ppl ?? []).map((p) => [p.id, p]));
  const last = (pred: (e: NonNullable<typeof ev>[number]) => boolean) => (ev ?? []).find(pred);
  const sigs = (accts ?? []).length ? (await sb.from("cp_signals").select("account_id,kind,title,detail,detected_at").in("account_id", (accts ?? []).map((a) => a.id))).data ?? [] : [];
  return {
    unseen: (ev ?? []).filter((e) => !e.seen_at).length,
    limits: MAX_WATCHED,
    competitors: (await loadProfile()).competitors,
    events: (ev ?? []).map((e) => ({
      id: e.id, kind: e.kind, label: KIND_LABEL[e.kind as EventKind] ?? e.kind, importance: e.importance, title: e.title, url: e.url, detected_at: e.detected_at, unseen: !e.seen_at,
      who: e.account_id ? nameOf.get(e.account_id)?.name ?? "" : e.subject ?? "Competitor", company_id: e.account_id,
      person: e.person_id && pById.get(e.person_id) ? pname(pById.get(e.person_id)!) : null,
    })),
    companies: (accts ?? []).map((a) => {
      const l = last((e) => e.account_id === a.id && !e.person_id);
      return { id: a.id, name: a.name, domain: a.domain, notify: a.watch_notify, fit: fitState(a), heat: heatOf(sigs.filter((s) => s.account_id === a.id) as never, fitState(a)), last: l ? { label: KIND_LABEL[l.kind as EventKind] ?? l.kind, title: l.title, detected_at: l.detected_at } : null, unseen: (ev ?? []).filter((e) => e.account_id === a.id && !e.seen_at).length };
    }),
    people: (ppl ?? []).map((p) => {
      const l = last((e) => e.person_id === p.id);
      return { id: p.id, name: pname(p), title: p.title, persona: p.persona, company: nameOf.get(p.account_id)?.name ?? "", notify: p.watch_notify, last: l ? { label: KIND_LABEL[l.kind as EventKind] ?? l.kind, title: l.title, detected_at: l.detected_at } : null, unseen: (ev ?? []).filter((e) => e.person_id === p.id && !e.seen_at).length };
    }),
  };
}
