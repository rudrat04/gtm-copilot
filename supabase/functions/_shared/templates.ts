import icp from "./icp.json" with { type: "json" };
import type { TodayItem } from "./today.ts";
import type { Contact } from "./contacts.ts";
import { button, esc as h, h2, layout, link, list, mailto, muted, quote } from "./emailhtml.ts";

// Internal messages (the owner's morning email, hot alerts, HubSpot task bodies) are fixed templates
// filled from stored data. They lead with the PERSON to contact and show the company as context.
// The only AI in them is the cached "Why today" sentence.

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
  /\d+ open roles/.test(s.title) ? `Currently: ${s.title}` // a count, not an event, so no age
    : `${s.title.slice(0, 90)} (${s.published ? `published ${age(s.published)}` : `first seen ${age(s.first_seen)}`})`;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ });

export function longDate(d = new Date()) {
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
}

type Links = Map<string, string>; // account id -> HubSpot company id

const person = (c: Contact) => `${c.name}, ${c.title}`;

/** The headline of an item: a person when we know one, otherwise the company with a next step. */
function headline(n: number, it: TodayItem): string {
  const a = it.account!;
  const c = it.contacts[0];
  const verb = it.type === "follow_up" ? "Follow up with " : it.type === "revive" ? "Revisit " : "";
  return c ? `${n}. ${verb}${c.name} · ${c.title} at ${a.name}` : `${n}. ${verb}${a.name} (no contact found yet)`;
}

function itemBlock(n: number, it: TodayItem, links: Links): string {
  const a = it.account;
  if (it.type === "meeting") return `${n}. ${when(it.meeting!.starts_at)} · ${it.headline}\n   Brief: emailed to you when it was booked`;

  const open = a && links.get(a.id) ? hubspotCompanyUrl(links.get(a.id)!) : page;
  const [c, c2] = it.contacts;
  const lines = [headline(n, it)];
  if (c?.email) lines.push(`   Email: ${c.email}`);
  lines.push(`   ${a!.name} · ${TIER[a!.tier] ?? ""} · priority ${a!.priority ?? "n/a"}${a!.firmo ? ` · ${a!.firmo}` : ""}`);
  if (it.type === "follow_up") lines.push(`   ${it.headline}`);
  lines.push(`   Why today: ${it.why || it.reason}`);
  if (it.signals.length) lines.push(`   Signals: ${it.signals.slice(0, 2).map(sigText).join(" · ")}`);
  if (it.last_action) lines.push(`   Last action: ${it.last_action}`);
  if (c2) lines.push(`   Also consider: ${person(c2)}${c2.email ? ` (${c2.email})` : ""}`);
  if (!c) lines.push(`   Next: open the page and use "Find relevant people"`);
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
    `Here is who to contact for ${longDate()}.\n`,
    section("NEW AND HOT", fresh),
    section("FOLLOW-UPS DUE", fu),
    section("MEETINGS", mt),
    section("WORTH ANOTHER LOOK", rv),
    `Open the full list: ${page}`,
    `\n— Account Copilot${hidden ? ` · ${hidden} lower-priority accounts not shown` : ""} · outreach stays manual, nothing is sent for you`,
  ].filter(Boolean).join("\n");
  return { subject: `Today: ${items.length} prospect${items.length === 1 ? "" : "s"} to focus on (${parts})`, body, html: digestHtml(items, hidden, links) };
}

/** An instant alert when a new signal appears on an account you have not contacted yet. */
export function alertEmail(
  a: { name: string; tier: string; domain: string; firmo?: string },
  top: { title: string; published?: string | null },
  why: string,
  contacts: Contact[],
  hubspotId?: string,
) {
  const topShort = top.title.replace(/^Hiring:\s*/, "hiring ").slice(0, 70);
  const [c, c2] = contacts;
  const who = c ? `${c.name} at ${a.name}` : a.name;
  return {
    subject: `Hot: ${who} (${TIER[a.tier]}), ${topShort}`,
    html: alertHtml(a, top, why, contacts, hubspotId),
    body: [
      c ? `Contact: ${person(c)}${c.email ? `\nEmail: ${c.email}` : ""}` : `Contact: none found yet, use "Find relevant people"`,
      c2 ? `Also consider: ${person(c2)}${c2.email ? ` (${c2.email})` : ""}` : "",
      `\n${a.name} just showed a new signal: ${top.title.slice(0, 120)} (${top.published ? `published ${age(top.published)}` : "found today"}).`,
      a.firmo ? `Company: ${a.firmo}` : "",
      `Why today: ${why}`,
      `Open: ${hubspotId ? hubspotCompanyUrl(hubspotId) : page}`,
      `\n— Account Copilot · you get at most ${icp.alerts.maxPerDay} of these a day`,
    ].filter(Boolean).join("\n"),
  };
}


// ---- HTML versions (the plain text above stays as the fallback) ----

function itemHtml(it: TodayItem, links: Links): string {
  const a = it.account;
  const wrap = (inner: string) => `<div style="padding:14px 0;border-top:1px solid #d6d3d1">${inner}</div>`;
  if (it.type === "meeting") {
    return wrap(`<div style="font-size:17px;font-weight:600">${h(when(it.meeting!.starts_at))}</div><div>${h(it.headline)}</div>${muted("A private brief was emailed to you when it was booked")}`);
  }
  const open = a && links.get(a.id) ? hubspotCompanyUrl(links.get(a.id)!) : page;
  const [c, c2] = it.contacts;
  const verb = it.type === "follow_up" ? "Follow up with " : it.type === "revive" ? "Revisit " : "";
  const headline = c
    ? `<div style="font-size:17px;font-weight:600">${h(verb + c.name)} <span style="font-weight:400;color:#78716c">· ${h(c.title)} at ${h(a!.name)}</span></div>`
    : `<div style="font-size:17px;font-weight:600">${h(verb + a!.name)} <span style="font-weight:400;color:#78716c">· no contact found yet</span></div>`;
  const signals = it.signals.slice(0, 2).map((s) => h(sigText(s)));
  return wrap([
    headline,
    c?.email ? `<div>${mailto(c.email)}</div>` : "",
    muted(`${h(a!.name)} · ${h(TIER[a!.tier] ?? "")} · priority ${h(a!.priority ?? "n/a")}${a!.firmo ? ` · ${h(a!.firmo)}` : ""}`),
    it.type === "follow_up" ? muted(h(it.headline)) : "",
    quote("Why today:", it.why || it.reason),
    list(signals),
    it.last_action ? muted(`Last action: ${h(it.last_action)}`) : "",
    c2 ? `<div style="margin-top:6px">Also consider: <b>${h(c2.name)}</b>, ${h(c2.title)}${c2.email ? ` (${mailto(c2.email)})` : ""}</div>` : "",
    !c ? muted(`Next: open the page and use <b>Find relevant people</b>`) : "",
    `<div style="margin-top:6px">${link(open, links.get(a!.id) ? "Open in HubSpot" : "Open in Account Copilot")}</div>`,
  ].join(""));
}

function digestHtml(items: TodayItem[], hidden: number, links: Links): string {
  const group = (types: string[]) => items.filter((i) => types.includes(i.type));
  const section = (title: string, list: TodayItem[]) => (list.length ? h2(title) + list.map((i) => itemHtml(i, links)).join("") : "");
  const inner = [
    `<div style="font-size:20px;font-weight:700">Good morning ${h(icp.owner.name)}</div>`,
    muted(`Here is who to contact for ${h(longDate())}.`, 14),
    section("New and hot", group(["hot", "new"])),
    section("Follow-ups due", group(["follow_up"])),
    section("Meetings", group(["meeting"])),
    section("Worth another look", group(["revive"])),
    `<div style="margin-top:18px">${button(page, "Open Account Copilot")}</div>`,
  ].join("");
  return layout(inner, `Account Copilot${hidden ? ` · ${hidden} lower-priority accounts not shown` : ""} · outreach stays manual, nothing is sent for you`);
}

function alertHtml(
  a: { name: string; tier: string; firmo?: string },
  top: { title: string; published?: string | null },
  why: string,
  contacts: Contact[],
  hubspotId?: string,
): string {
  const [c, c2] = contacts;
  const open = hubspotId ? hubspotCompanyUrl(hubspotId) : page;
  const inner = [
    `<div style="font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#78716c">Hot signal</div>`,
    c
      ? `<div style="font-size:19px;font-weight:700;margin-top:4px">${h(c.name)} <span style="font-weight:400;color:#78716c">· ${h(c.title)} at ${h(a.name)}</span></div>${c.email ? `<div>${mailto(c.email)}</div>` : ""}`
      : `<div style="font-size:19px;font-weight:700;margin-top:4px">${h(a.name)} <span style="font-weight:400;color:#78716c">· no contact found yet</span></div>${muted(`Open the page and use <b>Find relevant people</b>`)}`,
    muted(`${h(a.name)} · ${h(TIER[a.tier] ?? "")}${a.firmo ? ` · ${h(a.firmo)}` : ""}`),
    quote("Why today:", why),
    list([`${h(top.title.slice(0, 140))} <span style="color:#78716c">(${top.published ? `published ${h(age(top.published))}` : "found today"})</span>`]),
    c2 ? `<div>Also consider: <b>${h(c2.name)}</b>, ${h(c2.title)}${c2.email ? ` (${mailto(c2.email)})` : ""}</div>` : "",
    `<div>${button(open, hubspotId ? "Open in HubSpot" : "Open in Account Copilot")}</div>`,
  ].join("");
  return layout(inner, `Account Copilot · you get at most ${icp.alerts.maxPerDay} of these a day · outreach stays manual`);
}

/** HubSpot task title and body (HTML) for one prospect. */
export function taskFor(it: TodayItem, contactName?: string | null) {
  const a = it.account!;
  const c = it.contacts[0];
  const who = c?.name ?? contactName ?? "the team";
  const verb = it.type === "follow_up" ? "Follow up with" : it.type === "revive" ? "Revisit" : "Contact";
  const reason = (it.why || it.reason).replace(/\s+/g, " ");
  const subject = `${verb} ${who} at ${a.name}: ${reason.slice(0, 80)}${reason.length > 80 ? "…" : ""}`;
  const li = (arr: string[]) => (arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
  const html = [
    c ? `<p><b>Contact:</b> ${esc(person(c))}${c.email ? ` · ${esc(c.email)}` : ""}</p>` : "",
    it.contacts[1] ? `<p><b>Also consider:</b> ${esc(person(it.contacts[1]))}</p>` : "",
    a.firmo ? `<p><b>Company:</b> ${esc(a.name)} · ${esc(a.firmo)}</p>` : "",
    `<p><b>Why today:</b> ${esc(it.why || it.reason)}</p>`,
    it.signals.length ? `<p><b>Signals (${it.signals.length}, newest first):</b></p>${li(it.signals.map(sigText))}` : "",
    it.last_action ? `<p><b>Last action:</b> ${esc(it.last_action)}</p>` : "",
    `<p>Marking it contacted in Account Copilot schedules the next follow-up: <a href="${esc(page)}">${esc(page)}</a></p>`,
  ].join("");
  return { subject, html };
}

/** One task per day that lists everything, so it works even for accounts not yet in HubSpot. */
export function summaryTask(items: TodayItem[], hidden: number) {
  const rows = items.map((i) => {
    if (i.type === "meeting") return `${when(i.meeting!.starts_at)}: ${i.headline}`;
    const c = i.contacts[0];
    return `${c ? `${c.name} (${c.title}) at ` : ""}${i.account!.name} · ${TIER[i.account!.tier]}: ${i.label.toLowerCase()}, ${(i.why || i.reason).slice(0, 100)}`;
  });
  return {
    subject: `Account Copilot: today's focus (${items.length})`,
    html: `<p>${esc(longDate())}</p><ol>${rows.map((r) => `<li>${esc(r)}</li>`).join("")}</ol>${hidden ? `<p>${hidden} lower-priority accounts not shown.</p>` : ""}<p><a href="${esc(page)}">Open Account Copilot</a></p>`,
  };
}
