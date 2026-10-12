// What is happening around a person: the company's signals that concern their own team. A sales leader cares about sales hiring,
// a marketing leader about marketing roles and events, an executive about funding, leadership changes and expansion. Pure, no AI.

type Sig = { kind: string; title: string; detail?: Record<string, unknown> | null; detected_at?: string };

const TEAM: [RegExp, RegExp][] = [
  [/sales|revenue|business development|account|partnership/i, /sales|account executive|\bsdr\b|\bbdr\b|business development|revenue|quota|closer|partnership/i],
  [/marketing|growth|demand|brand|content|communication/i, /marketing|growth|demand|content|brand|seo|campaign|communications?/i],
  [/operations|ops/i, /operations|revops|\bops\b|sales ops|enablement|systems|crm/i],
  [/product|design|research/i, /product|design|ux|research/i],
  [/it|engineering|tech/i, /engineer|developer|devops|data|security|infrastructure|architect|cto/i],
  [/support|customer|success/i, /support|customer success|onboarding|implementation|csm/i],
  [/finance|procurement|admin/i, /finance|accounting|controller|billing|procure/i],
  [/hr|people|talent|recruit/i, /recruit|talent|people|\bhr\b/i],
];
const LEADERS = /executive|management|founder|chief|ceo|president/i;
const COMPANY_WIDE = /\b(raises?|raised|funding|series [a-d]|seed|acquir|expands?|expansion|opens? (an? )?office|launch(es|ed)?|appoints?|names?|hires?|joins as|partnership|hosting|summit|conference)\b/i;

/** Pure: up to `max` short lines about what is going on in this person's area, newest-relevant first. */
export function teamSignals(department: string | null | undefined, title: string | null | undefined, sigs: Sig[], max = 2): string[] {
  const dept = `${department ?? ""} ${title ?? ""}`;
  const leader = LEADERS.test(dept);
  const teamRe = TEAM.find(([d]) => d.test(department ?? "") || d.test(title ?? ""))?.[1];
  const out: { w: number; t: string }[] = [];
  for (const s of sigs) {
    const t = s.title.replace(/^Hiring:\s*/i, "").replace(/\s*\(seen on their website\)$/i, "");
    const isSummary = s.kind === "hiring" && s.detail && "salesOpenings" in s.detail;
    if (isSummary) {
      if (teamRe?.test("sales") && Number(s.detail!.salesOpenings) > 0) out.push({ w: 6, t: `${s.detail!.salesOpenings} sales roles open` });
      continue;
    }
    if (s.kind === "hiring" && teamRe?.test(t)) out.push({ w: 8, t: `Hiring in your area: ${t.slice(0, 70)}` });
    else if (s.kind === "news" && (leader || teamRe?.test(t)) && COMPANY_WIDE.test(t)) out.push({ w: leader ? 9 : 5, t: t.slice(0, 90) });
    else if (s.kind === "news" && teamRe?.test(t)) out.push({ w: 4, t: t.slice(0, 90) });
    else if (s.kind === "tech" && (s.detail as { ruleType?: string } | null | undefined)?.ruleType === "change" && (leader || /sales|operations|marketing/i.test(dept))) out.push({ w: 5, t: t.slice(0, 80) });
  }
  const seen = new Set<string>();
  return out.sort((a, b) => b.w - a.w).filter((o) => (seen.has(o.t) ? false : (seen.add(o.t), true))).slice(0, max).map((o) => o.t);
}
