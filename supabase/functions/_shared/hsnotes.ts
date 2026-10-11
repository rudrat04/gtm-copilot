import { sb } from "./db.ts";
import { log } from "./log.ts";
import { logNote } from "./hubspot.ts";

// Keeps the HubSpot record complete: the meeting brief and any draft we write also land there as notes, so the whole
// history of an account can be found in one place. Only for companies already in HubSpot; a failure never blocks the caller.

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const lines = (t: string) => esc(t).replace(/\n/g, "<br>");

export function briefNoteHtml(meetingTitle: string, when: string, briefText: string): string {
  return `<p><b>F1rstword: meeting brief</b> · ${esc(meetingTitle)} · ${esc(when)}</p><p><i>Internal. Not shared with the guest.</i></p><p>${lines(briefText)}</p>`;
}

export function draftNoteHtml(d: { persona?: string | null; subject: string; body: string }): string {
  return `<p><b>F1rstword: draft first-touch email</b> (a suggestion, <u>not sent</u>)${d.persona ? ` · for ${esc(d.persona)}` : ""}</p><p><b>Subject:</b> ${esc(d.subject)}</p><p>${lines(d.body)}</p>`;
}

/** Adds the note to the account's HubSpot company, if it has one. Returns whether a note was written. */
export async function noteToHubSpot(accountId: string | null, html: string, what: string): Promise<boolean> {
  if (!accountId) return false;
  try {
    const { data: a } = await sb.from("cp_accounts").select("domain,hubspot_company_id").eq("id", accountId).maybeSingle();
    if (!a?.hubspot_company_id) return false;
    const ok = await logNote(html, { companyId: a.hubspot_company_id });
    if (!ok) await log("warn", "hubspot_note_failed", { account: a.domain, message: `Could not save the ${what} note in HubSpot` });
    return ok;
  } catch (e) {
    await log("warn", "hubspot_note_failed", { message: `${what}: ${(e as Error).message}` });
    return false;
  }
}
