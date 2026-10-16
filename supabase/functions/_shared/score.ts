import icp from "./icp.json" with { type: "json" };
import type { Signal } from "./signals.ts";
import { fitBreakdown, type FitRow } from "./firmo.ts";

const FUNDING = /\b(raises?|raised|funding|series [a-d]|seed round|valuation|acquir|acquisition)\b/i;
const REVOPS = /revops|revenue operations|sales operations|sales ops/i;

// Account fit is a fixed baseline for the curated list. Real fit comes from the dossier.
const BASELINE_FIT = 15;
const RULE_CAP = 12; // most points tool and competitor rules can add
const DAY = 86_400_000;


/**
 * Is this news item about funding? A label from PredictLeads or from the relevance check wins; only older stored items
 * with no label fall back on the keywords.
 */
export function isFundingSignal(s: { title: string; detail?: Record<string, unknown> | null }): boolean {
  const d = s.detail ?? {};
  if (d.plType) return d.plType === "FUNDING";
  if (d.newsType) return d.newsType === "funding";
  return FUNDING.test(s.title);
}

export type Score = {
  score: number;
  parts: { hiring: number; news: number; community: number; custom: number; fit: number };
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
/**
 * How well-timed the last funding round is: the best window is a few months after it (hiring ramps up), a fresh round counts
 * a little less, an old one fades. 0 when the date is unknown. The window comes from the owner's profile.
 */
export function roundTiming(lastRoundDate: string | null | undefined, now = Date.now()): number {
  const t = Date.parse(lastRoundDate ?? "");
  if (Number.isNaN(t)) return 0;
  const days = (now - t) / DAY;
  const [lo, hi] = icp.timing.roundWindowDays;
  if (days < 0) return 0;
  if (days < lo) return 0.6;
  if (days <= hi) return 1;
  return days <= hi * 1.5 ? 0.4 : 0;
}

/** The one place a company's priority score is worked out: its signals, how well it fits, and how well timed its funding is. */
export function scoreAccount(signals: Dated[], a: FitRow & { last_round_date?: string | null }): Score {
  return priorityScore(signals, fitBreakdown(a).points, roundTiming(a.last_round_date));
}

export function priorityScore(signals: Dated[], fit: number = BASELINE_FIT, timing = 0): Score {
  const w = icp.signals.weights;

  const summary = signals.find((s) => s.kind === "hiring" && s.detail && "salesOpenings" in s.detail);
  const salesOpenings = Number(summary?.detail?.salesOpenings ?? 0);
  const revops = signals.some((s) => s.kind === "hiring" && REVOPS.test(s.title));
  const posted = signals.some((s) => s.kind === "hiring" && s.detail?.source === "hn_hiring"); // a recent public sales-role post
  const d = (summary?.detail ?? {}) as { leader?: boolean; founding?: boolean };
  const hiring = Math.min(w.hiring, Math.max(salesOpenings * 12 + (revops ? 10 : 0) + (salesOpenings > 0 ? (d.leader ? 8 : 0) + (d.founding ? 6 : 0) : 0), posted ? 12 : 0));

  const news = signals.filter((s) => s.kind === "news").map((s) => ({
    f: decay(ageDays(s), 30, 60),
    funding: isFundingSignal(s),
  }));
  const fundedFactor = Math.max(0, ...news.filter((n) => n.funding).map((n) => n.f));
  const funded = fundedFactor > 0;
  const newsPts = funded
    ? w.news * fundedFactor
    : Math.min(w.news * 0.4, news.reduce((a, n) => a + n.f, 0) * 5 + w.news * 0.3 * timing); // no funding news, but a round in the sweet spot still counts a little

  const hn = signals.filter((s) => s.kind === "hn").reduce((a, s) => a + decay(ageDays(s), 30, 90), 0);
  const community = Math.min(w.tech, hn * 4);

  // Tools and competitors the owner asked to watch: a competitor in use counts most. News-based rules already count as news above.
  const seenRule = new Set<string>();
  const custom = Math.min(RULE_CAP, signals.filter((s) => s.kind === "tech" && s.detail?.ruleType).reduce((a, s) => {
    const key = `${s.detail?.rule}|${s.title}`;
    if (seenRule.has(key)) return a;
    seenRule.add(key);
    return a + (s.detail?.ruleType === "competitor" ? 10 : s.detail?.ruleType === "visit" ? 12 : 5);
  }, 0));

  const parts = { hiring, news: Math.round(newsPts), community: Math.round(community), custom, fit: Math.round(fit) };
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


/** Is this the right kind of company? Needs the company facts; "unknown" until they are looked up. */
export function fitState(a: FitRow): FitState {
  const f = fitBreakdown(a);
  if (f.excluded) return "outside"; // a competitor, an agency, an existing customer: never a prospect, whatever its size
  if (f.placeMiss || f.industryMiss) return "outside"; // a known country or industry outside what the owner chose (the strict-fit switch in Setup)
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
  const funding = sigs.some((s) => s.kind === "news" && isFundingSignal(s) && age(s) < 30);
  if (fresh || funding || sales >= 2) return "hot";
  if (sales >= 1 || real.some((s) => age(s) < 60) || sigs.some((s) => s.kind === "hn" && age(s) < 30) || sigs.some((s) => s.kind === "tech" && s.detail?.ruleType)) return "warm";
  return "watching";
}
