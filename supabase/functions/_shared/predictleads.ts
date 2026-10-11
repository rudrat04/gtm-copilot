import { sb } from "./db.ts";
import { log } from "./log.ts";
import { scoreAccount } from "./score.ts";
import { reasonLine } from "./today.ts";
import { queueThreshold, worthShowing } from "./fitgate.ts";
import type { Signal } from "./signals.ts";
import icp from "./icp.json" with { type: "json" };

// PredictLeads news events: structured, domain-keyed company events (funding, executive hires...). The owner's plan is a
// small monthly allowance of calls, so this is a targeted source: one call per account per refresh, counted by us (the
// API returns no usage headers) and capped. Everything else keeps using the free sources. Verified shape: see CLAUDE.md.

const BASE = "https://predictleads.com/api/v3";
const DAY = 86_400_000;
const MIN_CONFIDENCE = 0.5;
const MAX_AGE_DAYS = 180;

export const plConfigured = () => !!(Deno.env.get("PREDICTLEADS_API_KEY") && Deno.env.get("PREDICTLEADS_API_TOKEN"));
export const plCap = () => Math.max(1, Number(Deno.env.get("PREDICTLEADS_MONTHLY_CAP") ?? 100));

/** Who is asking decides how much of the allowance may be used: background jobs 60%, meeting briefs 90%, the owner's own click 100%. */
export type Purpose = "auto" | "brief" | "manual";
const SHARE: Record<Purpose, number> = { auto: 0.6, brief: 0.9, manual: 1 };
export const plAllowed = (purpose: Purpose, used: number, cap: number) => used < Math.floor(cap * SHARE[purpose]);

export async function plUsed(): Promise<number> {
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const { data } = await sb.from("cp_provider_usage").select("credits").eq("provider", "predictleads").gte("created_at", start.toISOString());
  return (data ?? []).reduce((a, r) => a + Number(r.credits), 0);
}

// ---- Reading events (pure, so it can be tested) ----

export type PlEvent = {
  id: string; category: string; headline: string; summary: string; found_at: string | null; effective_date: string | null;
  confidence: number; planning: boolean; job_title: string | null; contact: string | null; financing_type: string | null; amount: number | null;
};

// deno-lint-ignore no-explicit-any -- an external JSON:API payload
export function normalizeEvents(body: any): PlEvent[] {
  // deno-lint-ignore no-explicit-any
  return (Array.isArray(body?.data) ? body.data : []).filter((e: any) => e?.type === "news_event").map((e: any) => {
    const a = e.attributes ?? {};
    return {
      id: String(e.id), category: String(a.category ?? ""), headline: String(a.headline ?? a.summary ?? "").trim(), summary: String(a.summary ?? ""),
      found_at: a.found_at ?? null, effective_date: a.effective_date ?? null, confidence: Number(a.confidence ?? 0), planning: a.planning === true,
      job_title: a.job_title ?? null, contact: a.contact ?? null, financing_type: a.financing_type ?? null, amount: a.amount != null ? Number(a.amount) : null,
    };
  });
}

export type PlType = "FUNDING" | "NEW_CRO" | "NEW_VP_SALES" | "LEADER_HIRE";

/** Which events are buying signals. Funding, and executive hires in sales, revenue or go-to-market roles. Integrations, rankings and the like are ignored. */
export function classify(e: PlEvent): PlType | null {
  const cat = e.category.toLowerCase();
  if (/financ|funding|raise|round|invest/.test(cat) || e.financing_type || (e.amount != null && e.amount > 0)) return "FUNDING";
  if (cat !== "hires" && !cat.startsWith("hire")) return null;
  const role = `${e.job_title ?? ""} ${e.headline}`;
  if (/\b(chief revenue officer|cro)\b/i.test(role)) return "NEW_CRO";
  if (/\b(vp|vice president|head)( of)? (sales|revenue)\b|sales director|director of sales/i.test(role)) return "NEW_VP_SALES";
  if (/revops|revenue operations|sales operations|chief executive|\bceo\b|chief operating|\bcoo\b|chief marketing|\bcmo\b|head of (marketing|growth)|business development/i.test(role)) return "LEADER_HIRE";
  return null;
}

/** The round a funding headline is about ("series d", "seed"), so several investors in the same round count once. */
export function roundKey(title: string): string | null {
  const m = /\b(pre-?seed|seed|series\s+[a-h])\b/i.exec(title);
  return m ? m[1].toLowerCase().replace(/\s+/g, " ").replace("preseed", "pre-seed") : null;
}

/** Keeps one signal per funding round (within 45 days of each other), against the batch itself and against what is already stored. */
export function dedupeRounds(fresh: Signal[], stored: { title: string; published: string | null }[]): Signal[] {
  const seen: { key: string; at: number }[] = [];
  for (const s of stored) { const k = roundKey(s.title); const t = Date.parse(s.published ?? ""); if (k && !Number.isNaN(t)) seen.push({ key: k, at: t }); }
  const out: Signal[] = [];
  for (const s of fresh) {
    const k = s.detail?.plType === "FUNDING" ? roundKey(s.title) : null;
    const t = Date.parse(String(s.detail?.published ?? ""));
    if (k && !Number.isNaN(t) && seen.some((x) => x.key === k && Math.abs(x.at - t) < 45 * DAY)) continue;
    if (k && !Number.isNaN(t)) seen.push({ key: k, at: t });
    out.push(s);
  }
  return out;
}

/** One stored signal per useful event. Its date is when the thing happened if known, else when it was found; old, uncertain or merely planned events are dropped. */
export function toSignal(e: PlEvent, now = Date.now()): Signal | null {
  const type = classify(e);
  if (!type || e.confidence < MIN_CONFIDENCE || e.planning || !e.headline) return null;
  const when = Date.parse(e.effective_date ?? e.found_at ?? "");
  if (Number.isNaN(when) || now - when > MAX_AGE_DAYS * DAY || when > now + DAY) return null;
  return {
    kind: "news",
    title: e.headline.slice(0, 300),
    detail: {
      published: new Date(when).toISOString(), source: "predictleads", plType: type,
      pl: { category: e.category, confidence: e.confidence, job_title: e.job_title, contact: e.contact, financing_type: e.financing_type, amount: e.amount },
    },
  };
}

// ---- Calling the API ----

async function fetchNews(domain: string, limit: number): Promise<{ ok: true; events: PlEvent[] } | { ok: false; status: number; counted: boolean }> {
  try {
    const res = await fetch(`${BASE}/companies/${encodeURIComponent(domain)}/news_events?limit=${limit}`, {
      headers: { "X-Api-Key": Deno.env.get("PREDICTLEADS_API_KEY")!, "X-Api-Token": Deno.env.get("PREDICTLEADS_API_TOKEN")!, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    const counted = res.status !== 401 && res.status !== 403; // a rejected key is not a used call
    if (counted) await sb.from("cp_provider_usage").insert({ provider: "predictleads", action: "news_events", credits: 1, account: domain });
    if (!res.ok) return { ok: false, status: res.status, counted };
    return { ok: true, events: normalizeEvents(await res.json().catch(() => ({}))) };
  } catch {
    return { ok: false, status: 0, counted: false }; // network trouble: nothing was used
  }
}

export type RefreshResult = { skipped?: string; error?: string; events?: number; added?: number; ignored?: number; used: number; cap: number };

/** Stored PredictLeads signals for an account, so the weekly scan and the daily watch can count them when they rescore. */
export async function storedPlSignals(accountId: string): Promise<Signal[]> {
  const { data } = await sb.from("cp_signals").select("kind,title,url,detail").eq("account_id", accountId).eq("kind", "news").contains("detail", { source: "predictleads" });
  return (data ?? []).map((s) => ({ kind: "news" as const, title: s.title, url: s.url ?? undefined, detail: s.detail ?? {} }));
}

/** Fetches one account's news events, stores the useful ones as signals and rescores it. One call; honours the monthly allowance. */
export async function refreshFromPredictLeads(accountId: string, purpose: Purpose, opts: { maxAgeDays?: number } = {}): Promise<RefreshResult> {
  const cap = plCap();
  if (!plConfigured()) return { skipped: "PredictLeads is not set up", used: 0, cap };
  const used = await plUsed();
  const { data: a } = await sb.from("cp_accounts").select("id,name,domain,status,pl_checked_at,employees,stage,country,firmo_at,tech,industry,tags,blurb,sales_motion,known_as,last_round_date").eq("id", accountId).maybeSingle();
  if (!a) return { error: "Account not found", used, cap };
  if (opts.maxAgeDays && a.pl_checked_at && Date.now() - Date.parse(a.pl_checked_at) < opts.maxAgeDays * DAY) return { skipped: "checked recently", used, cap };
  if (!plAllowed(purpose, used, cap)) return { skipped: purpose === "manual" ? "the monthly allowance is used up" : "kept in reserve for your own checks", used, cap };

  const r = await fetchNews(a.domain, 10);
  if (!r.ok) {
    await log("warn", "predictleads_failed", { account: a.domain, message: `PredictLeads ${r.status || "network error"}`, detail: { status: r.status, counted: r.counted } });
    return { error: r.status === 401 || r.status === 403 ? "PredictLeads rejected the key" : r.status === 429 ? "PredictLeads is rate limiting" : "PredictLeads could not be reached", used: used + (r.counted ? 1 : 0), cap };
  }

  const signals = r.events.map((e) => toSignal(e)).filter((s): s is Signal => !!s);
  const { data: have } = await sb.from("cp_signals").select("title,detail").eq("account_id", a.id).eq("kind", "news");
  const known = new Set((have ?? []).map((h) => h.title));
  const fresh = dedupeRounds(signals.filter((s) => !known.has(s.title.slice(0, 300))), (have ?? []).map((h) => ({ title: h.title, published: (h.detail?.published as string | undefined) ?? null })));
  if (fresh.length) {
    await sb.from("cp_signals").upsert(fresh.map((s) => ({ account_id: a.id, kind: s.kind, title: s.title, url: null, detail: s.detail ?? {} })), { onConflict: "account_id,kind,title", ignoreDuplicates: true });
  }
  await sb.from("cp_accounts").update({ pl_checked_at: new Date().toISOString() }).eq("id", a.id);

  // Rescore from everything stored, so the new events count straight away.
  const { data: all } = await sb.from("cp_signals").select("kind,title,url,detail,detected_at").eq("account_id", a.id);
  const mine = (all ?? []).map((s) => ({ ...s, url: s.url ?? undefined, detail: { ...(s.detail ?? {}), detected_at: s.detected_at } })) as unknown as Signal[];
  const score = scoreAccount(mine, a).score;
  const upd: Record<string, unknown> = { priority_score: score };
  if (a.status === "new" && score >= queueThreshold()) { upd.status = "queued"; upd.why_now = reasonLine(mine as never); }
  await sb.from("cp_accounts").update(upd).eq("id", a.id);

  await log("info", "predictleads_refresh", { account: a.domain, detail: { purpose, events: r.events.length, added: fresh.length, ignored: r.events.length - signals.length, used: used + 1, cap } });
  return { events: r.events.length, added: fresh.length, ignored: r.events.length - signals.length, used: used + 1, cap };
}

/** Background use: a couple of the best accounts a day that have not been checked for two weeks. Stops at 60% of the allowance. */
export async function autoRefreshPredictLeads(max = 2): Promise<{ checked: number; added: number }> {
  const out = { checked: 0, added: 0 };
  if (!plConfigured() || icp.predictleads.auto === false) return out;
  const { data } = await sb.from("cp_accounts")
    .select("id,name,domain,priority_score,employees,stage,country,firmo_at,tech,industry,tags,blurb,sales_motion,known_as,last_round_date,pl_checked_at")
    .is("removed_at", null).in("status", ["queued", "pushed"]).in("outreach_status", ["open", "contacted"])
    .order("priority_score", { ascending: false }).limit(40);
  const due = (data ?? []).filter((a) => worthShowing(a) && (!a.pl_checked_at || Date.now() - Date.parse(a.pl_checked_at) > 14 * DAY)).slice(0, max);
  for (const a of due) {
    const r = await refreshFromPredictLeads(a.id, "auto");
    if (r.skipped) break; // the background share is used up
    if (!r.error) { out.checked++; out.added += r.added ?? 0; }
  }
  return out;
}
