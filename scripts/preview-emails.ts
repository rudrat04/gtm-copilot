// Renders the three internal emails with sample data so their layout can be checked in a browser.
// Run: SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno run --allow-env --allow-write scripts/preview-emails.ts /tmp/emails
import { alertEmail, digestEmail } from "../supabase/functions/_shared/templates.ts";
import { buildBrief, buildBriefHtml } from "../supabase/functions/_shared/brief.ts";

const out = Deno.args[0] ?? "/tmp/emails";
await Deno.mkdir(out, { recursive: true });

const resend = {
  id: "a1", name: "Resend", domain: "resend.com", tier: "tier_2", priority: 60, fit: 74, status: "queued", outreach: "open",
  firmo: "51-250 people · Series A · $22M raised · San Francisco",
};
const contact = { id: "p1", name: "Jonni Lundy", title: "Co-Founder", persona: "Founder / CEO", email: "jonni@resend.com", email_status: "valid" };
const contact2 = { id: "p2", name: "Alex Rivera", title: "VP of Sales", persona: "Head of Sales / VP Sales", email: "alex@resend.com", email_status: "valid" };
const sig = (title: string, published: string | null = null, first_seen = new Date().toISOString()) =>
  ({ kind: "news", title, url: null, first_seen, published, is_new: true });

const base = { why: "Resend is hiring a Technical Account Executive and just opened 14 roles, a sign the sales team is scaling.", last_action: null, due: null, meeting: null };
const items = [
  { ...base, key: "1", type: "hot", label: "Hot now", urgency: 1, account: resend, headline: "New signal", reason: "", signals: [sig("Hiring: Technical Account Executive"), sig("Resend raises $22M Series A", new Date(Date.now() - 4 * 86400000).toISOString())], contacts: [contact, contact2] },
  { ...base, key: "2", type: "follow_up", label: "Follow-up due", urgency: 1, account: { ...resend, id: "a2", name: "Orb", firmo: "51-250 people · Series B · $39M raised · San Francisco", tier: "tier_1", priority: 84 }, headline: "Follow up #1 of 3, 2d overdue · first contact 5d ago", reason: "", signals: [sig("Hiring: Enterprise Account Executive")], contacts: [{ ...contact, name: "Priya Shah", title: "Head of RevOps", email: "priya@withorb.com" }], last_action: "contacted 5d ago" },
  { ...base, key: "3", type: "new", label: "New this week", urgency: 1, account: { ...resend, id: "a3", name: "Pylon" }, headline: "New signal this week", reason: "Hiring 2 sales/RevOps roles", why: "", signals: [], contacts: [] },
  { ...base, key: "4", type: "meeting", label: "Meeting", urgency: 1, account: null, headline: "Intro call with Rudra (f1rstword.com)", reason: "", signals: [], contacts: [], meeting: { title: "Intro call", starts_at: new Date(Date.now() + 86400000).toISOString(), briefed: true } },
];
const links = new Map([["a2", "350550688500"]]);
// deno-lint-ignore no-explicit-any
const d = digestEmail(items as any, 2, links);
await Deno.writeTextFile(`${out}/digest.html`, d.html);
await Deno.writeTextFile(`${out}/digest.txt`, `${d.subject}\n\n${d.body}`);

const a = alertEmail({ name: "Resend", tier: "tier_2", domain: "resend.com", firmo: resend.firmo }, { title: "Hiring: Technical Account Executive", published: null }, items[0].why, [contact, contact2], "350550688500");
await Deno.writeTextFile(`${out}/alert.html`, a.html);
await Deno.writeTextFile(`${out}/alert.txt`, `${a.subject}\n\n${a.body}`);

const brief = {
  company: "Resend", domain: "resend.com", meetingTitle: "Intro call", when: "Mon, 12 Oct, 15:00 (Asia/Kolkata)",
  attendee: { name: "Jonni Lundy", title: "Co-Founder" }, others: ["Alex Rivera"], fit: 74, priority: 60, tierLabel: "Tier 2",
  dossier: { summary: "Resend is an email API for developers, used by product and engineering teams to send transactional email.", why_now: "Hiring a Technical Account Executive and 14 open roles.", pains: ["Scaling a new sales team", "Pipeline data quality as reps ramp"], risks: ["Developer-led motion, sales hires are recent"], talk_tracks: [{ angle: "a", opener: "How are you tracking pipeline as the first AEs ramp?" }, { angle: "b", opener: "What does handoff from self-serve to sales look like today?" }] },
  signals: [{ kind: "hiring", title: "Hiring: Technical Account Executive", age: "today" }, { kind: "news", title: "Resend raises $22M Series A", age: "4 days ago" }],
  hubspot: { company: "Company: in HubSpot · stage lead · tier 2", contact: "Contact: not in HubSpot", lastContacted: "never", deals: 0 },
  pageUrl: "https://copilot.f1rstword.com/",
};
await Deno.writeTextFile(`${out}/brief.html`, buildBriefHtml(brief));
await Deno.writeTextFile(`${out}/brief.txt`, buildBrief(brief));
console.log("wrote digest, alert and brief to", out);
