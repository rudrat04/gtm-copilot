import { sb } from "./db.ts";
import { log } from "./log.ts";
import { createTask, readCompanies } from "./hubspot.ts";
import { fitState, heatOf } from "./score.ts";
import { worthShowing } from "./fitgate.ts";
import { endsAt } from "./debrief.ts";
import { healthView } from "./health.ts";
import { fixDryList } from "./autosearch.ts";
import { planBulkFind } from "./bulkfind.ts";
import icp from "./icp.json" with { type: "json" };

// Pipeline watch. Looks for things that are off (a hot account nobody touched, a late follow-up, a lead past its reply
// target, a meeting with no debrief, a stuck deal, drift between us and HubSpot) and remembers each one in cp_flags so
// it fires once, can be snoozed or dismissed, and clears itself when the cause goes away. Nothing is sent to a prospect.

const H = 3_600_000;
const DAY = 24 * H;

export type FlagKind =
  | "hot_untouched" | "followup_overdue" | "lead_past_target" | "meeting_no_debrief" | "replied_no_next"
  | "deal_stuck" | "thin_pipeline" | "mismatch" | "drift" | "system";
export type Candidate = { key: string; kind: FlagKind; severity: "urgent" | "normal"; accountId: string | null; title: string; detail: string; since: string };

/** Only these create a HubSpot to-do, and only these run in the 3-hourly pass. */
export const URGENT_KINDS: FlagKind[] = ["hot_untouched", "lead_past_target"];

// ---- The rules, pure so they can be tested ----

type A = {
  id: string; name: string; outreach_status: string; next_followup_at: string | null; last_touch_at: string | null;
  hubspot_deal_id: string | null; deal_stage: string | null;
};
const ago = (iso: string | null, now: number) => (iso ? now - Date.parse(iso) : 0);

export const hotUntouched = (a: Pick<A, "outreach_status">, hasContact: boolean, heat: string, newestSignalMs: number, now: number, hours: number) =>
  a.outreach_status === "open" && hasContact && heat === "hot" && newestSignalMs > 0 && now - newestSignalMs > hours * H;

export const followupOverdue = (a: Pick<A, "outreach_status" | "next_followup_at">, now: number, days: number) =>
  a.outreach_status === "contacted" && !!a.next_followup_at && ago(a.next_followup_at, now) > days * DAY;

export const repliedStale = (a: Pick<A, "outreach_status" | "last_touch_at">, now: number, days: number) =>
  a.outreach_status === "replied" && !!a.last_touch_at && ago(a.last_touch_at, now) > days * DAY;

export const meetingStale = (m: { status: string; outcome: string | null; starts_at: string; ends_at: string | null }, now: number, days: number) => {
  const end = endsAt(m);
  return m.status === "briefed" && !m.outcome && now - end > days * DAY && now - end < 21 * DAY;
};

export const leadLate = (l: { status: string; label: string | null; alerted_at: string | null; created_at: string }, now: number, slaMinutes: number, extraMinutes: number) =>
  l.status === "new" && ["hot", "warm", "review"].includes(l.label ?? "") && !!l.alerted_at && now - Date.parse(l.created_at) < DAY &&
  ago(l.alerted_at, now) > (slaMinutes + extraMinutes) * 60_000;

export const dealStuck = (a: Pick<A, "hubspot_deal_id" | "deal_stage">, lastActivityMs: number, now: number, days: number) =>
  !!a.hubspot_deal_id && !["closedwon", "closedlost"].includes(a.deal_stage ?? "") && lastActivityMs > 0 && now - lastActivityMs > days * DAY;

export const thinPipeline = (readyWithContact: number, min: number) => readyWithContact < min;

// ---- Gathering the facts ----

const ACCT = "id,name,domain,source,status,outreach_status,next_followup_at,last_touch_at,contacted_at,hubspot_company_id,hubspot_deal_id,deal_stage,priority_score,employees,stage,country,firmo_at,light_source,employee_band,tech,industry,tags,blurb,sales_motion,known_as,last_round_date,industry_ai,lost_at,won_at,watched_at";

export async function collect(mode: "daily" | "urgent"): Promise<Candidate[]> {
  const now = Date.now();
  const w = icp.watch;
  const on = (k: string) => w.checks[k as keyof typeof w.checks]?.on !== false;
  const n = (k: string) => w.checks[k as keyof typeof w.checks]?.n ?? 0;
  const out: Candidate[] = [];
  const add = (c: Omit<Candidate, "key"> & { extra?: string }) => out.push({ ...c, key: `${c.kind}:${c.accountId ?? "-"}${c.extra ? `:${c.extra}` : ""}` });

  const { data: all } = await sb.from("cp_accounts").select(ACCT).is("removed_at", null).or("status.in.(queued,pushed),outreach_status.neq.open").limit(500);
  const accounts = all ?? [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  // Companies below the owner's fit bar are never flagged, unless the owner is already working them.
  const inScope = (a: typeof accounts[number]) => a.outreach_status !== "open" || worthShowing(a);

  const { data: people } = await sb.from("cp_people").select("account_id,first_name,last_name,title,relevance,email,email_status,email_revealed").gte("relevance", 50).order("relevance", { ascending: false }).limit(2000);
  const contactOf = new Map<string, number>();
  const bestOf = new Map<string, string>(); // the best person at each company, for the details below
  for (const p of people ?? []) {
    contactOf.set(p.account_id, (contactOf.get(p.account_id) ?? 0) + 1);
    if (!bestOf.has(p.account_id)) bestOf.set(p.account_id, `${p.first_name} ${p.last_name}, ${p.title}`.replace("  ", " "));
  }
  const who = (id: string) => (bestOf.has(id) ? ` Contact: ${bestOf.get(id)}.` : "");

  // 1) Hot and untouched.
  if (on("hotUntouched")) {
    const open = accounts.filter((a) => a.outreach_status === "open" && contactOf.has(a.id) && inScope(a));
    const { data: sigs } = open.length ? await sb.from("cp_signals").select("account_id,kind,title,detail,detected_at").in("account_id", open.map((a) => a.id)) : { data: [] };
    for (const a of open) {
      const mine = (sigs ?? []).filter((s) => s.account_id === a.id);
      const real = mine.filter((s) => s.kind === "news" || (s.kind === "hiring" && !(s.detail && "salesOpenings" in s.detail)));
      const stamp = (s: typeof real[number]) => { const p = s.kind === "news" && s.detail?.published ? Date.parse(String(s.detail.published)) : NaN; return Number.isNaN(p) ? Date.parse(s.detected_at) : p; };
      const newest = real.length ? Math.max(...real.map(stamp)) : 0;
      const latest = real.find((s) => stamp(s) === newest);
      if (hotUntouched(a, true, heatOf(mine as never, fitState(a)), newest, now, n("hotUntouched"))) {
        add({ kind: "hot_untouched", severity: "urgent", accountId: a.id, title: `${a.name}: hot, and nobody has reached out`, detail: `Untouched for ${now - newest >= 48 * H ? `${Math.round((now - newest) / DAY)} days` : `${Math.round((now - newest) / H)} hours`}. Last signal: ${(latest?.title ?? "a new signal").slice(0, 90)}.${who(a.id)}`, since: new Date(newest).toISOString() });
      }
    }
  }

  // 2) Inbound lead past its reply target.
  if (on("leadPastTarget")) {
    const { data: leads } = await sb.from("cp_leads").select("id,name,company,status,label,alerted_at,created_at,account_id").eq("status", "new").gt("created_at", new Date(now - DAY).toISOString()).limit(20);
    for (const l of leads ?? []) {
      if (leadLate(l, now, icp.inbound.slaMinutes, n("leadPastTarget"))) {
        add({ kind: "lead_past_target", severity: "urgent", accountId: l.account_id ?? null, extra: l.id, title: `Lead ${l.name.split(" ")[0]}${l.company ? ` (${l.company})` : ""} is still waiting for a reply`, detail: `Asked ${Math.round(ago(l.alerted_at, now) / 60_000)} minutes ago; the target is ${icp.inbound.slaMinutes}.`, since: l.alerted_at! });
      }
    }
  }
  if (mode === "urgent") return out;

  // 3) Follow-ups overdue, and replies with no next step.
  for (const a of accounts) {
    if (!inScope(a)) continue;
    if (on("followupOverdue") && followupOverdue(a, now, n("followupOverdue"))) {
      add({ kind: "followup_overdue", severity: "normal", accountId: a.id, title: `${a.name}: follow-up is ${Math.floor(ago(a.next_followup_at, now) / DAY)} days late`, detail: `It was due ${Math.floor(ago(a.next_followup_at, now) / DAY)} days ago and nothing was recorded.${who(a.id)}`, since: a.next_followup_at! });
    }
    if (on("repliedNoNext") && repliedStale(a, now, n("repliedNoNext"))) {
      add({ kind: "replied_no_next", severity: "normal", accountId: a.id, title: `${a.name}: replied, but no next step`, detail: `They replied ${Math.floor(ago(a.last_touch_at, now) / DAY)} days ago and nothing has happened since.${who(a.id)}`, since: a.last_touch_at! });
    }
  }

  // 4) Meetings with no debrief.
  if (on("meetingNoDebrief")) {
    const { data: ms } = await sb.from("cp_meetings").select("id,title,account_id,status,outcome,starts_at,ends_at,attendee_name").eq("status", "briefed").is("outcome", null).limit(30);
    for (const m of ms ?? []) {
      if (meetingStale(m, now, n("meetingNoDebrief"))) {
        add({ kind: "meeting_no_debrief", severity: "normal", accountId: m.account_id ?? null, extra: m.id, title: `No debrief for "${m.title ?? "meeting"}"`, detail: "The meeting is over and its outcome was never recorded, so HubSpot and the follow-ups are not updated.", since: new Date(endsAt(m)).toISOString() });
      }
    }
  }

  // 5) Deals with no activity.
  if (on("dealStuck")) {
    const deals = accounts.filter((a) => a.hubspot_deal_id && !["closedwon", "closedlost"].includes(a.deal_stage ?? ""));
    if (deals.length) {
      const { data: oc } = await sb.from("cp_outcomes").select("account_id,created_at").in("account_id", deals.map((d) => d.id)).order("created_at", { ascending: false });
      const lastOutcome = new Map<string, number>();
      for (const o of oc ?? []) if (!lastOutcome.has(o.account_id)) lastOutcome.set(o.account_id, Date.parse(o.created_at));
      for (const a of deals) {
        const last = Math.max(a.last_touch_at ? Date.parse(a.last_touch_at) : 0, lastOutcome.get(a.id) ?? 0);
        if (dealStuck(a, last, now, n("dealStuck"))) {
          add({ kind: "deal_stuck", severity: "normal", accountId: a.id, title: `${a.name}: deal has had no activity for ${Math.floor((now - last) / DAY)} days`, detail: `It is still open in HubSpot (${a.deal_stage ?? "open"}).${who(a.id)}`, since: new Date(last).toISOString() });
        }
      }
    }
  }

  // 6) Thin pipeline: not enough ready accounts that have a person to contact.
  if (on("thinPipeline")) {
    const ready = accounts.filter((a) => a.status === "queued" && a.outreach_status === "open" && contactOf.has(a.id) && worthShowing(a)).length;
    if (thinPipeline(ready, n("thinPipeline"))) {
      const best = (await planBulkFind(3).catch(() => ({ plan: [] as { name: string }[] }))).plan.map((p) => p.name);
      add({ kind: "thin_pipeline", severity: "normal", accountId: null, title: `Only ${ready} ready account${ready === 1 ? "" : "s"} with someone to contact`, detail: `You asked to be warned when fewer than ${n("thinPipeline")} are ready, so Today will run dry.${best.length ? ` Best companies to search next: ${best.join(", ")} (about ${best.length} to ${best.length * 2} credits; "Find people for the top companies" in Accounts does it).` : ' Use "Find relevant people" on your best companies in Accounts.'}`, since: new Date(now).toISOString() });
    }
  }

  // 7) Mismatch and drift against HubSpot (one batch read), plus emails that will bounce.
  const pushed = accounts.filter((a) => a.hubspot_company_id);
  if ((on("mismatch") || on("drift")) && pushed.length && Deno.env.get("HUBSPOT_TOKEN")) {
    try {
      const found = await readCompanies(pushed.map((a) => a.hubspot_company_id!));
      for (const a of pushed) {
        const c = found.get(a.hubspot_company_id!);
        if (!c) {
          if (on("mismatch")) add({ kind: "mismatch", severity: "normal", accountId: a.id, extra: "deleted", title: `${a.name}: its HubSpot company is gone`, detail: "It was deleted or archived in HubSpot, but we still treat it as pushed.", since: new Date(now).toISOString() });
          continue;
        }
        if (!on("drift")) continue;
        if (!c.owner) add({ kind: "drift", severity: "normal", accountId: a.id, extra: "owner", title: `${a.name}: no owner in HubSpot`, detail: "Nobody owns it, so it will not show under your records.", since: new Date(now).toISOString() });
        else if (!c.syncedAt || now - Date.parse(c.syncedAt) > n("drift") * DAY) add({ kind: "drift", severity: "normal", accountId: a.id, extra: "stale", title: `${a.name}: HubSpot columns are out of date`, detail: `Last updated ${c.syncedAt ? Math.floor((now - Date.parse(c.syncedAt)) / DAY) + " days ago" : "never"}. "Update HubSpot columns" in Setup refreshes them.`, since: c.syncedAt ?? new Date(now).toISOString() });
      }
    } catch (e) {
      await log("warn", "flags_hubspot_check_failed", { message: (e as Error).message });
    }
  }
  if (on("mismatch")) {
    for (const p of people ?? []) {
      const a = byId.get(p.account_id);
      if (!a || !p.email_revealed || !["invalid", "blocked", "disposable"].includes(p.email_status ?? "") || !["open", "contacted"].includes(a.outreach_status)) continue;
      add({ kind: "mismatch", severity: "normal", accountId: a.id, extra: `email:${(p.email ?? "").slice(0, 40)}`, title: `${a.name}: the email for ${p.first_name} looks invalid`, detail: "It was checked as invalid, so a message would bounce. Look for another contact.", since: new Date(now).toISOString() });
    }
  }

  // 8) The system itself.
  if (on("system")) {
    try {
      const h = await healthView();
      if (h.overall === "bad") {
        const bad = h.jobs.filter((j) => j.level === "bad").map((j) => `${j.label} (${j.note})`).join(", ");
        add({ kind: "system", severity: "normal", accountId: null, title: "A scheduled job needs attention", detail: bad || "See the Health card in Setup.", since: new Date(now).toISOString() });
      }
    } catch { /* the health card shows its own errors */ }
  }
  return out;
}

// ---- Remembering them ----

const KINDS_BY_MODE: Record<"daily" | "urgent", FlagKind[]> = {
  urgent: URGENT_KINDS,
  daily: ["hot_untouched", "followup_overdue", "lead_past_target", "meeting_no_debrief", "replied_no_next", "deal_stuck", "thin_pipeline", "mismatch", "drift", "system"],
};

/** Stores what was found, clears what is gone, and (for urgent flags, if allowed) puts a to-do in HubSpot. */
export async function runWatch(mode: "daily" | "urgent", opts: { dry?: boolean } = {}) {
  const found = await collect(mode);
  const kinds = KINDS_BY_MODE[mode];
  const { data: open } = await sb.from("cp_flags").select("key,kind,dismissed_at,hubspot_task_id").is("resolved_at", null).in("kind", kinds);
  const have = new Map((open ?? []).map((f) => [f.key, f]));
  const keys = new Set(found.map((f) => f.key));
  // If the owner switched it on, a new "running dry" flag searches the best companies without a contact and says who it found (spends search credits).
  if (!opts.dry && mode === "daily" && icp.watch.autoFix) {
    const thin = found.find((f) => f.kind === "thin_pipeline" && !have.has(f.key));
    if (thin) {
      try {
        const fix = await fixDryList(3);
        if (fix.searched) thin.detail = `Today was running dry, so I searched ${fix.searched} compan${fix.searched === 1 ? "y" : "ies"} (${fix.credits} search credit${fix.credits === 1 ? "" : "s"}). ${fix.text}`;
      } catch (e) { await log("warn", "auto_fix_failed", { message: (e as Error).message }); }
    }
  }
  const fresh = found.filter((f) => !have.has(f.key));
  const gone = (open ?? []).filter((f) => !keys.has(f.key));
  const summary = { mode, found: found.length, new: fresh.length, resolved: gone.length, todos: 0, dry: !!opts.dry };
  if (opts.dry) return { ...summary, items: found.map((f) => ({ key: f.key, severity: f.severity, title: f.title, isNew: !have.has(f.key) })) };

  const nowIso = new Date().toISOString();
  for (const f of found) {
    const row = { kind: f.kind, account_id: f.accountId, severity: f.severity, title: f.title, detail: f.detail, last_seen: nowIso };
    if (have.has(f.key)) await sb.from("cp_flags").update(row).eq("key", f.key);
    else await sb.from("cp_flags").upsert({ key: f.key, ...row, since: f.since, first_seen: nowIso, resolved_at: null, snoozed_until: null, dismissed_at: null, hubspot_task_id: null });
  }
  for (const f of gone) await sb.from("cp_flags").update({ resolved_at: nowIso, dismissed_at: null, snoozed_until: null }).eq("key", f.key);

  // Urgent flags also become a to-do on the company, but only for companies already in HubSpot, and never more than 3 per run.
  if (icp.watch.todoForUrgent && Deno.env.get("HUBSPOT_TOKEN")) {
    for (const f of fresh.filter((x) => x.severity === "urgent" && x.accountId).slice(0, 3)) {
      const { data: a } = await sb.from("cp_accounts").select("hubspot_company_id").eq("id", f.accountId!).maybeSingle();
      if (!a?.hubspot_company_id) continue;
      try {
        const id = await createTask({ subject: `Needs attention: ${f.title}`.slice(0, 240), html: `<p>${f.title}</p><p>${f.detail}</p><p><i>F1rstword pipeline watch. Nothing was sent to anyone.</i></p>`, dueIso: nowIso, priority: "HIGH", ownerId: icp.owner.hubspotOwnerId, companyId: a.hubspot_company_id });
        await sb.from("cp_flags").update({ hubspot_task_id: id }).eq("key", f.key);
        await sb.from("cp_tasks").insert({ key: `flag:${f.key}:${nowIso.slice(0, 10)}`, account_id: f.accountId, hubspot_task_id: id });
        summary.todos++;
      } catch (e) {
        await log("warn", "flag_task_failed", { message: (e as Error).message, detail: { key: f.key } });
      }
    }
  }
  await log("info", "watch_run", { detail: summary });
  return summary;
}

// ---- Reading them ----

export type ActiveFlag = { key: string; kind: FlagKind; severity: string; title: string; detail: string | null; since: string; account: { id: string; name: string } | null };

/** Open flags that are not snoozed or dismissed, urgent first and oldest first. */
export async function activeFlags(limit = 5): Promise<{ items: ActiveFlag[]; total: number }> {
  const { data } = await sb.from("cp_flags").select("key,kind,severity,title,detail,since,account_id,snoozed_until,dismissed_at")
    .is("resolved_at", null).is("dismissed_at", null).order("severity", { ascending: false }).order("since", { ascending: true }).limit(100);
  const now = Date.now();
  const live = (data ?? []).filter((f) => !f.snoozed_until || Date.parse(f.snoozed_until) < now).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "urgent" ? -1 : 1));
  const ids = [...new Set(live.slice(0, limit).map((f) => f.account_id).filter(Boolean) as string[])];
  const { data: names } = ids.length ? await sb.from("cp_accounts").select("id,name").in("id", ids) : { data: [] };
  const nameOf = new Map((names ?? []).map((a) => [a.id, a.name]));
  return {
    total: live.length,
    items: live.slice(0, limit).map((f) => ({ key: f.key, kind: f.kind as FlagKind, severity: f.severity, title: f.title, detail: f.detail, since: f.since, account: f.account_id ? { id: f.account_id, name: nameOf.get(f.account_id) ?? "" } : null })),
  };
}

export async function flagAction(key: string, action: "snooze" | "dismiss", days = 3) {
  const patch = action === "dismiss" ? { dismissed_at: new Date().toISOString() } : { snoozed_until: new Date(Date.now() + days * DAY).toISOString() };
  const { error } = await sb.from("cp_flags").update(patch).eq("key", key).is("resolved_at", null);
  return !error;
}
