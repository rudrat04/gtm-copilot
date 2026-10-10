import { sb } from "./db.ts";
import { log } from "./log.ts";
import { createDeal, createTask, type DealStage, type LeadStatus, logNote, moveDeal, setLeadStatus } from "./hubspot.ts";
import { esc } from "./emailhtml.ts";
import icp from "./icp.json" with { type: "json" };

// Keeps HubSpot in step with what the rep does here. Only for accounts we already pushed to HubSpot, only on
// records Account Copilot created (the company, its contacts and the one deal we open). Best effort: a HubSpot
// problem is logged and reported, but never blocks the action in the app.

export type SyncKind = "contacted" | "replied" | "meeting" | "snooze" | "not_now" | "went_well" | "follow_up" | "no_show" | "not_fit";

const LEAD: Partial<Record<SyncKind, LeadStatus>> = {
  contacted: "ATTEMPTED_TO_CONTACT", replied: "CONNECTED", meeting: "IN_PROGRESS", snooze: "BAD_TIMING", not_now: "BAD_TIMING",
  went_well: "OPEN_DEAL", follow_up: "IN_PROGRESS", not_fit: "UNQUALIFIED",
};
const DEAL: Partial<Record<SyncKind, DealStage>> = { meeting: "appointmentscheduled", went_well: "qualifiedtobuy", follow_up: "appointmentscheduled", not_fit: "closedlost" };
const LABEL: Record<SyncKind, string> = {
  contacted: "Marked contacted", replied: "They replied", meeting: "Meeting booked", snooze: "Snoozed", not_now: "Marked not now",
  went_well: "Meeting went well", follow_up: "Meeting needs a follow-up", no_show: "No-show", not_fit: "Not a fit",
};
const TASK: Partial<Record<SyncKind, { subject: (who: string) => string; days: number }>> = {
  went_well: { subject: (w) => `Send the recap and propose a next step: ${w}`, days: 1 },
  follow_up: { subject: (w) => `Follow up after the meeting: ${w}`, days: 3 },
  no_show: { subject: (w) => `Reschedule: ${w} did not show`, days: 1 },
};
const DAY = 86_400_000;

export type SyncResult = { synced: boolean; actions: string[]; skipped?: string };

export async function syncOutcome(accountId: string, kind: SyncKind, ctx: { note?: string; who?: string; recapHtml?: string; createTasks?: boolean } = {}): Promise<SyncResult> {
  const actions: string[] = [];
  const { data: a } = await sb.from("cp_accounts").select("id,name,domain,hubspot_company_id,hubspot_deal_id").eq("id", accountId).maybeSingle();
  if (!a) return { synced: false, actions, skipped: "Account not found" };
  if (!a.hubspot_company_id) return { synced: false, actions, skipped: "Not in HubSpot yet" };

  const { data: ppl } = await sb.from("cp_people").select("first_name,last_name,hubspot_contact_id,relevance")
    .eq("account_id", accountId).not("hubspot_contact_id", "is", null).order("relevance", { ascending: false }).limit(1);
  const contact = ppl?.[0];
  const contactId = contact?.hubspot_contact_id ?? null;
  const who = ctx.who ?? (contact ? `${contact.first_name} ${contact.last_name}`.trim() : a.name);
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      actions.push(name);
    } catch (e) {
      await log("warn", "crm_sync_step_failed", { account: a.domain, message: `${name}: ${(e as Error).message}` });
    }
  };

  const lead = LEAD[kind];
  if (lead && contactId) await step(`Lead status: ${lead.replace(/_/g, " ").toLowerCase()}`, async () => { if (!(await setLeadStatus(contactId, lead))) throw new Error("lead status"); });

  // One deal per account, created when a meeting is booked and moved as it goes. Never touches deals we did not create.
  const stage = DEAL[kind];
  let dealId: string | null = a.hubspot_deal_id;
  if (stage) {
    if (!dealId && stage !== "closedlost") {
      await step("Deal opened", async () => {
        dealId = await createDeal({ name: `${a.name} · ${icp.seller.name}`, stage, companyId: a.hubspot_company_id!, contactId, ownerId: icp.owner.hubspotOwnerId });
        await sb.from("cp_accounts").update({ hubspot_deal_id: dealId }).eq("id", accountId);
      });
    } else if (dealId) {
      const id = dealId;
      await step(`Deal moved to ${stage === "closedlost" ? "closed lost" : stage === "qualifiedtobuy" ? "qualified to buy" : "appointment scheduled"}`, async () => { if (!(await moveDeal(id, stage))) throw new Error("deal"); });
    }
  }

  const body = `<p><b>Account Copilot:</b> ${esc(LABEL[kind])}${ctx.note ? ` · ${esc(ctx.note)}` : ""}</p>${ctx.recapHtml ?? ""}`;
  await step("Note added", async () => { if (!(await logNote(body, { companyId: a.hubspot_company_id, contactId }))) throw new Error("note"); });

  const t = TASK[kind];
  if (t && ctx.createTasks) {
    await step("To-do created", async () => {
      await createTask({ subject: t.subject(who), html: `<p>${esc(LABEL[kind])} (${esc(a.name)}).</p>`, dueIso: new Date(Date.now() + t.days * DAY).toISOString(), priority: "HIGH", ownerId: icp.owner.hubspotOwnerId, companyId: a.hubspot_company_id, contactId });
    });
  }
  await log("info", "crm_synced", { account: a.domain, detail: { kind, actions } });
  return { synced: actions.length > 0, actions };
}
