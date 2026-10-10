import icp from "./icp.json" with { type: "json" };
import type { Signal } from "./signals.ts";
import { fitBreakdown } from "./firmo.ts";

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
export function priorityScore(signals: Dated[], fit: number = BASELINE_FIT): Score {
  const w = icp.signals.weights;

  const summary = signals.find((s) => s.kind === "hiring" && s.detail && "salesOpenings" in s.detail);
  const salesOpenings = Number(summary?.detail?.salesOpenings ?? 0);
  const revops = signals.some((s) => s.kind === "hiring" && REVOPS.test(s.title));
  const posted = signals.some((s) => s.kind === "hiring" && s.detail?.source === "hn_hiring"); // a recent public sales-role post
  const hiring = Math.min(w.hiring, Math.max(salesOpenings * 12 + (revops ? 10 : 0), posted ? 12 : 0));

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

  const parts = { hiring, news: Math.round(newsPts), community: Math.round(community), fit: Math.round(fit) };
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

// ---- The two plain questions a rep asks, instead of one blended number ----

export type FitState = "matches" | "close" | "unknown" | "outside";
export type Heat = "hot" | "warm" | "watching";

type FitRow = { employees?: number | null; stage?: string | null; country?: string | null; firmo_at?: string | null };

/** Is this the right kind of company? Needs the company facts; "unknown" until they are looked up. */
export function fitState(a: FitRow): FitState {
  const f = fitBreakdown(a);
  if (!f.known) return "unknown";
  if (f.size === 0 || f.stage === 0) return "outside";
  return f.matches ? "matches" : "close";
}

type Sig = { kind: string; title: string; detail?: Record<string, unknown> | null; detected_at: string };

/** Is something happening now? Hot = a signal under a week old, recent funding, or 2+ sales roles open, warm = some signal, watching = nothing right now. Clearly out-of-range companies are never hot. */
export function heatOf(sigs: Sig[], fit: FitState): Heat {
  if (fit === "outside") return "watching";
  const now = Date.now();
  const age = (s: Sig) => {
    const raw = (s.detail?.published as string | undefined) ?? s.detected_at;
    const t = Date.parse(raw);
    return Number.isNaN(t) ? Infinity : (now - t) / DAY;
  };
  const isSummary = (s: Sig) => s.kind === "hiring" && !!s.detail && "salesOpenings" in s.detail;
  const sales = Number(sigs.find(isSummary)?.detail?.salesOpenings ?? 0);
  const real = sigs.filter((s) => !isSummary(s) && (s.kind === "news" || s.kind === "hiring"));
  const fresh = real.some((s) => age(s) < 7);
  const funding = sigs.some((s) => s.kind === "news" && FUNDING.test(s.title) && age(s) < 30);
  if (fresh || funding || sales >= 2) return "hot";
  if (sales >= 1 || real.some((s) => age(s) < 60) || sigs.some((s) => s.kind === "hn" && age(s) < 30)) return "warm";
  return "watching";
}
