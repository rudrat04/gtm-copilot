import { sb } from "./db.ts";
import { log } from "./log.ts";
import { tierOf } from "./score.ts";
import icp from "./icp.json" with { type: "json" };

export type OutcomeKind = "contacted" | "replied" | "meeting" | "snooze" | "not_now" | "reopen";
const DAY = 86_400_000;

/**
 * Applies one rep action to an account and records it. `contacted_at` is the FIRST contact; follow-ups
 * fall on fixed days after it (3, 7, 14), then stop. Every action is logged with a snapshot of the
 * scores and signals at that moment, which is the raw material for "which signals convert".
 */
export async function applyOutcome(accountId: string, kind: OutcomeKind, opts: { days?: number; note?: string } = {}) {
  const { data: a } = await sb.from("cp_accounts").select("*").eq("id", accountId).maybeSingle();
  if (!a) return { error: "Account not found" as const };

  const now = new Date();
  const update: Record<string, unknown> = { last_touch_at: now.toISOString() };
  let logKind: string = kind;

  switch (kind) {
    case "contacted": {
      const touches = (a.touches ?? 0) + 1;
      const first = a.contacted_at ? new Date(a.contacted_at) : now;
      const offsets = icp.followUp.days;
      const nextOffset = offsets[touches - 1]; // touch 1 -> day 3, touch 2 -> day 7, touch 3 -> day 14
      let next: Date | null = nextOffset != null ? new Date(first.getTime() + nextOffset * DAY) : null;
      if (next && next.getTime() < now.getTime() + DAY) next = new Date(now.getTime() + DAY); // never due in the past
      Object.assign(update, {
        outreach_status: "contacted", touches, contacted_at: first.toISOString(), next_followup_at: next?.toISOString() ?? null,
        snoozed_until: null,
      });
      break;
    }
    case "replied":
      Object.assign(update, { outreach_status: "replied", next_followup_at: null, snoozed_until: null });
      break;
    case "meeting":
      Object.assign(update, { outreach_status: "meeting", next_followup_at: null, snoozed_until: null });
      break;
    case "snooze": {
      const days = [7, 14, 30].includes(Number(opts.days)) ? Number(opts.days) : 7;
      Object.assign(update, {
        outreach_status: "snoozed", snoozed_until: new Date(now.getTime() + days * DAY).toISOString(), next_followup_at: null,
      });
      logKind = "snoozed";
      break;
    }
    case "not_now":
      Object.assign(update, { outreach_status: "not_now", next_followup_at: null, snoozed_until: null });
      break;
    case "reopen":
      Object.assign(update, { outreach_status: "open", touches: 0, contacted_at: null, next_followup_at: null, snoozed_until: null });
      logKind = "reopened";
      break;
  }

  const { error } = await sb.from("cp_accounts").update(update).eq("id", accountId);
  if (error) {
    await log("error", "outcome_update_failed", { account: a.domain, message: error.message });
    return { error: error.message };
  }

  const { data: sigs } = await sb.from("cp_signals").select("kind,title,detected_at").eq("account_id", accountId)
    .order("detected_at", { ascending: false }).limit(6);
  await sb.from("cp_outcomes").insert({
    account_id: accountId, kind: logKind, note: opts.note ?? null,
    priority: a.priority_score, tier: tierOf(a.priority_score), signals: sigs ?? [],
  });
  await log("info", "outcome", { account: a.domain, detail: { kind, touches: update.touches ?? a.touches, next: update.next_followup_at ?? null } });
  return { ok: true as const, update };
}
