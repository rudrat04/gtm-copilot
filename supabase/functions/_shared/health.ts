import { sb } from "./db.ts";
import { googleConfigured, googleToken } from "./google.ts";
import icp from "./icp.json" with { type: "json" };

export type Level = "ok" | "warn" | "bad";
const rank: Record<Level, number> = { ok: 0, warn: 1, bad: 2 };
export const worst = (levels: Level[]): Level => levels.reduce((a, b) => (rank[b] > rank[a] ? b : a), "ok" as Level);

/** How often each scheduled job should run, in hours. A job is late after twice that (plus a small grace). */
export const JOBS: Record<string, { label: string; everyHours: number }> = {
  "meeting-brief": { label: "Meeting brief (calendar poll)", everyHours: 1 / 60 },
  "crm-sync": { label: "HubSpot read-back", everyHours: 0.5 },
  "flags-urgent": { label: "Pipeline watch (urgent)", everyHours: 3 },
  "signal-watch": { label: "Daily signal watch", everyHours: 24 },
  "daily-digest": { label: "Daily digest", everyHours: 24 },
  "discover": { label: "Weekly discovery", everyHours: 168 },
  "signal-scan": { label: "Weekly signal scan", everyHours: 168 },
};

export type JobRow = { jobname: string; active: boolean; last_start: string | null; last_status: string | null };

/** Rules for one job: paused or never run is amber, failed or late is red. `now` is injectable for tests. */
export function jobLevel(j: JobRow | undefined, everyHours: number, now = Date.now()): { level: Level; note: string } {
  if (!j) return { level: "bad", note: "Not scheduled" };
  if (!j.active) return { level: "warn", note: "Paused" };
  if (!j.last_start) return { level: "warn", note: "Has not run yet" };
  if (j.last_status && j.last_status !== "succeeded") return { level: "bad", note: `Last run ${j.last_status}` };
  const lateAfter = Math.max(everyHours * 2, 0.1) * 3_600_000 + 10 * 60_000;
  if (now - Date.parse(j.last_start) > lateAfter) return { level: "bad", note: "Running late" };
  return { level: "ok", note: "On schedule" };
}

/** Hunter credits: warn at 80% of the monthly cap, red when used up. */
export function creditLevel(used: number, cap: number): Level {
  return used >= cap ? "bad" : used >= cap * 0.8 ? "warn" : "ok";
}

/** AI spend today against the daily cap. */
export function spendLevel(usd: number, cap: number): Level {
  return usd >= cap ? "bad" : usd >= cap * 0.8 ? "warn" : "ok";
}

/** Warnings that are expected noise: rejected callers, bad input and other people's websites failing. Errors always count. */
export const NOISE = new Set(["response", "admin_key_rejected", "cron_secret_rejected", "invalid_domain", "fetch_failed"]);
export const isProblem = (r: { level: string; event: string }) => r.level === "error" || !NOISE.has(r.event);

/** Problems in the last 3 days: red from 5 errors, amber from any. */
export function problemLevel(errors: number, warns: number): Level {
  return errors >= 5 ? "bad" : errors > 0 || warns >= 10 ? "warn" : "ok";
}

export async function healthView() {
  const now = Date.now();
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const [{ data: cron }, { data: hunter }, { data: ai }, { data: aiMonth }, { data: probs }] = await Promise.all([
    sb.rpc("cp_cron_health"),
    sb.from("cp_provider_usage").select("credits").eq("provider", "hunter").gte("created_at", monthStart.toISOString()),
    sb.from("cp_ai_spend_today").select("usd").single(),
    sb.from("cp_ai_usage").select("cost_usd").gte("created_at", new Date(now - 30 * 86_400_000).toISOString()),
    sb.from("cp_logs").select("created_at,fn,level,event,message,run_id").neq("level", "info").gte("created_at", new Date(now - 3 * 86_400_000).toISOString()).order("created_at", { ascending: false }).limit(200),
  ]);

  const byName = new Map<string, JobRow>(((cron ?? []) as JobRow[]).map((j) => [j.jobname, j]));
  const jobs = Object.entries(JOBS).map(([name, cfg]) => {
    const j = byName.get(name);
    const { level, note } = jobLevel(j, cfg.everyHours, now);
    return { name, label: cfg.label, level, note, last_start: j?.last_start ?? null };
  });

  const hunterCap = Number(Deno.env.get("HUNTER_MONTHLY_CAP") ?? 40);
  const used = (hunter ?? []).reduce((a, r) => a + Number(r.credits), 0);
  const aiToday = Number(ai?.usd ?? 0);
  const ai30 = (aiMonth ?? []).reduce((a, r) => a + Number(r.cost_usd), 0);

  const rows = (probs ?? []).filter(isProblem);
  const errors = rows.filter((r) => r.level === "error").length;
  const warns = rows.length - errors;
  const grouped = new Map<string, { fn: string; event: string; level: string; n: number; last: string; message: string | null; run_id: string | null }>();
  for (const r of rows) {
    const k = `${r.fn}|${r.event}`;
    const g = grouped.get(k);
    if (g) g.n++;
    else grouped.set(k, { fn: r.fn, event: r.event, level: r.level, n: 1, last: r.created_at, message: r.message, run_id: r.run_id });
  }

  const hunterLevel = creditLevel(used, hunterCap);
  const aiLevel = spendLevel(aiToday, icp.ai.dailyBudgetUsd);
  const probLevel = problemLevel(errors, warns);
  const overall = worst([hunterLevel, aiLevel, probLevel, ...jobs.map((j) => j.level)]);

  return {
    overall,
    hunter: { used: Math.round(used * 10) / 10, cap: hunterCap, left: Math.max(0, Math.round((hunterCap - used) * 10) / 10), level: hunterLevel },
    ai: { today_usd: aiToday, cap_usd: icp.ai.dailyBudgetUsd, last30_usd: Math.round(ai30 * 1000) / 1000, level: aiLevel },
    jobs,
    problems: { errors, warns, level: probLevel, items: [...grouped.values()].slice(0, 8) },
  };
}

type Check = { name: string; level: Level; note: string };

async function probe(name: string, fn: () => Promise<{ ok: boolean; note: string }>): Promise<Check> {
  try {
    const r = await fn();
    return { name, level: r.ok ? "ok" : "bad", note: r.note };
  } catch (e) {
    return { name, level: "bad", note: (e as Error).message.slice(0, 120) };
  }
}

/** Free, read-only calls only: HubSpot account info, Hunter account (no credits), Google token refresh. */
export async function checkConnections(): Promise<Check[]> {
  const hs = probe("HubSpot", async () => {
    const t = Deno.env.get("HUBSPOT_TOKEN");
    if (!t) return { ok: false, note: "Not set up" };
    const r = await fetch("https://api.hubapi.com/account-info/v3/details", { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(15000) });
    return { ok: r.ok, note: r.ok ? "Connected" : r.status === 401 ? "Token rejected" : `HTTP ${r.status}` };
  });
  const hu = probe("Hunter", async () => {
    const k = Deno.env.get("HUNTER_API_KEY");
    if (!k) return { ok: false, note: "Not set up" };
    const r = await fetch("https://api.hunter.io/v2/account", { headers: { "X-API-KEY": k }, signal: AbortSignal.timeout(15000) });
    return { ok: r.ok, note: r.ok ? "Connected" : r.status === 401 ? "Key rejected" : `HTTP ${r.status}` };
  });
  const go = probe("Google", async () => {
    if (!googleConfigured()) return { ok: false, note: "Not set up" };
    await googleToken();
    return { ok: true, note: "Signed in" };
  });
  return await Promise.all([hs, hu, go]);
}
