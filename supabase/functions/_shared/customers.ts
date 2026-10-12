import { readCustomerFacts } from "./hubspot.ts";
import icp from "./icp.json" with { type: "json" };

// "What your customers look like": the companies HubSpot knows as customers, summarised, and compared with the profile you set.
// Read-only, free. Needs at least 3 customers with a size to say anything.

const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]; };
const top = (xs: (string | null)[], n = 4) => { const c = new Map<string, number>(); for (const x of xs) if (x) c.set(x, (c.get(x) ?? 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ name: k, count: v })); };

export type Insights = {
  count: number; sized: number; enough: boolean;
  size?: { p25: number; median: number; p75: number; min: number; max: number };
  industries: { name: string; count: number }[]; countries: { name: string; count: number }[];
  suggestions: { text: string; apply?: { employeesMin?: number; employeesMax?: number } }[];
};

/** Pure: the summary and the suggestions from a list of customers. */
export function summarise(cs: { employees: number | null; industry: string | null; country: string | null }[], cur = { min: icp.company.employeesMin, max: icp.company.employeesMax }): Insights {
  const sizes = cs.map((c) => c.employees).filter((n): n is number => !!n && n > 0);
  const out: Insights = { count: cs.length, sized: sizes.length, enough: sizes.length >= 3, industries: top(cs.map((c) => c.industry)), countries: top(cs.map((c) => c.country)), suggestions: [] };
  if (!out.enough) { out.suggestions.push({ text: `Only ${sizes.length} of your ${cs.length} customers have a company size in HubSpot. With at least 3 I can show what they have in common.` }); return out; }
  const p25 = q(sizes, 0.25), p75 = q(sizes, 0.75), med = q(sizes, 0.5);
  out.size = { p25, median: med, p75, min: Math.min(...sizes), max: Math.max(...sizes) };
  const lo = Math.max(1, Math.round(p25 * 0.6)), hi = Math.round(p75 * 1.6);
  if (cur.max > hi * 1.8) out.suggestions.push({ text: `Your customers are mostly ${p25} to ${p75} people (the middle half), but you look at companies up to ${cur.max}. Narrowing to about ${lo} to ${hi} would cut the noise.`, apply: { employeesMin: lo, employeesMax: hi } });
  else if (cur.min < lo * 0.4) out.suggestions.push({ text: `Your smallest customers have about ${out.size.min} people and most have ${p25} or more, but you look at companies from ${cur.min}. Raising the minimum to about ${lo} would help.`, apply: { employeesMin: lo, employeesMax: cur.max } });
  else if (out.size.max > cur.max * 1.3) out.suggestions.push({ text: `Some customers are bigger than your range (up to ${out.size.max} people). Raising the maximum to about ${hi} would catch lookalikes.`, apply: { employeesMin: cur.min, employeesMax: hi } });
  else out.suggestions.push({ text: `Your range (${cur.min} to ${cur.max}) fits your customers well: the middle half have ${p25} to ${p75} people.` });
  return out;
}

export async function customerInsights(): Promise<Insights> {
  const cs = await readCustomerFacts(100).catch(() => []);
  return summarise(cs);
}
