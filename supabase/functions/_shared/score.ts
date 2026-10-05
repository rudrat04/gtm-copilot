import icp from "./icp.json" with { type: "json" };
import type { Signal } from "./signals.ts";

const FUNDING = /\b(raises?|raised|funding|series [a-d]|seed round|valuation|acquir|acquisition)\b/i;
const REVOPS = /revops|revenue operations|sales operations|sales ops/i;

// Account fit is a fixed baseline for the curated list. Real fit comes from the dossier.
const BASELINE_FIT = 15;
const DAY = 86_400_000;

export const QUEUE_THRESHOLD = 30;

export type Score = {
  score: number;
  parts: { hiring: number; news: number; community: number; fit: number };
  signalScore: number; // all signals, 0-100
  intentScore: number; // hiring + funding only, 0-100
  funded: boolean;
};

type Dated = Signal & { detail?: Record<string, unknown> };

/** Age in days from the best available date: publish date, then first-seen date. */
function ageDays(s: Dated): number | null {
  const raw = (s.detail?.published ?? s.detail?.created ?? s.detail?.detected_at) as string | undefined;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? null : Math.max(0, (Date.now() - t) / DAY);
}

/** Older evidence counts for less, so stale news stops ranking accounts high. */
function decay(days: number | null, full: number, half: number): number {
  if (days === null) return 1;
  return days <= full ? 1 : days <= half ? 0.5 : 0;
}

/** Deterministic priority score. No AI involved, so ranking is cheap and explainable. */
export function priorityScore(signals: Dated[]): Score {
  const w = icp.signals.weights;

  const summary = signals.find((s) => s.kind === "hiring" && s.detail && "salesOpenings" in s.detail);
  const salesOpenings = Number(summary?.detail?.salesOpenings ?? 0);
  const revops = signals.some((s) => s.kind === "hiring" && REVOPS.test(s.title));
  const hiring = Math.min(w.hiring, salesOpenings * 12 + (revops ? 10 : 0));

  const news = signals.filter((s) => s.kind === "news").map((s) => ({
    f: decay(ageDays(s), 30, 60),
    funding: FUNDING.test(s.title),
  }));
  const fundedFactor = Math.max(0, ...news.filter((n) => n.funding).map((n) => n.f));
  const funded = fundedFactor > 0;
  const newsPts = funded
    ? w.news * fundedFactor
    : Math.min(w.news * 0.4, news.reduce((a, n) => a + n.f, 0) * 5);

  const hn = signals.filter((s) => s.kind === "hn").reduce((a, s) => a + decay(ageDays(s), 30, 90), 0);
  const community = Math.min(w.tech, hn * 4);

  const parts = { hiring, news: Math.round(newsPts), community: Math.round(community), fit: BASELINE_FIT };
  const score = Math.min(100, Object.values(parts).reduce((a, b) => a + b, 0));
  const signalMax = w.hiring + w.news + w.tech;
  const intentMax = w.hiring + w.news;
  return {
    score,
    parts,
    signalScore: Math.min(100, Math.round(((parts.hiring + parts.news + parts.community) / signalMax) * 100)),
    intentScore: Math.min(100, Math.round(((parts.hiring + (funded ? parts.news : 0)) / intentMax) * 100)),
    funded,
  };
}

/** HubSpot "Ideal Customer Profile Tier" value from the priority score. */
export function tierOf(priority: number | null | undefined): "tier_1" | "tier_2" | "tier_3" {
  const p = priority ?? 0;
  return p >= icp.tiers.tier_1 ? "tier_1" : p >= icp.tiers.tier_2 ? "tier_2" : "tier_3";
}
