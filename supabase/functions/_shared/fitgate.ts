import icp from "./icp.json" with { type: "json" };
import { fitState, type FitState } from "./score.ts";

// The owner's bar for "worth showing", set in the Setup tab. Companies below it are hidden from Accounts (under
// Low fit), Today, alerts and automatic contact lookups, and are not added by discovery.

export type MinFit = "matches" | "close" | "unknown" | "outside";
export const MIN_FITS: MinFit[] = ["matches", "close", "unknown", "outside"];
const ORDER: Record<FitState, number> = { outside: 0, unknown: 1, close: 2, matches: 3 };

/** Is this fit state at or above the bar? "outside" as the bar means show everything. */
export const meetsFit = (fit: FitState, min: MinFit = icp.fit.minFit as MinFit) => ORDER[fit] >= ORDER[min];

type FitRow = Parameters<typeof fitState>[0];

/** The one question every screen asks: is this company worth showing, by fit and by score? */
export function worthShowing(a: FitRow & { priority_score?: number | null; watched_at?: string | null }, cfg = icp.fit as { minFit: MinFit; minScore: number }): boolean {
  if (a.watched_at) return true; // a company the owner chose to follow is never hidden by the bar
  return meetsFit(fitState(a), cfg.minFit) && (a.priority_score ?? 0) >= cfg.minScore;
}

/** The score needed to enter the queue (was a fixed 30). */
export const queueThreshold = () => icp.fit.minScore;
