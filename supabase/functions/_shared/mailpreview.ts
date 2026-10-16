import { alertEmail, digestEmail } from "./templates.ts";
import { buildBriefHtml } from "./brief.ts";
import { button, esc, h2, layout, list, muted, quote } from "./emailhtml.ts";

// Sample versions of every message, built with made-up people and companies, so a rep can see what each one looks like. Nothing is sent and nothing real is read.

const company = { id: "a1", name: "Northwind Labs", domain: "northwind.example", tier: "tier_2", priority: 62, fit: 74, status: "queued", outreach: "open", firmo: "51-250 people · Series A · $12M raised · Bengaluru" };
const contact = { id: "p1", name: "Asha Rao", title: "Head of Sales", persona: "Sales", email: "asha@northwind.example", email_status: "valid" };
const contact2 = { id: "p2", name: "Dev Menon", title: "Co-Founder", persona: "Executive", email: "dev@northwind.example", email_status: "valid" };
const sig = (title: string, published: string | null = null) => ({ kind: "news", title, url: null, first_seen: new Date().toISOString(), published, is_new: true });
const base = { why: "Northwind Labs is hiring a Revenue Operations Manager and just raised a Series A, a sign the sales team is scaling.", last_action: null, due: null, meeting: null };
const foot = "Sample only: made-up names, nothing was sent.";
const wrap = (subject: string, inner: string) => ({ subject, html: layout(inner, foot) });

export type PreviewKind = "hot" | "watchlist" | "daily" | "flags" | "briefs" | "debrief" | "calendar" | "leads" | "loss";
export const PREVIEW_KINDS: PreviewKind[] = ["hot", "watchlist", "daily", "flags", "briefs", "debrief", "calendar", "leads", "loss"];

export function previewMail(kind: PreviewKind): { subject: string; html: string } {
  if (kind === "hot" || kind === "watchlist") {
    // deno-lint-ignore no-explicit-any
    const a = alertEmail({ name: company.name, tier: company.tier, domain: company.domain, firmo: company.firmo, watched: kind === "watchlist" }, { title: "Hiring: Revenue Operations Manager", published: null }, base.why, [contact, contact2] as any);
    return { subject: a.subject, html: a.html };
  }
  if (kind === "daily") {
    const items = [
      { ...base, key: "1", type: "hot", label: "Hot now", urgency: 1, account: company, headline: "New signal", reason: "", signals: [sig("Hiring: Revenue Operations Manager"), sig("Northwind Labs raises $12M Series A", new Date(Date.now() - 4 * 86400000).toISOString())], contacts: [contact, contact2] },
      { ...base, key: "2", type: "follow_up", label: "Follow-up due", urgency: 1, account: { ...company, id: "a2", name: "Brightleaf" }, headline: "Follow up #1 of 3, 2d overdue", reason: "", signals: [sig("Hiring: Sales Operations Manager")], contacts: [{ ...contact, name: "Priya Shah", title: "VP Sales" }] },
    ];
    // deno-lint-ignore no-explicit-any
    const d = digestEmail(items as any, 0, new Map(), { items: [{ severity: "warn", title: "Follow-up overdue: Brightleaf", detail: "Two days past the date" }], total: 1 });
    return { subject: d.subject, html: d.html };
  }
  if (kind === "flags") {
    return wrap("Needs attention: 2 things are slipping", `${h2("Needs attention")}${list([`<b>Hot company, nobody has reached out</b>: Northwind Labs showed a new signal 3 days ago and has not been contacted.`, `<b>Inbound lead past the reply target</b>: a demo request from Asha Rao has waited 75 minutes.`])}${button("https://copilot.f1rstword.com/", "Open your To-do")}`);
  }
  if (kind === "briefs") {
    return { subject: "Brief: Intro call with Asha Rao (Northwind Labs)", html: buildBriefHtml({
      company: company.name, domain: company.domain, meetingTitle: "Intro call", when: "Mon, 19 Oct, 15:00 (Asia/Kolkata)", attendee: { name: "Asha Rao", title: "Head of Sales" }, others: ["Dev Menon"], fit: 74, priority: 62, tierLabel: "Tier 2",
      dossier: { summary: "Northwind Labs sells scheduling software to clinics.", why_now: "Hiring a Revenue Operations Manager after a Series A.", pains: ["Pipeline data quality as the team grows"], risks: ["Recent hires may still be settling in"], talk_tracks: [{ angle: "Pipeline visibility", opener: "How are you tracking pipeline as the new team ramps?" }] } as never,
      signals: [{ kind: "hiring", title: "Hiring: Revenue Operations Manager", age: "today" }, { kind: "news", title: "Northwind Labs raises $12M Series A", age: "4 days ago" }],
      hubspot: { company: "Company: not in HubSpot", contact: "Contact: not in HubSpot", lastContacted: "never", deals: 0 }, pageUrl: "https://copilot.f1rstword.com/" }) };
  }
  if (kind === "debrief") {
    return wrap("How did it go? Intro call with Asha Rao", `<p style="margin:0 0 8px">Your meeting with <b>Asha Rao</b> at <b>Northwind Labs</b> ended 5 minutes ago. One tap saves the outcome:</p>${["Went well", "Needs a follow-up", "No-show", "Not a fit"].map((t) => `<div style="margin:6px 0">${button("#", t)}</div>`).join("")}${muted("Optionally add a note afterwards and the system writes a recap and a follow-up draft from it.")}`);
  }
  if (kind === "calendar") {
    return wrap("Meeting moved: Intro call with Asha Rao", `<p style="margin:0 0 8px">The meeting with <b>Asha Rao</b> (Northwind Labs) moved from <b>Mon 19 Oct, 15:00</b> to <b>Tue 20 Oct, 11:00</b>.</p>${muted("The debrief email is re-armed for the new time. If it was cancelled instead, the company goes back to your follow-up list with a task to reschedule.")}`);
  }
  if (kind === "leads") {
    return wrap("New lead: Asha Rao, Northwind Labs (demo request)", `<p style="margin:0 0 8px"><b>Asha Rao</b>, Head of Sales at <b>Northwind Labs</b>, asked for a demo.</p>${quote("Why now:", "Fits your profile and is hiring a RevOps manager right now.")}${list(["Reply target: within 30 minutes", "Came from: LinkedIn post"])}${button("#", "Open the lead")}${muted("If it is still unanswered after the target, one reminder follows.")}`);
  }
  return wrap("Why was Northwind Labs lost?", `<p style="margin:0 0 8px">The deal with <b>Northwind Labs</b> was closed lost in HubSpot with no reason. One tap fills it in:</p>${["Price", "Timing", "Went with a competitor", "No budget", "Went quiet"].map((t) => `<div style="margin:6px 0">${button("#", t)}</div>`).join("")}`);
}
export { esc };
