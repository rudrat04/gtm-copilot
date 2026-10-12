import { normalizeDomain } from "./db.ts";
import { log } from "./log.ts";
import { askClaude, BudgetError, parseJson } from "./claude.ts";
import icp from "./icp.json" with { type: "json" };

// Finds new companies by letting the model search the public web (Anthropic's web search tool, 1 cent a search plus a few
// tokens). Each run uses a couple of angles chosen from the owner's profile; the candidates then go through the same
// screening and fit checks as every other source, so nothing is added just because a search mentioned it.

export type WebCandidate = { name: string; domain: string; source: "web"; sourceUrl: string; snippet: string };

/** Pure: the search angles, built from the profile. Rotated by week so each run looks somewhere different. */
export function angles(): { id: string; ask: string }[] {
  const c = icp.company;
  const who = `${c.industries.slice(0, 5).join(", ")} companies with ${c.employeesMin} to ${c.employeesMax} employees`;
  const roles = icp.signals.hiringRoles.slice(0, 4).join(", ");
  return [
    { id: "funding", ask: `${who} that announced a seed, Series A or Series B round in the last 90 days` },
    { id: "leaders", ask: `${who} that just hired or appointed a head of sales, VP of sales, CRO or head of revenue operations in the last 90 days` },
    { id: "hiring", ask: `${who} that are hiring for ${roles || "sales roles"} right now, found on company career pages or job boards` },
    { id: "launch", ask: `${who} that launched a product, opened a new market or announced a partnership in the last 60 days` },
  ];
}

/** Pure: which angles this run uses. */
export const pickAngles = (n: number, week = Math.floor(Date.now() / (7 * 86_400_000))) => {
  const all = angles();
  return Array.from({ length: Math.min(n, all.length) }, (_, i) => all[(week * n + i) % all.length]);
};

/** Pure: keeps only usable company rows from the model's JSON. */
export function cleanWeb(raw: unknown): WebCandidate[] {
  const list = (raw as { companies?: unknown })?.companies;
  if (!Array.isArray(list)) return [];
  const out: WebCandidate[] = [];
  for (const r of list as Record<string, unknown>[]) {
    const domain = normalizeDomain(String(r.domain ?? ""));
    const name = String(r.name ?? "").trim().slice(0, 60);
    if (!domain || name.length < 2 || /(^|\.)(linkedin|crunchbase|techcrunch|twitter|x|facebook|youtube|wikipedia|github|medium|forbes|reuters|bloomberg|prnewswire|businesswire)\.(com|org|co)$/.test(domain)) continue;
    out.push({ name, domain, source: "web", sourceUrl: String(r.url ?? "").slice(0, 300), snippet: String(r.why ?? "").slice(0, 220) });
  }
  return out;
}

/** Runs the searches. Costs about 3 to 5 cents a run in all. Returns nothing (and logs) if the search is unavailable. */
export async function collectWeb(opts: { calls?: number; searchesPerCall?: number } = {}): Promise<WebCandidate[]> {
  const cfg = icp.discovery as { webCalls?: number; webSearches?: number };
  const calls = opts.calls ?? cfg.webCalls ?? 2, uses = opts.searchesPerCall ?? cfg.webSearches ?? 3;
  const out = new Map<string, WebCandidate>();
  for (const a of pickAngles(calls)) {
    try {
      const raw = await askClaude({
        feature: "discover_web", maxTokens: 1400,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: uses }],
        system: "You find real companies for a B2B sales team using web search. Only list companies you actually found in search results, never guess. Return one JSON object and nothing else.",
        user: `The seller: ${icp.seller.pitch}\nFind up to 10 ${a.ask}.\nFor each, give the company's own website domain (not a news or social link), a short factual reason from what you read, and the page it came from.\nJSON: {"companies":[{"name":"...","domain":"example.com","why":"one short sentence","url":"https://..."}]}`,
      });
      let parsed: unknown = null;
      try { parsed = parseJson(raw); } catch { /* an empty answer is fine */ }
      for (const c of cleanWeb(parsed)) if (!out.has(c.domain)) out.set(c.domain, { ...c, snippet: c.snippet || a.ask.slice(0, 120) });
      await log("info", "discover_web", { detail: { angle: a.id, found: cleanWeb(parsed).length } });
    } catch (e) {
      if (e instanceof BudgetError) break;
      await log("warn", "discover_web_failed", { message: (e as Error).message, detail: { angle: a.id } });
    }
  }
  return [...out.values()];
}
