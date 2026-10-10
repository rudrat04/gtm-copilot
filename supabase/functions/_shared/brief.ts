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
    lines.push(`ICP fit ${i.fit ?? "n/a"}/100 · Priority ${i.priority ?? "n/a"} · ${i.tierLabel ?? ""}`.trim());
    if (d?.summary) lines.push(d.summary);
  }
  if (d?.why_now) lines.push(`\nWHY NOW\n${d.why_now}`);

  if (i.signals.length) {
    lines.push(`\nSIGNALS`);
    lines.push(i.signals.slice(0, 5).map((s) => `- ${s.kind}: ${s.title}${s.age ? ` (${s.age})` : ""}`).join("\n"));
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
