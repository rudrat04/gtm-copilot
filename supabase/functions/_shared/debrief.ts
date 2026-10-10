import { sb } from "./db.ts";
import { log } from "./log.ts";
import { askClaude, BudgetError, parseJson } from "./claude.ts";
import { type SyncKind, type SyncResult, syncOutcome } from "./crmsync.ts";
import { ownerEmail, sendMail } from "./google.ts";
import { button, esc, h2, layout, link, muted } from "./emailhtml.ts";
import { tierOf } from "./score.ts";
import icp from "./icp.json" with { type: "json" };

// After a meeting: one tap says how it went, an optional note becomes a short recap and a follow-up draft,
// and HubSpot follows (lead status, deal stage, note, to-do). Nothing is ever sent to the prospect.

export const OUTCOMES = ["went_well", "follow_up", "no_show", "not_fit"] as const;
export type Outcome = typeof OUTCOMES[number];
export const OUTCOME_LABEL: Record<Outcome, string> = { went_well: "Went well", follow_up: "Needs a follow-up", no_show: "No-show", not_fit: "Not a fit" };
const PAGE = "https://copilot.f1rstword.com/";
const DAY = 86_400_000;
const DEFAULT_LENGTH_MS = 45 * 60_000; // when the calendar did not give an end time

export const endsAt = (m: { starts_at: string; ends_at: string | null }) => (m.ends_at ? Date.parse(m.ends_at) : Date.parse(m.starts_at) + DEFAULT_LENGTH_MS);

// ---- Signed one-tap links: the email carries a signature only the database secret can produce ----

async function key() {
  const { data } = await sb.from("cp_state").select("value").eq("key", "cron_secret").maybeSingle();
  return data?.value ?? "";
}
async function sign(id: string, outcome: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(await key()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`debrief|${id}|${outcome}`));
  return [...new Uint8Array(sig)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function verify(id: string, outcome: string, sig: string): Promise<boolean> {
  const want = await sign(id, outcome);
  if (!sig || sig.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
const linkFor = async (id: string, o: Outcome) => `${PAGE}#debrief=${id}&o=${o}&s=${await sign(id, o)}`;

// ---- Recap from the rep's own notes ----

type Recap = { summary: string; pains: string[]; objections: string[]; next_steps: string[]; follow_up: { subject: string; body: string } };

async function writeRecap(company: string, attendee: string, outcome: Outcome, notes: string): Promise<Recap | null> {
  try {
    const raw = await askClaude({
      feature: "debrief",
      maxTokens: 900,
      system: `You turn a sales rep's rough meeting notes into a short recap and a follow-up email draft. Use ONLY what the notes say; never invent facts, numbers, names or promises. If something is not in the notes, leave it out. The email is a suggestion the rep will edit and send themselves: plain, warm, under 120 words, no hype, no emojis, signed with the rep's first name (${icp.owner.name}). Return a single JSON object and nothing else.`,
      user: `Seller: ${icp.seller.name}, ${icp.seller.pitch}
Meeting with ${attendee} at ${company}. The rep says it: ${OUTCOME_LABEL[outcome].toLowerCase()}.
Notes:
${notes.slice(0, 1500)}

JSON: {"summary": "2 sentences max", "pains": ["pain points they mentioned"], "objections": ["concerns or objections raised"], "next_steps": ["agreed or sensible next steps from the notes"], "follow_up": {"subject": "short subject", "body": "email body"}}`,
    });
    const r = parseJson<Partial<Recap>>(raw);
    const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 6) : []);
    return {
      summary: String(r.summary ?? "").slice(0, 400),
      pains: arr(r.pains), objections: arr(r.objections), next_steps: arr(r.next_steps),
      follow_up: { subject: String(r.follow_up?.subject ?? "").slice(0, 120), body: String(r.follow_up?.body ?? "").slice(0, 1500) },
    };
  } catch (e) {
    if (!(e instanceof BudgetError)) await log("warn", "recap_failed", { message: (e as Error).message });
    return null;
  }
}

const recapHtml = (r: Recap) => `<p>${esc(r.summary)}</p>${r.pains.length ? `<p><b>Pains</b></p><ul>${r.pains.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}${r.objections.length ? `<p><b>Objections</b></p><ul>${r.objections.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}${r.next_steps.length ? `<p><b>Next steps</b></p><ul>${r.next_steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}`;

// ---- Applying a debrief ----

const NEXT: Record<Outcome, { status: string; followDays: number | null }> = {
  went_well: { status: "meeting", followDays: 2 },
  follow_up: { status: "meeting", followDays: 3 },
  no_show: { status: "contacted", followDays: 1 },
  not_fit: { status: "not_now", followDays: null },
};

export async function applyDebrief(meetingId: string, outcome: Outcome, notes?: string): Promise<{ error: string } | { ok: true; meeting: Record<string, unknown>; crm: SyncResult; recap: Recap | null; first: boolean }> {
  const { data: m } = await sb.from("cp_meetings").select("*").eq("id", meetingId).maybeSingle();
  if (!m) return { error: "Meeting not found" };
  const first = !m.debriefed_at || m.outcome !== outcome;
  const text = (notes ?? "").trim().slice(0, 1500);
  let recap: Recap | null = (m.recap as Recap | null) ?? null;
  const attendee = m.attendee_name ?? m.attendee_email ?? "the attendee";

  const { data: a } = m.account_id ? await sb.from("cp_accounts").select("id,name,domain,priority_score,touches").eq("id", m.account_id).maybeSingle() : { data: null };
  if (text && text !== m.notes) recap = await writeRecap(a?.name ?? m.attendee_domain ?? "their company", attendee, outcome, text);

  let crm: SyncResult = { synced: false, actions: [] };
  if (a) {
    if (first) {
      const next = NEXT[outcome];
      await sb.from("cp_accounts").update({
        outreach_status: next.status, last_touch_at: new Date().toISOString(), snoozed_until: null,
        next_followup_at: next.followDays ? new Date(Date.now() + next.followDays * DAY).toISOString() : null,
      }).eq("id", a.id);
      await sb.from("cp_outcomes").insert({ account_id: a.id, kind: `debrief_${outcome}`, note: text || null, priority: a.priority_score, tier: tierOf(a.priority_score), signals: [] });
    }
    crm = await syncOutcome(a.id, outcome as SyncKind, {
      who: attendee, recapHtml: recap ? recapHtml(recap) : text ? `<p>${esc(text)}</p>` : "", createTasks: first,
    }).catch(() => crm);
  }
  const { data: updated } = await sb.from("cp_meetings").update({
    outcome, debriefed_at: m.debriefed_at && !first ? m.debriefed_at : new Date().toISOString(),
    notes: text || m.notes, recap,
    crm_sync: first || !m.crm_sync ? crm : { synced: true, actions: [...((m.crm_sync as SyncResult).actions ?? []), ...crm.actions] }, // adding notes later appends to what was done
  }).eq("id", meetingId).select("*").single();
  await log("info", "debrief_saved", { account: a?.domain, detail: { outcome, notes: !!text, recap: !!recap, crm: crm.actions.length } });
  return { ok: true, meeting: updated ?? m, crm, recap, first };
}

// ---- The email that asks "how did it go?" ----

export async function sendDueDebriefs(): Promise<number> {
  const since = new Date(Date.now() - 3 * DAY).toISOString();
  const { data: rows } = await sb.from("cp_meetings").select("*")
    .eq("status", "briefed").is("outcome", null).is("debrief_sent_at", null).gt("starts_at", since).lt("starts_at", new Date().toISOString());
  let sent = 0;
  for (const m of rows ?? []) {
    if (endsAt(m) + 5 * 60_000 > Date.now()) continue; // wait until it is really over
    const who = m.attendee_name ?? m.attendee_email ?? "your meeting";
    const company = m.attendee_domain ?? "";
    const links = await Promise.all(OUTCOMES.map(async (o) => [o, await linkFor(m.id, o)] as const));
    const text = `How did "${m.title ?? "your meeting"}" with ${who}${company ? ` (${company})` : ""} go?\n\nOne tap records it, updates HubSpot and sets the next step:\n${links.map(([o, u]) => `  ${OUTCOME_LABEL[o]}: ${u}`).join("\n")}\n\nAfter tapping you can add two lines of notes and get a recap plus a follow-up email draft.\n\n— Account Copilot · nothing is sent to ${who}`;
    const html = layout(
      `<div style="font-size:19px;font-weight:700">How did it go with ${esc(who)}?</div>${muted(`${esc(m.title ?? "Meeting")}${company ? ` · ${esc(company)}` : ""}`)}
       ${h2("One tap")}<div>${links.map(([o, u]) => `<div style="margin:6px 0">${button(u, OUTCOME_LABEL[o])}</div>`).join("")}</div>
       ${muted("It updates HubSpot (lead status, deal stage, a to-do) and then lets you add two lines of notes for a recap and a follow-up draft.")}`,
      `Account Copilot · nothing is sent to ${esc(who)} · ${link(PAGE, "Open the Meetings tab")}`,
    );
    try {
      await sendMail(ownerEmail(), `How did it go? ${company || who} · ${who}`, text, html);
      await sb.from("cp_meetings").update({ debrief_sent_at: new Date().toISOString() }).eq("id", m.id);
      sent++;
    } catch (e) {
      await log("warn", "debrief_email_failed", { message: (e as Error).message, detail: { meeting: m.id } });
    }
  }
  if (sent) await log("info", "debrief_emails_sent", { detail: { sent } });
  return sent;
}
