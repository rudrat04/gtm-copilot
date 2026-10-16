import { sb } from "./db.ts";
import icp from "./icp.json" with { type: "json" };
import { FIT_COLS } from "./firmo.ts";
import { fitState } from "./score.ts";
import { queueThreshold } from "./fitgate.ts";
import { icpVersion } from "./fitver.ts";

// Discovery follows how full the pipeline is: no point finding more companies while the rep already has more than they can work.

export type CapMode = "skip" | "normal" | "boost" | "catchup";

/** Pure. ready = companies the rep could work today (fit, a buyer-matching person, a score above the bar, nobody has contacted them). */
export function capacityMode(i: { ready: number; cap: number; icpChanged: boolean }): { mode: CapMode; why: string } {
  const full = i.cap * 3; // three days of work
  if (i.icpChanged) return { mode: "catchup", why: "Your profile changed since the last run, so the search runs once now" };
  if (i.ready >= full) return { mode: "skip", why: `Enough in the pipeline (${i.ready} ready, ${full} is a full queue)` };
  if (i.ready < i.cap) return { mode: "boost", why: `Pipeline is thin (${i.ready} ready, you work ${i.cap} a day)` };
  return { mode: "normal", why: `${i.ready} ready` };
}

export async function readyCount(): Promise<number> {
  const [{ data: accts }, { data: ppl }] = await Promise.all([
    sb.from("cp_accounts").select(`id,priority_score,outreach_status,${FIT_COLS}`).is("removed_at", null).eq("outreach_status", "open").gte("priority_score", queueThreshold()).limit(2000),
    sb.from("cp_people").select("account_id").gte("relevance", 50).limit(5000),
  ]);
  const withBuyer = new Set((ppl ?? []).map((p) => p.account_id));
  return (accts ?? []).filter((a) => withBuyer.has(a.id) && ["matches", "close"].includes(fitState(a as never))).length;
}

const KEY = "discovery_icp_ver";
export async function icpChangedSinceDiscovery(): Promise<boolean> {
  const { data } = await sb.from("cp_state").select("value").eq("key", KEY).maybeSingle();
  if (!data) { await markDiscoveryVersion(); return false; } // the first look only records where we are
  return data.value !== icpVersion();
}
export async function markDiscoveryVersion() {
  await sb.from("cp_state").upsert({ key: KEY, value: icpVersion(), updated_at: new Date().toISOString() });
}
export const todayCap = () => Number((icp.today as { cap?: number }).cap ?? 8);
