import { sb } from "./db.ts";
import { log } from "./log.ts";
import { ownerEmail, sendMail } from "./google.ts";
import { button, esc, h2, layout, link, muted } from "./emailhtml.ts";
import { setDealLostReason } from "./hubspot.ts";
import { sign, verify } from "./debrief.ts";

// When a deal we opened is lost and nobody gave a reason, the owner gets one email with five one-tap choices.
// The answer is stored on the account and written to that deal in HubSpot (only deals we created). Nothing goes to the prospect.

export const LOSS_REASONS = ["price", "timing", "competitor", "no_budget", "no_reply"] as const;
export type LossReason = typeof LOSS_REASONS[number];
export const LOSS_LABEL: Record<LossReason, string> = { price: "Price", timing: "Timing", competitor: "Went with a competitor", no_budget: "No budget", no_reply: "Went quiet" };
const PAGE = "https://copilot.f1rstword.com/";
const DAY = 86_400_000;
const NS = "loss";

export const isLossReason = (r: unknown): r is LossReason => (LOSS_REASONS as readonly string[]).includes(String(r));
export const verifyLoss = (accountId: string, reason: string, sig: string) => verify(accountId, reason, sig, NS);

/** Lost deals of ours with no reason yet and no email sent: ask once. At most 3 a run. */
import { mailOn } from "./switches.ts";
export async function askLossReasons(): Promise<number> {
  if (!mailOn("loss")) return 0;
  const { data: rows } = await sb.from("cp_accounts").select("id,name,domain,lost_at")
    .not("hubspot_deal_id", "is", null).eq("deal_stage", "closedlost").is("lost_reason", null).is("loss_asked_at", null)
    .gt("lost_at", new Date(Date.now() - 14 * DAY).toISOString()).limit(3);
  let sent = 0;
  for (const a of rows ?? []) {
    const links = await Promise.all(LOSS_REASONS.map(async (r) => [r, `${PAGE}#loss=${a.id}&r=${r}&s=${await sign(a.id, r, NS)}`] as const));
    const text = `The deal with ${a.name} is closed lost. Why? One tap records it and writes it to the deal in HubSpot:\n${links.map(([r, u]) => `  ${LOSS_LABEL[r]}: ${u}`).join("\n")}\n\n— F1rstword · nothing is sent to ${a.name}`;
    const html = layout(
      `<div style="font-size:19px;font-weight:700">Why was ${esc(a.name)} lost?</div>${muted("One tap records it on the account and on the deal in HubSpot.")}
       ${h2("Pick one")}<div>${links.map(([r, u]) => `<div style="margin:6px 0">${button(u, LOSS_LABEL[r])}</div>`).join("")}</div>`,
      `F1rstword · nothing is sent to ${esc(a.name)} · ${link(PAGE, "Open the app")}`,
    );
    try {
      await sendMail(ownerEmail(), `Why was it lost? ${a.name}`, text, html);
      await sb.from("cp_accounts").update({ loss_asked_at: new Date().toISOString() }).eq("id", a.id);
      sent++;
    } catch (e) {
      await log("warn", "loss_email_failed", { account: a.domain, message: (e as Error).message });
    }
  }
  if (sent) await log("info", "loss_emails_sent", { detail: { sent } });
  return sent;
}

/** Stores the reason, logs it, and writes it to the deal we opened. A HubSpot problem never blocks the local record. */
export async function applyLossReason(accountId: string, reason: LossReason): Promise<{ error: string } | { ok: true; label: string; hubspot: boolean }> {
  const { data: a } = await sb.from("cp_accounts").select("id,domain,lost_at,hubspot_deal_id").eq("id", accountId).maybeSingle();
  if (!a) return { error: "Account not found" };
  if (!a.lost_at) return { error: "That account has no lost deal" };
  const label = LOSS_LABEL[reason];
  await sb.from("cp_accounts").update({ lost_reason: label }).eq("id", accountId);
  await sb.from("cp_outcomes").insert({ account_id: accountId, kind: "loss_reason", note: label, priority: null, tier: null, signals: [] });
  let hubspot = false;
  if (a.hubspot_deal_id) {
    try {
      hubspot = await setDealLostReason(a.hubspot_deal_id, label);
      if (!hubspot) await log("warn", "loss_reason_hubspot_rejected", { account: a.domain, message: "HubSpot did not accept the lost reason; it is saved here only" });
    } catch (e) {
      await log("warn", "loss_reason_hubspot_failed", { account: a.domain, message: (e as Error).message });
    }
  }
  await log("info", "loss_reason", { account: a.domain, detail: { reason, hubspot } });
  return { ok: true, label, hubspot };
}
