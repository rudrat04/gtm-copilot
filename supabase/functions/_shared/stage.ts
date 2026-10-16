import type { Heat } from "./score.ts";

// One stage per company, the same everywhere (People, Companies, To-do), worked out from what we know. Pure rules, no AI, no credits.
export type Stage = "candidate" | "qualified" | "ready" | "active" | "nurture" | "closed";
export const STAGE_LABEL: Record<Stage, string> = { candidate: "Candidate", qualified: "Qualified", ready: "Ready", active: "Active", nurture: "Nurture", closed: "Closed" };

export type StageInput = {
  removed: boolean; outreach: string | null; won: boolean; lost: boolean; customer: boolean; notFit: boolean; snoozed: boolean;
  fit: "matches" | "close" | "unknown" | "outside"; hasBuyer: boolean; heat: Heat; watched: boolean;
};

/** Candidate = found, not checked. Qualified = fits, waiting for a buyer-matching person. Ready = fits, has that person, something is happening. Active = you are in contact. Nurture = fits (or followed), nothing happening now. Closed = won, lost, not a fit, removed or outside your range. */
export function stageOf(i: StageInput): { stage: Stage; why: string } {
  if (i.removed) return { stage: "closed", why: "Removed" };
  if (i.won) return { stage: "closed", why: "Won" };
  if (i.customer) return { stage: "closed", why: "Already a customer" };
  if (i.notFit) return { stage: "closed", why: "Marked as not a fit" };
  if (["contacted", "replied", "meeting"].includes(i.outreach ?? "")) return { stage: "active", why: "You are in contact" };
  if (i.lost) return { stage: "closed", why: "Lost; comes back on a new signal" };
  if (i.snoozed || i.outreach === "not_now" || i.outreach === "snoozed") return { stage: "nurture", why: "Parked for now" };
  if (i.fit === "outside") return i.watched ? { stage: "nurture", why: "Outside your range, but you follow it" } : { stage: "closed", why: "Outside your range" };
  if (i.fit === "unknown") return { stage: "candidate", why: "Size, stage and place not checked yet" };
  if (!i.hasBuyer) return { stage: "qualified", why: "Fits; no buyer-matching person yet" };
  if (i.heat === "hot" || i.heat === "warm") return { stage: "ready", why: "Fits, has a buyer-matching person and something is happening" };
  return { stage: "nurture", why: "Fits, but nothing is happening right now" };
}
