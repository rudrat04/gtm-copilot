import { json, sb } from "./db.ts";
import { log } from "./log.ts";
import { collectSignals, eventSignals, saveSiteFacts, type Signal, storedHiringSignals } from "./signals.ts";
import { competitorEvents, eventsFromSignals, hubspotVisits, marketSignals, personMentions, recordEvent, sendMovementEmail, titleRecheck, watchedPeopleHubspot } from "./movements.ts";
import { scoreAccount, tierOf } from "./score.ts";
import { generateWhy, hash, strongest } from "./today.ts";
import { alertEmail } from "./templates.ts";
import { googleConfigured, ownerEmail, sendMail } from "./google.ts";
import { firmoLine } from "./firmo.ts";
import { contactsFor } from "./contacts.ts";
import { autoSearch, searchStates } from "./autosearch.ts";
import { aiMaps, aiRefresh, aiScoreCompany } from "./aiscore.ts";
import { industryCheckMany, needIndustry } from "./industry.ts";
import { fitState } from "./score.ts";
import { autoRefreshPredictLeads, storedPlSignals } from "./predictleads.ts";
import icp from "./icp.json" with { type: "json" };

const BATCH = 5;
const WATCHLIST_ALERTS_PER_DAY = 5; // instant alerts a day for followed companies, on top of icp.alerts.maxPerDay for the rest
const MAX_ACCOUNTS = 20;

async function state(key: string) {
  const { data } = await sb.from("cp_state").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
const setState = (key: string, value: string) => sb.from("cp_state").upsert({ key, value, updated_at: new Date().toISOString() });

type Acct = { watched_at: string | null; id: string; name: string; domain: string; segment: string | null; priority_score: number | null; outreach_status: string; hubspot_company_id: string | null; employees: number | null; stage: string | null; country: string | null; firmo_at: string | null };

/**
 * Daily light check. Re-reads public sources for accounts already in the Queue, stores only what is new
 * (so "first seen" stays honest), refreshes the priority score, and sends an instant alert when an
 * account you have not contacted shows a fresh hiring or news signal. No drafts are rewritten here.
 */
export async function lightCheck(admin: boolean) {
  const last = await state("watch_last");
  if (!admin && last && Date.now() - Date.parse(last) < 20 * 3_600_000) {
    const r = json({ skipped: "ran recently" });
    r.headers.set("x-noop", "1");
    return r;
  }
  await setState("watch_last", new Date().toISOString());

  const { data } = await sb.from("cp_accounts")
    .select("id,name,domain,segment,priority_score,outreach_status,hubspot_company_id,employees,stage,country,firmo_at,tech,industry,tags,blurb,sales_motion,known_as,last_round_date,industry_ai,watched_at")
    .is("removed_at", null).in("status", ["queued", "pushed"]).in("outreach_status", ["open", "contacted", "snoozed"])
    .order("watched_at", { ascending: false, nullsFirst: false }).order("priority_score", { ascending: false }).limit(MAX_ACCOUNTS); // followed companies are always checked first
  const accounts = (data ?? []) as Acct[];
  const aiBy = await aiMaps("company", accounts.map((a) => a.id)).catch(() => new Map()); // the AI's last judgement of each company
  const pl = await autoRefreshPredictLeads(2).catch(() => ({ checked: 0, added: 0 })); // a couple of the best accounts a day, within the monthly allowance

  const candidates: { a: Acct; top: Signal; score: number; hash: string; fresh: number }[] = [];
  let newSignals = 0, failed = 0;

  const one = async (a: Acct) => {
    const { data: existing } = await sb.from("cp_signals").select("kind,title").eq("account_id", a.id);
    const known = new Set((existing ?? []).map((e) => `${e.kind}|${e.title}`));
    const col = await collectSignals(a.name, a.domain, a.segment ?? "");
    const { hiringUnknown, motion, jobTools } = col;
    const signals = [...col.signals, ...(a.watched_at ? await eventSignals(a.name, a.domain).catch(() => [] as Signal[]) : [])]; // followed companies are also checked for events they host
    await saveSiteFacts(a.id, { motion, jobTools });
    const fresh = signals.filter((s) => !known.has(`${s.kind}|${s.title.slice(0, 300)}`));

    if (fresh.length) {
      await sb.from("cp_signals").upsert(
        fresh.map((s) => ({ account_id: a.id, kind: s.kind, title: s.title.slice(0, 300), url: s.url, detail: s.detail ?? {} })),
        { onConflict: "account_id,kind,title", ignoreDuplicates: true },
      );
      newSignals += fresh.length;
    }
    if (a.watched_at) for (const ev of eventsFromSignals(a, fresh)) await recordEvent(ev); // every movement on a followed company is kept for the Watchlist tab
    const score = scoreAccount([...signals, ...(await storedPlSignals(a.id)), ...(hiringUnknown ? await storedHiringSignals(a.id) : [])], a).score; // PredictLeads events stored earlier still count
    if (score !== a.priority_score) await sb.from("cp_accounts").update({ priority_score: score }).eq("id", a.id);

    // Alert-worthy: new news, or a newly posted individual role. Hacker News alone and role-count changes are not.
    const worthy = fresh.filter((s) => s.kind === "news" || (s.kind === "hiring" && !(s.detail && "salesOpenings" in s.detail)) || (s.kind === "tech" && ["visit", "change"].includes(String(s.detail?.ruleType)))); // a tool change on their website or a visit to yours counts too
    if (worthy.length && a.outreach_status === "open" && (a.watched_at || tierOf(score) !== "tier_3" || aiBy.get(a.id)?.label === "hot")) { // a followed company is alert-worthy at any score, and so is one the AI calls hot
      candidates.push({ a, top: (strongest(worthy.map((w) => ({ ...w, account_id: a.id, url: w.url ?? null, detail: w.detail ?? null, detected_at: new Date().toISOString() })) as never) as unknown as Signal | null) ?? worthy[0], score, hash: hash(worthy.map((w) => w.title).sort().join("|")), fresh: worthy.length });
    }
    await log("info", "account_watched", { account: a.domain, detail: { new: fresh.length, score, alert_candidate: worthy.length > 0 } });
  };

  for (let i = 0; i < accounts.length; i += BATCH) {
    const results = await Promise.allSettled(accounts.slice(i, i + BATCH).map(one));
    results.forEach((r, k) => {
      if (r.status === "rejected") {
        failed++;
        void log("error", "account_watch_failed", { account: accounts[i + k].domain, message: String(r.reason).slice(0, 200) });
      }
    });
  }

  // Instant alerts, best first, capped per day, never repeated for the same signals.
  let alerted = 0;
  const alertedIds: string[] = [];
  if (candidates.length && googleConfigured()) {
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    // Followed companies have an allowance of their own, so a busy day on the watchlist cannot crowd out the rest (or the other way round).
    const { data: sentToday } = await sb.from("cp_alerts").select("account_id").eq("deferred", false).gte("sent_at", dayStart.toISOString());
    const { data: followed } = sentToday?.length ? await sb.from("cp_accounts").select("id").in("id", sentToday.map((r) => r.account_id)).not("watched_at", "is", null) : { data: [] };
    const followedIds = new Set((followed ?? []).map((r) => r.id));
    const left = { followed: icp.watch.watchlistAlerts === false ? 0 : Math.max(0, WATCHLIST_ALERTS_PER_DAY - followedIds.size), other: Math.max(0, icp.alerts.maxPerDay - ((sentToday?.length ?? 0) - followedIds.size)) };
    for (const c of candidates.sort((x, y) => (Number(!!y.a.watched_at) - Number(!!x.a.watched_at)) || (Number(aiBy.get(y.a.id)?.label === "hot") - Number(aiBy.get(x.a.id)?.label === "hot")) || (y.score - x.score))) {
      const lane = c.a.watched_at ? "followed" : "other";
      if (left[lane] <= 0) continue;
      const { data: seen } = await sb.from("cp_alerts").select("account_id").eq("account_id", c.a.id).eq("signal_hash", c.hash).maybeSingle();
      if (seen) continue; // already alerted (or held back) for these signals
      // Let the AI judge it on the fresh facts first. A company it calls cold waits for the daily email; one it calls hot is never held back.
      await aiScoreCompany(c.a.id).catch(() => null);
      const verdict = (await aiMaps("company", [c.a.id]).catch(() => new Map())).get(c.a.id)?.label as string | undefined;
      if (verdict === "cold" && !c.a.watched_at) {
        await sb.from("cp_alerts").insert({ account_id: c.a.id, signal_hash: c.hash, deferred: true });
        await log("info", "hot_alert_held_back", { account: c.a.domain, detail: { score: c.score, ai: "cold" } });
        continue;
      }
      // Find people first, so the email names them. This spends search credits, so it only runs for companies that fit or that you follow.
      await autoSearch({ id: c.a.id, domain: c.a.domain });
      const contacts = (await contactsFor([c.a.id], true)).get(c.a.id) ?? [];
      const fits = fitState(c.a as never) === "matches";
      if (!c.a.watched_at && !contacts.length && !fits && verdict !== "hot") {
        // A weak alert: no fit and nobody to contact. It waits for the daily email instead of interrupting you.
        await sb.from("cp_alerts").insert({ account_id: c.a.id, signal_hash: c.hash, deferred: true });
        await log("info", "hot_alert_held_back", { account: c.a.domain, detail: { score: c.score } });
        continue;
      }
      const { error } = await sb.from("cp_alerts").insert({ account_id: c.a.id, signal_hash: c.hash });
      if (error) continue;
      const searchState = (await searchStates([c.a.id])).get(c.a.id) ?? "never";
      const { data: sigs } = await sb.from("cp_signals").select("kind,title,detail,detected_at").eq("account_id", c.a.id).order("detected_at", { ascending: false }).limit(5);
      const why = (await generateWhy({
        name: c.a.name, tier: tierOf(c.score), type: "hot", touches: 0, lastAction: null,
        sigs: (sigs ?? []).map((s) => ({ ...s, account_id: c.a.id, url: null })) as never,
      })) ?? `New signal: ${c.top.title.slice(0, 100)}`;
      const { data: firm } = await sb.from("cp_accounts").select("employees,employee_band,stage,raised_usd,hq_city,country,firmo_at").eq("id", c.a.id).single();
      const mail = alertEmail(
        { name: c.a.name, tier: tierOf(c.score), domain: c.a.domain, firmo: firm ? firmoLine(firm) : "", watched: !!c.a.watched_at },
        { title: c.top.title, published: (c.top.detail as { published?: string } | undefined)?.published },
        why, contacts, c.a.hubspot_company_id ?? undefined, searchState,
      );
      try {
        await sendMail(ownerEmail(), mail.subject, mail.body, mail.html);
        alerted++; left[lane]--; alertedIds.push(c.a.id);
        await log("info", "hot_alert_sent", { account: c.a.domain, detail: { fresh: c.fresh, score: c.score } });
      } catch (e) {
        await sb.from("cp_alerts").delete().eq("account_id", c.a.id).eq("signal_hash", c.hash); // retry next run
        await log("error", "hot_alert_failed", { account: c.a.domain, message: (e as Error).message });
      }
    }
  }

  // Movements on the Watchlist: events a hot alert already covered are marked as sent; then the other checks and one grouped email.
  const moved = { competitor: 0, market: 0, visits: 0, mentions: 0, contacts: 0, jobs: 0, emailed: 0 };
  try {
    if (alertedIds.length) await sb.from("cp_watch_events").update({ emailed_at: new Date().toISOString() }).in("account_id", alertedIds).is("emailed_at", null);
    moved.competitor = await competitorEvents();
    moved.market = await marketSignals();
    moved.visits = await hubspotVisits();
    moved.mentions = await personMentions(8);
    moved.contacts = await watchedPeopleHubspot();
    moved.jobs = await titleRecheck(2);
    moved.emailed = await sendMovementEmail();
  } catch (e) { await log("warn", "movements_failed", { message: (e as Error).message }); }

  // Judge the companies whose facts changed (and the people at them), and read the industry of a few new ones from their websites.
  const judged = { companies: 0, people: 0, industries: 0 };
  try {
    const r = await aiRefresh({ maxCompanies: 30, maxPeopleCompanies: 10 });
    judged.companies = r.companies; judged.people = r.people;
    judged.industries = (await industryCheckMany(await needIndustry(8))).set;
  } catch (e) { await log("warn", "ai_refresh_failed", { message: (e as Error).message }); }

  await log("info", "watch_done", { detail: { accounts: accounts.length, new_signals: newSignals, candidates: candidates.length, alerted, failed, predictleads: pl } });
  return json({ accounts: accounts.length, new_signals: newSignals, alert_candidates: candidates.length, alerted, failed, predictleads: pl, movements: moved, ai: judged });
}
