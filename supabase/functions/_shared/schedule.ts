import icp from "./icp.json" with { type: "json" };

// Which days each message may go out, and how many that day. Monday first. 0 = none that day. The owner's day is read in IST.
export const SCHED_KINDS = ["hot", "watchlist", "daily", "flags"] as const;
export type SchedKind = typeof SCHED_KINDS[number];
export type Sched = Record<SchedKind, number[]>;
export const SCHED_MAX: Record<SchedKind, number> = { hot: 10, watchlist: 10, daily: 1, flags: 8 };

/** Pure: Monday = 0 ... Sunday = 6, for a moment in time as the owner (IST) sees it. */
export const istDay = (now = Date.now()): number => (new Date(now + 5.5 * 3_600_000).getUTCDay() + 6) % 7;

/** Pure: a clean schedule. A missing or broken one is filled from the old single numbers. */
export function cleanSched(raw: unknown, base: { hot: number; watchlist: number; flags: boolean }): Sched {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const fill = (k: SchedKind, dflt: number): number[] => {
    const a = Array.isArray(r[k]) ? (r[k] as unknown[]) : [];
    return Array.from({ length: 7 }, (_, i) => { const n = Math.round(Number(a[i])); return Number.isFinite(n) && a[i] !== undefined && a[i] !== null ? Math.min(SCHED_MAX[k], Math.max(0, n)) : dflt; });
  };
  return { hot: fill("hot", base.hot), watchlist: fill("watchlist", base.watchlist), daily: fill("daily", 1), flags: fill("flags", base.flags ? SCHED_MAX.flags : 1) };
}

const current = (): Sched | null => (icp.watch as unknown as { sched?: Sched }).sched ?? null;
/** How many of this message may go out today (0 = none). Without a schedule, today counts as allowed. */
export const todayCount = (kind: SchedKind, now = Date.now()): number => current()?.[kind]?.[istDay(now)] ?? SCHED_MAX[kind];
export const dayOn = (kind: SchedKind, now = Date.now()): boolean => todayCount(kind, now) > 0;
