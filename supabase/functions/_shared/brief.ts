import type { Dossier } from "./hubspot.ts";

export type BriefInput = {
  company: string;
  domain: string | null;
  meetingTitle: string;
  when: string;
  attendee: { name: string; title?: string | null };
  others: string[];
  fit?: number | null;
  priority?: number | null;
  tierLabel?: string;
  dossier: Dossier | null;
  signals: { kind: string; title: string; age?: string }[];
  hubspot: { company?: string; contact?: string; lastContacted?: string; deals?: number } | null;
  pageUrl: string;
  note?: string;
};

const sigLabel = (s: { kind: string; title: string }) => (/^(hiring|hacker news):/i.test(s.title) ? s.title : `${s.kind}: ${s.title}`);
const bullets = (a?: string[], n = 3) => (a?.length ? a.slice(0, n).map((x) => `- ${x}`).join("\n") : "- None found");

/** A plain template filled from stored data. No AI call happens here. */
export function buildBrief(i: BriefInput): string {
  const d = i.dossier;
  const questions = (d?.talk_tracks ?? []).map((t) => t.opener).filter(Boolean).slice(0, 3);
  const hs = i.hubspot;
  const lines: string[] = [];

  lines.push(`BRIEF: ${i.company}${i.domain ? ` (${i.domain})` : ""}`);
  lines.push(`Meeting: ${i.meetingTitle} · ${i.when}`);
  lines.push(`With: ${i.attendee.name}${i.attendee.title ? `, ${i.attendee.title}` : ""}${i.others.length ? ` (+${i.others.length} more: ${i.others.join(", ")})` : ""}`);
  if (i.note) lines.push(`\nNote: ${i.note}`);

  if (d || i.fit != null) {
    lines.push(`\nAT A GLANCE`);
    lines.push([
      i.fit != null ? `ICP fit ${i.fit}/100` : null,
      i.priority != null ? `Priority ${i.priority}` : null,
      i.tierLabel || null,
    ].filter(Boolean).join(" · ") || "No score yet");
    if (d?.summary) lines.push(d.summary);
  }
  if (d?.why_now) lines.push(`\nWHY NOW\n${d.why_now}`);

  if (i.signals.length) {
    lines.push(`\nSIGNALS`);
    lines.push(i.signals.slice(0, 5).map((s) => `- ${sigLabel(s)}${s.age ? ` (${s.age})` : ""}`).join("\n"));
  }

  lines.push(`\nIN HUBSPOT`);
  lines.push(hs
    ? [
      hs.company ?? "Company: not in HubSpot",
      hs.contact ?? "Contact: not in HubSpot",
      `Last contacted: ${hs.lastContacted ?? "never"}`,
      `Open deals: ${hs.deals ?? 0}`,
    ].join("\n")
    : "Not checked");

  if (questions.length) lines.push(`\nQUESTIONS TO ASK\n${questions.map((q, n) => `${n + 1}. ${q}`).join("\n")}`);
  if (d?.pains?.length) lines.push(`\nLIKELY PAINS\n${bullets(d.pains)}`);
  if (d?.risks?.length) lines.push(`\nWATCH OUT FOR\n${bullets(d.risks, 2)}`);

  lines.push(`\nFull dossier and people: ${i.pageUrl}`);
  lines.push(`Account Copilot · public sources only · kept private, not added to the calendar invite`);
  return lines.join("\n");
}

// ---- HTML version (same content as the plain text above) ----
import { esc, h2, layout, link, list, muted, quote } from "./emailhtml.ts";

export function buildBriefHtml(i: BriefInput): string {
  const d = i.dossier;
  const hs = i.hubspot;
  const questions = (d?.talk_tracks ?? []).map((t) => t.opener).filter(Boolean).slice(0, 3);
  const glance = [i.fit != null ? `ICP fit ${i.fit}/100` : null, i.priority != null ? `Priority ${i.priority}` : null, i.tierLabel || null].filter(Boolean).join(" · ");

  const inner = [
    muted("Meeting brief", 12),
    `<div style="font-size:21px;font-weight:700">${esc(i.company)}${i.domain ? ` <span style="font-weight:400;color:#78716c;font-size:15px">${esc(i.domain)}</span>` : ""}</div>`,
    `<div style="margin-top:6px"><b>${esc(i.meetingTitle)}</b> · ${esc(i.when)}</div>`,
    `<div>With <b>${esc(i.attendee.name)}</b>${i.attendee.title ? `, ${esc(i.attendee.title)}` : ""}${i.others.length ? ` <span style="color:#78716c">(+${i.others.length} more: ${esc(i.others.join(", "))})</span>` : ""}</div>`,
    i.note ? quote("Note:", i.note) : "",
    d || i.fit != null ? h2("At a glance") + `<div>${esc(glance || "No score yet")}</div>${d?.summary ? `<div style="margin-top:6px">${esc(d.summary)}</div>` : ""}` : "",
    d?.why_now ? h2("Why now") + `<div>${esc(d.why_now)}</div>` : "",
    i.signals.length ? h2("Signals") + list(i.signals.slice(0, 5).map((s) => `${esc(sigLabel(s))}${s.age ? ` <span style="color:#78716c">(${esc(s.age)})</span>` : ""}`)) : "",
    h2("In HubSpot") + (hs
      ? list([hs.company ?? "Company: not in HubSpot", hs.contact ?? "Contact: not in HubSpot", `Last contacted: ${hs.lastContacted ?? "never"}`, `Open deals: ${hs.deals ?? 0}`].map(esc))
      : muted("Not checked")),
    questions.length ? h2("Questions to ask") + `<ol style="margin:6px 0;padding-left:20px">${questions.map((q) => `<li style="margin:4px 0">${esc(q)}</li>`).join("")}</ol>` : "",
    d?.pains?.length ? h2("Likely pains") + list(d.pains.slice(0, 3).map(esc)) : "",
    d?.risks?.length ? h2("Watch out for") + list(d.risks.slice(0, 2).map(esc)) : "",
    `<div style="margin-top:18px">${link(i.pageUrl, "Full dossier and people in Account Copilot")}</div>`,
  ].join("");
  return layout(inner, "Account Copilot · public sources only · kept private, not added to the calendar invite");
}
