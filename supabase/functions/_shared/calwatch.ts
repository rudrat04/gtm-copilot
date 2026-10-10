import { sb } from "./db.ts";
import { log } from "./log.ts";
import { ownerEmail, sendMail } from "./google.ts";
import { syncOutcome } from "./crmsync.ts";
import { button, esc, layout, muted } from "./emailhtml.ts";
import icp from "./icp.json" with { type: "json" };

// Calendar changes after a brief was sent: a cancelled meeting, or one moved to another time.
// Both only ever email the owner. The brief itself stays valid, so nothing is researched again.

const PAGE = "https://copilot.f1rstword.com/";
const DAY = 86_400_000;
const fmt = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: icp.owner.timezone });

type Meeting = { id: string; calendar_event_id: string; title: string | null; starts_at: string; ends_at: string | null; attendee_name: string | null; attendee_email: string | null; attendee_domain: string | null; account_id: string | null; status: string; outcome: string | null; reschedule_count: number | null };

async function notify(subject: string, headline: string, detail: string) {
  const text = `${headline}\n\n${detail}\n\nOpen the Meetings tab: ${PAGE}\n\n— Account Copilot`;
  const html = layout(`<div style="font-size:18px;font-weight:700">${esc(headline)}</div>${muted(esc(detail), 14)}${button(PAGE, "Open Meetings")}`, "Account Copilot · only you get this email");
  await sendMail(ownerEmail(), subject, text, html);
}

/** A briefed meeting was cancelled (or every outside guest dropped out). Returns true when something changed. */
export async function handleCancelled(eventId: string): Promise<boolean> {
  const { data } = await sb.from("cp_meetings").select("*").eq("calendar_event_id", eventId).maybeSingle();
  const m = data as Meeting | null;
  if (!m || m.status !== "briefed" || m.outcome || Date.parse(m.starts_at) < Date.now()) return false; // unknown, handled, debriefed or already over

  await sb.from("cp_meetings").update({ status: "cancelled", cancelled_at: new Date().toISOString() }).eq("id", m.id);
  const who = m.attendee_name ?? m.attendee_email ?? "the attendee";
  let crm: string[] = [];
  if (m.account_id) {
    // If this was the only booked meeting, the account goes back to "chasing", with a follow-up due tomorrow.
    const { count } = await sb.from("cp_meetings").select("id", { count: "exact", head: true }).eq("account_id", m.account_id).eq("status", "briefed").is("outcome", null).gt("starts_at", new Date().toISOString());
    const { data: a } = await sb.from("cp_accounts").select("outreach_status,touches").eq("id", m.account_id).maybeSingle();
    if (!count && a?.outreach_status === "meeting") {
      await sb.from("cp_accounts").update({ outreach_status: "contacted", touches: Math.max(1, a.touches ?? 0), next_followup_at: new Date(Date.now() + DAY).toISOString() }).eq("id", m.account_id);
    }
    crm = (await syncOutcome(m.account_id, "cancelled", { who, createTasks: true }).catch(() => ({ actions: [] as string[] }))).actions;
  }
  await notify(`Cancelled: ${who} · ${m.title ?? "meeting"}`, `${who} cancelled${m.attendee_domain ? ` (${m.attendee_domain})` : ""}`,
    `"${m.title ?? "Meeting"}" was on ${fmt(m.starts_at)}. It is off your list and no debrief will be asked.${crm.length ? ` HubSpot: ${crm.join(", ").toLowerCase()}.` : ""} Suggest a new time.`);
  await log("info", "meeting_cancelled", { account: m.attendee_domain ?? undefined, detail: { crm } });
  return true;
}

/** A briefed meeting moved to a new time. The brief is still valid; the debrief email follows the new end time. */
export async function handleMoved(m: Meeting, startIso: string, endIso: string | null): Promise<boolean> {
  if (Math.abs(Date.parse(startIso) - Date.parse(m.starts_at)) < 60_000) return false;
  await sb.from("cp_meetings").update({
    rescheduled_from: m.starts_at, starts_at: new Date(startIso).toISOString(), ends_at: endIso ? new Date(endIso).toISOString() : null,
    reschedule_count: (m.reschedule_count ?? 0) + 1, debrief_sent_at: null,
  }).eq("id", m.id);
  const who = m.attendee_name ?? m.attendee_email ?? "the attendee";
  await notify(`Moved: ${who} · ${m.title ?? "meeting"}`, `${who} meeting moved to ${fmt(startIso)}`,
    `"${m.title ?? "Meeting"}" was ${fmt(m.starts_at)}. Your brief still applies and the "how did it go?" email will follow the new time.`);
  await log("info", "meeting_moved", { account: m.attendee_domain ?? undefined, detail: { count: (m.reschedule_count ?? 0) + 1 } });
  return true;
}
