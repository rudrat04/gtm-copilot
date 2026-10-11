import { sb } from "./db.ts";
import { log } from "./log.ts";
import { syncOutcome } from "./crmsync.ts";
import { loadProfile, saveProfile } from "./profile.ts";
import { tierOf } from "./score.ts";

// "Not a fit" with a reason: parks the company, remembers why (the raw material for tuning the fit settings later), updates HubSpot
// for companies already there, and for the two reasons that are about WHO the company is, keeps it from coming back.

export const NOT_FIT_REASONS = [
  ["too_big", "Too big"], ["too_small", "Too small"], ["wrong_industry", "Wrong industry"], ["competitor", "Competitor"],
  ["agency_b2c", "Agency or B2C"], ["wrong_region", "Wrong region"], ["customer", "Already a customer"], ["other", "Other"],
] as const;
export type NotFitReason = typeof NOT_FIT_REASONS[number][0];
export const isNotFitReason = (r: unknown): r is NotFitReason => NOT_FIT_REASONS.some(([k]) => k === r);
export const notFitLabel = (r: string) => NOT_FIT_REASONS.find(([k]) => k === r)?.[1] ?? r;

export async function markNotFit(accountId: string, reason: NotFitReason): Promise<{ error: string } | { ok: true; label: string; also?: string; crm: string[] }> {
  const { data: a } = await sb.from("cp_accounts").select("id,name,domain,priority_score,status,hubspot_company_id").eq("id", accountId).maybeSingle();
  if (!a) return { error: "Account not found" };
  const upd: Record<string, unknown> = { outreach_status: "not_now", next_followup_at: null, snoozed_until: null, not_fit_reason: reason, not_fit_at: new Date().toISOString(), last_touch_at: new Date().toISOString() };
  let also: string | undefined;
  if (reason === "customer") { upd.known_as = "customer"; also = "It will not be shown as a prospect."; }
  if (reason === "competitor") {
    const p = await loadProfile();
    if (!p.excludeDomains.includes(a.domain.toLowerCase())) { await saveProfile({ ...p, excludeDomains: [...p.excludeDomains, a.domain.toLowerCase()].slice(0, 30) }); also = "Added to your never-show list in Setup."; }
  }
  await sb.from("cp_accounts").update(upd).eq("id", accountId);
  await sb.from("cp_outcomes").insert({ account_id: accountId, kind: "not_fit", note: notFitLabel(reason), priority: a.priority_score, tier: tierOf(a.priority_score), signals: [] });
  const crm = await syncOutcome(accountId, "not_fit", { note: `Not a fit: ${notFitLabel(reason)}` }).catch(() => ({ synced: false, actions: [] as string[] }));
  await log("info", "not_fit", { account: a.domain, detail: { reason, crm: crm.actions } });
  return { ok: true, label: notFitLabel(reason), also, crm: crm.actions };
}
