import { normalizeDomain, sb } from "./db.ts";
import { log } from "./log.ts";
import { readCustomerCompanies, readDeals, readTaskStatuses, searchLostDeals } from "./hubspot.ts";
import { applyOutcome } from "./lifecycle.ts";
import { askLossReasons } from "./lossreason.ts";

// Reads HubSpot back so the app follows what happens there: to-dos the rep completes, the deal stage, and deals
// closed as lost (which become Revival candidates). It never writes to HubSpot itself; the only related write is the lost reason the owner picks (see lossreason.ts).

const DAY = 86_400_000;
const OPEN_STAGES = new Set(["appointmentscheduled", "qualifiedtobuy", "presentationscheduled", "decisionmakerboughtin", "contractsent"]);

export type BackSummary = { tasks_done: number; marked_contacted: number; deals_changed: number; lost_found: number; imported: number; customers?: number; asked?: number; skipped?: string };

export async function syncFromHubSpot(): Promise<BackSummary> {
  const out: BackSummary = { tasks_done: 0, marked_contacted: 0, deals_changed: 0, lost_found: 0, imported: 0 };
  if (!Deno.env.get("HUBSPOT_TOKEN")) return { ...out, skipped: "HubSpot is not connected" };

  // 1) To-dos we created that the rep has completed.
  const { data: tasks } = await sb.from("cp_tasks").select("key,account_id,hubspot_task_id")
    .is("done_at", null).not("hubspot_task_id", "is", null).not("key", "like", "sum:%").gt("created_at", new Date(Date.now() - 30 * DAY).toISOString()).limit(200);
  if (tasks?.length) {
    const status = await readTaskStatuses(tasks.map((t) => t.hubspot_task_id!));
    for (const t of tasks) {
      if (status.get(t.hubspot_task_id!) !== "COMPLETED") continue;
      await sb.from("cp_tasks").update({ done_at: new Date().toISOString() }).eq("key", t.key);
      out.tasks_done++;
      if (!t.account_id) continue;
      const { data: a } = await sb.from("cp_accounts").select("id,domain,outreach_status,next_followup_at").eq("id", t.account_id).maybeSingle();
      if (!a) continue;
      if (t.key.startsWith("hot:") || t.key.startsWith("fu:")) {
        // Doing the outreach to-do means the rep reached out. Only an account still waiting counts.
        const due = a.next_followup_at && Date.parse(a.next_followup_at) <= Date.now();
        if (a.outreach_status === "open" || (a.outreach_status === "contacted" && due)) {
          await applyOutcome(a.id, "contacted", { note: "Completed the to-do in HubSpot", skipSync: true });
          out.marked_contacted++;
        }
      } else if (t.key.startsWith("post:") && a.outreach_status === "meeting") {
        await sb.from("cp_accounts").update({ next_followup_at: null }).eq("id", a.id); // the post-meeting step is done
      }
      await log("info", "crm_task_completed", { account: a.domain, detail: { key: t.key.split(":")[0] } });
    }
  }

  // 2) The deal we opened: follow its stage.
  const { data: ours } = await sb.from("cp_accounts").select("id,domain,deal_stage,hubspot_deal_id,outreach_status").not("hubspot_deal_id", "is", null);
  if (ours?.length) {
    const deals = await readDeals(ours.map((a) => a.hubspot_deal_id!));
    for (const a of ours) {
      const d = deals.get(a.hubspot_deal_id!);
      if (!d) { // deleted in HubSpot
        await sb.from("cp_accounts").update({ hubspot_deal_id: null, deal_stage: null }).eq("id", a.id);
        continue;
      }
      if (d.stage === a.deal_stage) continue;
      if (a.deal_stage == null) { await sb.from("cp_accounts").update({ deal_stage: d.stage }).eq("id", a.id); continue; } // first look at an older deal: just remember where it is
      const upd: Record<string, unknown> = { deal_stage: d.stage };
      let note = `Deal moved to ${d.stage} in HubSpot`;
      if (d.stage === "closedlost") {
        Object.assign(upd, { outreach_status: "not_now", next_followup_at: null, lost_at: d.closedAt ?? new Date().toISOString(), lost_reason: d.lostReason });
        note = `Deal closed lost in HubSpot${d.lostReason ? `: ${d.lostReason}` : ""}`;
      } else if (d.stage === "closedwon") {
        Object.assign(upd, { won_at: d.closedAt ?? new Date().toISOString(), next_followup_at: null, known_as: "customer" });
        note = "Deal won in HubSpot";
      } else if (OPEN_STAGES.has(d.stage)) {
        Object.assign(upd, { lost_at: null, lost_reason: null });
        if (a.outreach_status !== "meeting") Object.assign(upd, { outreach_status: "meeting" });
      }
      await sb.from("cp_accounts").update(upd).eq("id", a.id);
      await sb.from("cp_outcomes").insert({ account_id: a.id, kind: d.stage === "closedlost" ? "not_now" : "meeting", note, priority: null, tier: null, signals: [] });
      out.deals_changed++;
      await log("info", "crm_deal_changed", { account: a.domain, message: note });
    }
  }

  // 3) Deals closed as lost anywhere in HubSpot: remember them on the matching account (importing the company
  //    when we do not have it), so a fresh signal can bring them back (Revival).
  const lost = await searchLostDeals(50);
  out.lost_found = lost.length;
  let imports = 0;
  for (const l of lost) {
    if (!l.companyId) continue;
    const domain = l.domain ? normalizeDomain(l.domain) : null;
    let { data: a } = await sb.from("cp_accounts").select("id,lost_at,hubspot_deal_id").eq("hubspot_company_id", l.companyId).maybeSingle();
    if (!a && domain) ({ data: a } = await sb.from("cp_accounts").select("id,lost_at,hubspot_deal_id").eq("domain", domain).maybeSingle());
    if (!a) {
      if (!domain || imports >= 10) continue;
      const ins = await sb.from("cp_accounts").insert({ domain, name: l.companyName ?? domain, source: "hubspot", status: "new", hubspot_company_id: l.companyId }).select("id,lost_at,hubspot_deal_id").single();
      if (ins.error || !ins.data) continue;
      a = ins.data; imports++; out.imported++;
    }
    if (a.hubspot_deal_id === l.dealId) continue; // our own deal: handled above
    const when = l.closedAt ?? new Date().toISOString();
    if (!a.lost_at || Date.parse(when) > Date.parse(a.lost_at)) {
      await sb.from("cp_accounts").update({ lost_at: when, lost_reason: l.reason, hubspot_company_id: l.companyId }).eq("id", a.id);
    }
  }
  // 3b) Companies HubSpot already knows as customers are not prospects. Once a day, and only for accounts we already track.
  const { data: cs } = await sb.from("cp_state").select("value").eq("key", "customers_synced").maybeSingle();
  if (!cs?.value || Date.now() - Date.parse(cs.value) > 20 * 3_600_000) {
    await sb.from("cp_state").upsert({ key: "customers_synced", value: new Date().toISOString(), updated_at: new Date().toISOString() });
    const customers = await readCustomerCompanies(100);
    const ids = new Set(customers.map((c) => c.id)), domains = new Set(customers.map((c) => c.domain).filter(Boolean));
    const { data: tracked } = await sb.from("cp_accounts").select("id,domain,hubspot_company_id,known_as,won_at");
    for (const a of tracked ?? []) {
      const isCustomer = (a.hubspot_company_id && ids.has(a.hubspot_company_id)) || domains.has(a.domain);
      if (isCustomer && a.known_as !== "customer") { await sb.from("cp_accounts").update({ known_as: "customer" }).eq("id", a.id); out.customers = (out.customers ?? 0) + 1; }
      else if (!isCustomer && a.known_as === "customer" && !a.won_at && customers.length < 100) await sb.from("cp_accounts").update({ known_as: null }).eq("id", a.id); // no longer a customer there
    }
  }

  // 4) Lost deals of ours with no reason: one email with five one-tap choices (once per deal).
  out.asked = await askLossReasons().catch(() => 0);

  if (out.tasks_done || out.deals_changed || out.imported || out.asked || out.customers) await log("info", "crm_read_back", { detail: out });
  return out;
}
