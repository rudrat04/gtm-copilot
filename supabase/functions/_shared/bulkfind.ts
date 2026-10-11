import { sb } from "./db.ts";
import { log } from "./log.ts";
import { hunterBalance, searchAndStore } from "./people.ts";
import { guardPeople } from "./guard.ts";
import { FIT_COLS } from "./firmo.ts";
import { fitState, heatOf } from "./score.ts";
import { worthShowing } from "./fitgate.ts";

// "Find people for my best companies": the hot (then warm) companies that pass the fit bar and have nobody attached yet.
// One click shows who and what it could cost, and only a confirmed run spends credits. Each search costs 1 credit when it finds
// people, and can cost a second when the first finds fewer than 3 (see the Hunter adapter in people.ts).

export const BULK_MAX = 8;
const HEAT_ORDER: Record<string, number> = { hot: 0, warm: 1, watching: 2 };

export type Planned = { id: string; name: string; domain: string; heat: string; priority: number | null };

/** Pure: put hot companies first, then warm, by score, and drop the rest ("watching" is not worth credits). */
export function pickTop<T extends { heat: string; priority: number | null }>(rows: T[], limit: number): T[] {
  return rows.filter((r) => r.heat !== "watching").sort((a, b) => (HEAT_ORDER[a.heat] - HEAT_ORDER[b.heat]) || ((b.priority ?? 0) - (a.priority ?? 0))).slice(0, Math.max(1, Math.min(BULK_MAX, limit)));
}

export async function planBulkFind(limit: number): Promise<{ plan: Planned[]; waiting: number; credits_min: number; credits_max: number; balance: { remaining: number; available: number } | null }> {
  const { data: accts } = await sb.from("cp_accounts").select(`id,name,priority_score,status,outreach_status,${FIT_COLS}`)
    .is("removed_at", null).in("status", ["queued", "pushed"]).eq("outreach_status", "open").order("priority_score", { ascending: false, nullsFirst: false }).limit(200);
  const { data: have } = await sb.from("cp_people").select("account_id");
  const withPeople = new Set((have ?? []).map((p) => p.account_id));
  const todo = (accts ?? []).filter((a) => !withPeople.has(a.id) && worthShowing(a));
  const ids = todo.map((a) => a.id);
  const { data: sigs } = ids.length ? await sb.from("cp_signals").select("account_id,kind,title,detail,detected_at").in("account_id", ids) : { data: [] };
  const rows = todo.map((a) => ({
    id: a.id, name: a.name, domain: a.domain as string, priority: a.priority_score as number | null,
    heat: heatOf((sigs ?? []).filter((s) => s.account_id === a.id) as never, fitState(a)),
  }));
  const plan = pickTop(rows, limit);
  return { plan, waiting: rows.filter((r) => r.heat !== "watching").length, credits_min: plan.length, credits_max: plan.length * 2, balance: await hunterBalance() };
}

/** Runs the searches for the planned companies, one at a time. Stops cleanly when the monthly limit is reached. */
export async function runBulkFind(plan: Planned[]): Promise<{ done: { name: string; stored: number; credits: number }[]; stopped?: string }> {
  const done: { name: string; stored: number; credits: number }[] = [];
  for (const p of plan) {
    try {
      const r = await searchAndStore({ id: p.id, domain: p.domain });
      done.push({ name: p.name, stored: r.stored, credits: r.credits });
    } catch (e) {
      await log("warn", "bulk_find_stopped", { account: p.domain, message: (e as Error).message });
      return { done, stopped: (e as Error).message };
    }
  }
  await guardPeople({ limit: 100 }); // anyone not yet checked against HubSpot
  await log("info", "bulk_find_done", { detail: { companies: done.length, credits: done.reduce((a, d) => a + d.credits, 0) } });
  return { done };
}
