import icp from "./icp.json" with { type: "json" };
import type { Signal } from "./signals.ts";

const FUNDING = /\b(raises?|raised|funding|series [a-d]|seed round|valuation|acquir|acquisition)\b/i;
const REVOPS = /revops|revenue operations|sales operations|sales ops/i;

// Account fit is a fixed baseline for the curated list. Real fit comes from the dossier.
const BASELINE_FIT = 15;

export type Score = { score: number; parts: Record<string, number> };

/** Deterministic priority score. No AI involved, so ranking is cheap and explainable. */
export function priorityScore(signals: Signal[]): Score {
  const w = icp.signals.weights;

  const summary = signals.find((s) => s.kind === "hiring" && s.detail && "salesOpenings" in s.detail);
  const salesOpenings = Number(summary?.detail?.salesOpenings ?? 0);
  const revops = signals.some((s) => s.kind === "hiring" && REVOPS.test(s.title));
  const hiring = Math.min(w.hiring, salesOpenings * 12 + (revops ? 10 : 0));

  const news = signals.filter((s) => s.kind === "news");
  const funded = news.some((s) => FUNDING.test(s.title));
  const newsPts = funded ? w.news : Math.min(w.news * 0.4, news.length * 5);

  const hn = signals.filter((s) => s.kind === "hn").length;
  const hnPts = Math.min(w.tech, hn * 4);

  const parts = {
    hiring,
    news: Math.round(newsPts),
    community: hnPts,
    fit: BASELINE_FIT,
  };
  const score = Math.min(100, Object.values(parts).reduce((a, b) => a + b, 0));
  return { score, parts };
}

export const QUEUE_THRESHOLD = 30;
