import { normalizeDomain } from "./db.ts";
import { log } from "./log.ts";
import { codesFor } from "./lists.ts";
import icp from "./icp.json" with { type: "json" };

// Company search with Hunter's Discover. It is free (no credits) and its filters are the same ones Setup uses: Hunter's own industry
// names, its company size buckets and countries, so a choice in Setup is exactly a filter here. The free plan returns only the first
// 100 companies of a search (ordered by how many email addresses Hunter has), so each run asks a few different questions.

export type HunterCandidate = { name: string; domain: string; source: "hunter"; sourceUrl: string; snippet: string; band?: string };

/** Hunter's company size buckets. */
export const HEADCOUNTS: [string, number, number][] = [
  ["1-10", 1, 10], ["11-50", 11, 50], ["51-200", 51, 200], ["201-500", 201, 500], ["501-1000", 501, 1000],
  ["1001-5000", 1001, 5000], ["5001-10000", 5001, 10000], ["10001+", 10001, Infinity],
];

/** Pure: the Hunter size buckets that overlap the owner's range. */
export const headcountBuckets = (min: number, max: number) => HEADCOUNTS.filter(([, lo, hi]) => hi >= min && lo <= max).map(([k]) => k);

type Body = Record<string, unknown>;
type Company = { industries: string[]; keywords?: string[]; employeesMin: number; employeesMax: number; regions: string[] };

/** Pure: the searches for one run. A base filter from the profile, then variations (a keyword, an industry) so each run sees different companies. */
export function searches(c: Company, week: number, max = 4): Body[] {
  const countries = [...new Set(c.regions.flatMap(codesFor))];
  const base: Body = {
    headcount: headcountBuckets(c.employeesMin, c.employeesMax),
    company_type: { include: ["privately held"] },
    ...(countries.length && countries.length <= 40 ? { headquarters_location: { include: countries.map((country) => ({ country })) } } : {}),
  };
  const inds = c.industries.slice(0, 12);
  const out: Body[] = [];
  const withInd = (list: string[]) => (list.length ? { industry: { include: list } } : {});
  const kws = c.keywords ?? [];
  if (kws.length) {
    for (let i = 0; i < Math.min(max, kws.length); i++) {
      const k = kws[(week + i) % kws.length];
      out.push({ ...base, ...withInd(inds), keywords: { include: [k], match: "any" } });
    }
  } else {
    out.push({ ...base, ...withInd(inds) });
    for (let i = 0; i < Math.min(max - 1, inds.length > 1 ? inds.length : 0); i++) out.push({ ...base, ...withInd([inds[(week + i) % inds.length]]) });
  }
  // One search per size bucket, so each company arrives with its size band (no paid lookup needed for size).
  const buckets = (base.headcount as string[]);
  return out.slice(0, max).flatMap((b) => buckets.map((h) => ({ ...b, headcount: [h] }))).slice(0, 12);
}

/** Pure: companies from a Discover response, as candidates. */
export function fromResponse(d: unknown, label: string, band?: string): HunterCandidate[] {
  const rows = (d as { data?: { domain?: string; organization?: string }[] })?.data;
  if (!Array.isArray(rows)) return [];
  const out: HunterCandidate[] = [];
  for (const r of rows) {
    const domain = normalizeDomain(String(r.domain ?? ""));
    const name = String(r.organization ?? "").trim().slice(0, 60);
    if (domain && name) out.push({ name, domain, source: "hunter", sourceUrl: "", snippet: label.slice(0, 200), ...(band ? { band } : {}) });
  }
  return out;
}

export async function collectHunter(opts: { max?: number } = {}): Promise<HunterCandidate[]> {
  const key = Deno.env.get("HUNTER_API_KEY");
  if (!key) return [];
  const week = Math.floor(Date.now() / (7 * 86_400_000));
  const out = new Map<string, HunterCandidate>();
  const list = searches(icp.company as Company, week, opts.max ?? 4);
  for (const body of list) {
    try {
      const res = await fetch("https://api.hunter.io/v2/discover", { method: "POST", headers: { "X-API-KEY": key, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      if (!res.ok) { await log("warn", "hunter_discover_failed", { message: `Hunter ${res.status}`, detail: { status: res.status } }); if (res.status === 403 || res.status === 401) break; continue; }
      const kw = (body.keywords as { include?: string[] } | undefined)?.include?.[0];
      for (const c of fromResponse(await res.json(), `Matches your filters in Hunter${kw ? ` (keyword: ${kw})` : ""}`, (body.headcount as string[] | undefined)?.[0])) if (!out.has(c.domain)) out.set(c.domain, c);
    } catch (e) { await log("warn", "hunter_discover_failed", { message: (e as Error).message }); }
  }
  await log("info", "discover_hunter", { detail: { searches: list.length, found: out.size } });
  return [...out.values()];
}
