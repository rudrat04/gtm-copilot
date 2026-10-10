import { json, sb } from "./db.ts";
import { log } from "./log.ts";
import { collectSignals, type Signal } from "./signals.ts";
import { priorityScore, tierOf } from "./score.ts";
import { generateWhy, hash } from "./today.ts";
import { alertEmail } from "./templates.ts";
import { googleConfigured, ownerEmail, sendMail } from "./google.ts";
import icp from "./icp.json" with { type: "json" };

const BATCH = 5;
const MAX_ACCOUNTS = 20;

async function state(key: string) {
  const { data } = await sb.from("cp_state").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
const setState = (key: string, value: string) => sb.from("cp_state").upsert({ key, value, updated_at: new Date().toISOString() });

type Acct = { id: string; name: string; domain: string; segment: string | null; priority_score: number | null; outreach_status: string; hubspot_company_id: string | null };

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
    .select("id,name,domain,segment,priority_score,outreach_status,hubspot_company_id")
    .in("status", ["queued", "pushed"]).in("outreach_status", ["open", "contacted", "snoozed"])
    .order("priority_score", { ascending: false }).limit(MAX_ACCOUNTS);
  const accounts = (data ?? []) as Acct[];

  const candidates: { a: Acct; top: Signal; score: number; hash: string; fresh: number }[] = [];
  let newSignals = 0, failed = 0;

  const one = async (a: Acct) => {
    const { data: existing } = await sb.from("cp_signals").select("kind,title").eq("account_id", a.id);
    const known = new Set((existing ?? []).map((e) => `${e.kind}|${e.title}`));
    const { signals } = await collectSignals(a.name, a.domain, a.segment ?? "");
    const fresh = signals.filter((s) => !known.has(`${s.kind}|${s.title.slice(0, 300)}`));

    if (fresh.length) {
      await sb.from("cp_signals").upsert(
        fresh.map((s) => ({ account_id: a.id, kind: s.kind, title: s.title.slice(0, 300), url: s.url, detail: s.detail ?? {} })),
        { onConflict: "account_id,kind,title", ignoreDuplicates: true },
      );
      newSignals += fresh.length;
    }
    const score = priorityScore(signals).score;
    if (score !== a.priority_score) await sb.from("cp_accounts").update({ priority_score: score }).eq("id", a.id);

    // Alert-worthy: new news, or a newly posted individual role. Hacker News alone and role-count changes are not.
    const worthy = fresh.filter((s) => s.kind === "news" || (s.kind === "hiring" && !(s.detail && "salesOpenings" in s.detail)));
    if (worthy.length && a.outreach_status === "open" && tierOf(score) !== "tier_3") {
      candidates.push({ a, top: worthy[0], score, hash: hash(worthy.map((w) => w.title).sort().join("|")), fresh: worthy.length });
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
  if (candidates.length && googleConfigured()) {
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const { count } = await sb.from("cp_alerts").select("account_id", { count: "exact", head: true }).gte("sent_at", dayStart.toISOString());
    let budget = Math.max(0, icp.alerts.maxPerDay - (count ?? 0));
    for (const c of candidates.sort((x, y) => y.score - x.score)) {
      if (budget <= 0) break;
      const { error } = await sb.from("cp_alerts").insert({ account_id: c.a.id, signal_hash: c.hash });
      if (error) continue; // already alerted for these signals
      const { data: sigs } = await sb.from("cp_signals").select("kind,title,detail,detected_at").eq("account_id", c.a.id).order("detected_at", { ascending: false }).limit(5);
      const why = (await generateWhy({
        name: c.a.name, tier: tierOf(c.score), type: "hot", touches: 0, lastAction: null,
        sigs: (sigs ?? []).map((s) => ({ ...s, account_id: c.a.id, url: null })) as never,
      })) ?? `New signal: ${c.top.title.slice(0, 100)}`;
      const { data: p } = await sb.from("cp_people").select("first_name,last_name,title").eq("account_id", c.a.id).gt("relevance", 0)
        .order("relevance", { ascending: false }).limit(1).maybeSingle();
      const mail = alertEmail(
        { name: c.a.name, tier: tierOf(c.score), domain: c.a.domain },
        { title: c.top.title, published: (c.top.detail as { published?: string } | undefined)?.published },
        why, p ? { name: `${p.first_name} ${p.last_name}`.trim(), title: p.title } : null, c.a.hubspot_company_id ?? undefined,
      );
      try {
        await sendMail(ownerEmail(), mail.subject, mail.body);
        alerted++; budget--;
        await log("info", "hot_alert_sent", { account: c.a.domain, detail: { fresh: c.fresh, score: c.score } });
      } catch (e) {
        await sb.from("cp_alerts").delete().eq("account_id", c.a.id).eq("signal_hash", c.hash); // retry next run
        await log("error", "hot_alert_failed", { account: c.a.domain, message: (e as Error).message });
      }
    }
  }

  await log("info", "watch_done", { detail: { accounts: accounts.length, new_signals: newSignals, candidates: candidates.length, alerted, failed } });
  return json({ accounts: accounts.length, new_signals: newSignals, alert_candidates: candidates.length, alerted, failed });
}
