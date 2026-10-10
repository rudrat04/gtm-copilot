import icp from "./icp.json" with { type: "json" };
import type { TodayItem } from "./today.ts";

// Internal messages (the owner's morning email, hot alerts, HubSpot task bodies) are fixed templates
// filled from stored data. The only AI in them is the cached "Why today" sentence.

const TZ = icp.owner.timezone;
const page = icp.owner.pageUrl;
const TIER: Record<string, string> = { tier_1: "Tier 1", tier_2: "Tier 2", tier_3: "Tier 3" };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export const hubspotCompanyUrl = (id: string) => `https://${icp.owner.hubspotHost}/contacts/${icp.owner.hubspotPortal}/record/0-2/${id}`;

function age(iso?: string | null): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const d = Math.floor((Date.now() - t) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

export const sigText = (s: { title: string; published?: string | null; first_seen?: string }) =>
  `${s.title.slice(0, 90)} (${s.published ? `published ${age(s.published)}` : `first seen ${age(s.first_seen)}`})`;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ });

export function longDate(d = new Date()) {
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
}

type Links = Map<string, string>; // account id -> HubSpot company id

function itemBlock(n: number, it: TodayItem, links: Links): string {
  const a = it.account;
  const open = a && links.get(a.id) ? hubspotCompanyUrl(links.get(a.id)!) : page;
  if (it.type === "meeting") {
    return `${n}. ${when(it.meeting!.starts_at)} · ${it.headline}\n   Brief: emailed to you when it was booked`;
  }
  const lines = [`${n}. ${a!.name} · ${TIER[a!.tier] ?? ""} · priority ${a!.priority ?? "n/a"}`];
  if (it.type === "follow_up") lines[0] = `${n}. ${a!.name} · ${it.headline}`;
  lines.push(`   Why today: ${it.why || it.reason}`);
  if (it.signals.length) lines.push(`   Signals: ${it.signals.slice(0, 2).map(sigText).join(" · ")}`);
  if (it.last_action) lines.push(`   Last action: ${it.last_action}`);
  lines.push(it.contact ? `   Contact: ${it.contact.name}, ${it.contact.title}${it.contact.persona ? ` (${it.contact.persona})` : ""}` : `   Contact: none yet, use "Find relevant people"`);
  lines.push(`   Open: ${open}`);
  return lines.join("\n");
}

/** The morning email to the owner. */
export function digestEmail(items: TodayItem[], hidden: number, links: Links) {
  const group = (types: string[]) => items.filter((i) => types.includes(i.type));
  const fresh = group(["hot", "new"]), fu = group(["follow_up"]), mt = group(["meeting"]), rv = group(["revive"]);
  let n = 0;
  const section = (title: string, list: TodayItem[]) =>
    list.length ? `${title}\n${list.map((i) => itemBlock(++n, i, links)).join("\n\n")}\n` : "";

  const parts = [`${fresh.length} new`, `${fu.length} follow-ups`, mt.length ? `${mt.length} meetings` : ""].filter(Boolean).join(", ");
  const body = [
    `Good morning ${icp.owner.name},`,
    `Here is your focus for ${longDate()}.\n`,
    section("NEW AND HOT", fresh),
    section("FOLLOW-UPS DUE", fu),
    section("MEETINGS", mt),
    section("WORTH ANOTHER LOOK", rv),
    `Open the full list: ${page}`,
    `\n— Account Copilot${hidden ? ` · ${hidden} lower-priority accounts not shown` : ""} · outreach stays manual, nothing is sent for you`,
  ].filter(Boolean).join("\n");
  return { subject: `Today: ${items.length} prospect${items.length === 1 ? "" : "s"} to focus on (${parts})`, body };
}

/** An instant alert when a new signal appears on an account you have not contacted yet. */
export function alertEmail(a: { name: string; tier: string; domain: string }, top: { title: string; published?: string | null }, why: string, contact: { name: string; title: string } | null, hubspotId?: string) {
  const topShort = top.title.replace(/^Hiring:\s*/, "hiring ").slice(0, 70);
  return {
    subject: `Hot: ${a.name} (${TIER[a.tier]}), ${topShort}`,
    body: [
      `${a.name} just showed a new signal: ${top.title.slice(0, 120)} (${top.published ? `published ${age(top.published)}` : "found today"}).`,
      `Why today: ${why}`,
      contact ? `Contact: ${contact.name}, ${contact.title}` : `Contact: none yet, use "Find relevant people"`,
      `Open: ${hubspotId ? hubspotCompanyUrl(hubspotId) : page}`,
      `\n— Account Copilot · you get at most ${icp.alerts.maxPerDay} of these a day`,
    ].join("\n"),
  };
}

/** HubSpot task title and body (HTML) for one prospect. */
export function taskFor(it: TodayItem, contactName?: string | null) {
  const a = it.account!;
  const verb = it.type === "follow_up" ? "Follow up with" : it.type === "revive" ? "Revisit" : "Contact";
  const reason = (it.why || it.reason).replace(/\s+/g, " ");
  const subject = `${verb} ${contactName || "the team"} at ${a.name}: ${reason.slice(0, 80)}${reason.length > 80 ? "…" : ""}`;
  const li = (arr: string[]) => (arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
  const html = [
    `<p><b>Why today:</b> ${esc(it.why || it.reason)}</p>`,
    it.signals.length ? `<p><b>Signals (${it.signals.length}, newest first):</b></p>${li(it.signals.map(sigText))}` : "",
    it.last_action ? `<p><b>Last action:</b> ${esc(it.last_action)}</p>` : "",
    `<p>Marking it contacted in Account Copilot schedules the next follow-up: <a href="${esc(page)}">${esc(page)}</a></p>`,
  ].join("");
  return { subject, html };
}

/** One task per day that lists everything, so it works even for accounts not yet in HubSpot. */
export function summaryTask(items: TodayItem[], hidden: number) {
  const rows = items.map((i) => i.type === "meeting"
    ? `${when(i.meeting!.starts_at)}: ${i.headline}`
    : `${i.account!.name} (${TIER[i.account!.tier]}): ${i.label.toLowerCase()}, ${(i.why || i.reason).slice(0, 110)}`);
  return {
    subject: `Account Copilot: today's focus (${items.length})`,
    html: `<p>${esc(longDate())}</p><ol>${rows.map((r) => `<li>${esc(r)}</li>`).join("")}</ol>${hidden ? `<p>${hidden} lower-priority accounts not shown.</p>` : ""}<p><a href="${esc(page)}">Open Account Copilot</a></p>`,
  };
}
