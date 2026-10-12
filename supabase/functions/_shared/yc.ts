import { normalizeDomain } from "./db.ts";
import { log } from "./log.ts";
import { codesFor, COUNTRIES } from "./lists.ts";
import icp from "./icp.json" with { type: "json" };

// Y Combinator companies that are hiring right now, from the public community list yc-oss (free, no key, refreshed daily).
// Only B2B companies inside the owner's size range are kept; ones that match the profile's keywords come first.

export type YcCandidate = { name: string; domain: string; source: "yc"; sourceUrl: string; snippet: string; size?: number };
type Yc = { all_locations?: string; regions?: string[]; name: string; slug: string; website?: string; one_liner?: string; team_size?: number; industry?: string; tags?: string[]; batch?: string; status?: string; launched_at?: number; url?: string };

/** Pure: picks and orders the YC companies worth a look. */
/** Pure: the country names a list of chosen locations stands for (what YC writes in a company's locations). */
export const countryNames = (regions: string[]) => [...new Set(regions.flatMap(codesFor))].map((c) => COUNTRIES.find(([k]) => k === c)?.[1]).filter(Boolean) as string[];

export function pickYc(all: Yc[], min: number, max: number, keywords: string[] = [], limit = 60, countries: string[] = []): YcCandidate[] {
  const kws = keywords.map((k) => k.toLowerCase());
  const rows = all
    .filter((c) => c.status === "Active" && c.industry === "B2B" && c.website && (c.team_size ?? 0) >= min && (c.team_size ?? 0) <= max
      && (!countries.length || countries.some((n) => `${c.all_locations ?? ""} ${(c.regions ?? []).join(" ")}`.includes(n))))
    .map((c) => {
      const text = `${c.one_liner ?? ""} ${(c.tags ?? []).join(" ")}`.toLowerCase();
      return { c, hits: kws.filter((k) => text.includes(k)).length };
    })
    .sort((a, b) => (b.hits - a.hits) || ((b.c.launched_at ?? 0) - (a.c.launched_at ?? 0)));
  const out: YcCandidate[] = [];
  for (const { c } of rows) {
    const domain = normalizeDomain(String(c.website));
    if (!domain) continue;
    out.push({ name: c.name.slice(0, 60), domain, source: "yc", sourceUrl: c.url ?? `https://www.ycombinator.com/companies/${c.slug}`, snippet: `${c.one_liner ?? "Y Combinator company"} (${c.batch ?? "YC"}, ${c.team_size} people, hiring)`.slice(0, 220), size: c.team_size });
    if (out.length >= limit) break;
  }
  return out;
}

export async function collectYc(): Promise<YcCandidate[]> {
  try {
    const res = await fetch("https://yc-oss.github.io/api/companies/hiring.json", { signal: AbortSignal.timeout(25000) });
    if (!res.ok) return [];
    const out = pickYc(await res.json(), icp.company.employeesMin, icp.company.employeesMax, (icp.company as { keywords?: string[] }).keywords ?? [], 60, countryNames(icp.company.regions));
    await log("info", "discover_yc", { detail: { found: out.length } });
    return out;
  } catch (e) {
    await log("warn", "discover_yc_failed", { message: (e as Error).message });
    return [];
  }
}
