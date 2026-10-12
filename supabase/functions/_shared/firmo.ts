import { sb } from "./db.ts";
import { log } from "./log.ts";
import icp from "./icp.json" with { type: "json" };
import { codesFor, STAGE_OPTIONS } from "./lists.ts";

// Company facts from Hunter's Company Enrichment (about 0.2 credit per company). Saved once, refreshed rarely.

const inRegions = (cc: string) => icp.company.regions.some((r) => codesFor(r).includes(cc));
const CREDIT_PER_COMPANY = 0.2;

export type Firmo = {
  employees: number | null;
  band: string | null;
  raised: number | null;
  stage: string | null;
  lastRoundDate: string | null;
  founded: number | null;
  country: string | null;
  city: string | null;
  industry: string | null;
  tags: string[];
  tech: string[];
  blurb: string | null;
  linkedin: string | null;
};

/** Industry, tools, tags and description from the same Hunter lookup (no extra credit). Pure, so it can be tested. */
// deno-lint-ignore no-explicit-any -- an external JSON payload
export function extraFacts(x: any): Pick<Firmo, "industry" | "tags" | "tech" | "blurb" | "linkedin"> {
  const c = x?.category ?? {};
  const industry = [...new Set([c.sector, c.industryGroup, c.industry, c.subIndustry].filter((v) => typeof v === "string" && v.trim()).map((v: string) => v.trim()))].join(" / ");
  const list = (v: unknown, max: number) => (Array.isArray(v) ? v : []).filter((t) => typeof t === "string" && t.trim()).map((t: string) => t.trim().toLowerCase()).slice(0, max);
  return {
    industry: industry || null,
    tags: list(x?.tags, 20),
    tech: list(x?.tech, 80),
    blurb: typeof x?.description === "string" && x.description.trim() ? x.description.trim().replace(/\s+/g, " ").slice(0, 300) : null,
    linkedin: typeof x?.linkedin?.handle === "string" ? x.linkedin.handle.slice(0, 120) : null,
  };
}

/** The funding stage is the type of the most recent round. */
function latestRound(rounds: { date?: string; type?: string }[]): { stage: string | null; date: string | null } {
  const dated = rounds.filter((r) => r.type).sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  return { stage: dated[0]?.type ?? null, date: dated[0]?.date ?? null };
}

export async function fetchFirmo(domain: string): Promise<Firmo | null> {
  const key = Deno.env.get("HUNTER_API_KEY");
  if (!key) return null;

  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  const { data } = await sb.from("cp_provider_usage").select("credits").eq("provider", "hunter").gte("created_at", since.toISOString());
  const used = (data ?? []).reduce((a, r) => a + Number(r.credits), 0);
  if (used >= Number(Deno.env.get("HUNTER_MONTHLY_CAP") ?? 40)) {
    await log("warn", "provider_cap_reached", { account: domain, detail: { provider: "hunter", used } });
    return null;
  }

  const started = Date.now();
  const res = await fetch(`https://api.hunter.io/v2/companies/find?domain=${encodeURIComponent(domain)}`, { headers: { "X-API-KEY": key }, signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 404 means Hunter has no profile for this domain; that is not an error worth a red log.
    await log(res.status === 404 ? "info" : "error", "firmo_lookup_failed", { account: domain, message: `Hunter ${res.status}`, detail: { errors: JSON.stringify(body.errors ?? "").slice(0, 200) }, ms: Date.now() - started });
    return null;
  }

  const x = body.data ?? {};
  const m = x.metrics ?? {};
  const round = latestRound(x.fundingRounds ?? []);
  await sb.from("cp_provider_usage").insert({ provider: "hunter", action: "company_enrich", credits: CREDIT_PER_COMPANY, account: domain });
  const firmo: Firmo = {
    employees: m.employeesCount ?? null,
    band: m.employees ?? null,
    raised: m.raised ? Math.round(Number(m.raised)) : null,
    stage: round.stage,
    lastRoundDate: round.date,
    founded: x.foundedYear ?? null,
    country: x.geo?.countryCode ?? null,
    city: x.geo?.city ?? null,
    ...extraFacts(x),
  };
  await log("info", "firmo_fetched", { account: domain, detail: { employees: firmo.employees, stage: firmo.stage, country: firmo.country }, ms: Date.now() - started });
  return firmo;
}

export async function saveFirmo(accountId: string, f: Firmo) {
  await sb.from("cp_accounts").update({
    employees: f.employees, employee_band: f.band, raised_usd: f.raised, stage: f.stage, last_round_date: f.lastRoundDate,
    founded_year: f.founded, country: f.country, hq_city: f.city, firmo_at: new Date().toISOString(),
    industry: f.industry, tags: f.tags, tech: f.tech, blurb: f.blurb, linkedin_handle: f.linkedin, facts2_at: new Date().toISOString(),
  }).eq("id", accountId);
}

// ---- Fit against the ICP (the 25-point "fit" slice of the priority score) ----

/** What we know about a company for fit. Every field is optional; a missing one counts as "not known yet", never as a mismatch. */
export type FitRow = {
  employees?: number | null; stage?: string | null; country?: string | null; firmo_at?: string | null;
  tech?: string[] | null; industry?: string | null; tags?: string[] | null; blurb?: string | null; sales_motion?: string | null;
  domain?: string | null; name?: string | null; known_as?: string | null; last_round_date?: string | null; industry_ai?: string | null;
};
/** The columns to select wherever fit is computed, so a new criterion takes effect everywhere. */
export const FIT_COLS = "employees,stage,country,firmo_at,tech,industry,tags,blurb,sales_motion,domain,name,known_as,last_round_date,watched_at,industry_ai";

/** Is this funding stage one of the stages we target? Each stage the owner picked has its own pattern (see lists.ts). */
const stageWanted = (s: string) => icp.company.stages.some((w) => (STAGE_OPTIONS.find((o) => o.name === w)?.re ?? new RegExp(w.toLowerCase().replace(/[^a-z0-9 ]/g, ""))).test(s));

// Words a Hunter category or tag may use for the industries you list in Setup.
const SYNONYMS: Record<string, string[]> = {
  saas: ["saas", "software", "cloud"], software: ["software", "saas", "cloud"], fintech: ["fintech", "financial", "payments", "banking", "insurance"],
  "developer tools": ["developer", "devops", "api", "software"], infrastructure: ["infrastructure", "cloud", "devops", "data"], security: ["security", "cyber", "identity"],
  "software development": ["software", "saas", "cloud", "developer", "platform"], "it services and it consulting": ["it services", "consulting", "managed services"],
  healthtech: ["health", "medical", "biotech"], ecommerce: ["ecommerce", "e-commerce", "retail", "marketplace"], ai: ["artificial intelligence", "machine learning", "ai"],
};
const STOP = new Set(["b2b", "b2c", "and", "the", "tools", "company", "companies", "software", "development", "services", "service", "management"]);

/** Keywords for one industry from the profile, plus its synonyms. */
export function industryWords(industry: string): string[] {
  const key = industry.toLowerCase().replace(/b2b|b2c/g, "").trim();
  const words = key.split(/[^a-z0-9-]+/).filter((w) => w.length >= 3 && !STOP.has(w));
  return [...new Set([...(SYNONYMS[key] ?? []), ...words.flatMap((w) => SYNONYMS[w] ?? [w]), ...(SYNONYMS[industry.toLowerCase()] ?? [])])];
}

const textOf = (a: FitRow) => `${a.industry ?? ""} ${(a.tags ?? []).join(" ")} ${a.blurb ?? ""}`.toLowerCase();
const normTool = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");

/** 1 = in one of your industries, 0 = not, 0.5 = we have no industry data yet. */
export function industryScore(a: FitRow): number {
  if (a.industry_ai) { // an industry read from the company's own website beats Hunter's label
    const own = industryWords(a.industry_ai);
    return icp.company.industries.some((ind) => ind === a.industry_ai || industryWords(ind).some((w) => own.includes(w))) ? 1 : 0;
  }
  const text = textOf(a);
  if (!text.trim()) return 0.5;
  return icp.company.industries.some((ind) => industryWords(ind).some((w) => text.includes(w))) ? 1 : 0;
}

/** 1 = uses a tool you like, 0 = uses one you avoid, 0.5 = nothing known either way. */
export function toolsScore(a: FitRow): number {
  const have = new Set((a.tech ?? []).map(normTool));
  if (!have.size) return 0.5;
  if ((icp.company.toolsAvoid as string[]).some((t) => have.has(normTool(t)))) return 0;
  return (icp.company.toolsGood as string[]).some((t) => have.has(normTool(t))) ? 1 : 0.5;
}

/** 1 = the sales motion you prefer, 0.75 = both, 0 = the opposite, 0.5 = not known or no preference. */
export function motionScore(a: FitRow): number {
  const want = icp.company.motion;
  if (want === "any" || !a.sales_motion) return 0.5;
  return a.sales_motion === want ? 1 : a.sales_motion === "both" ? 0.75 : 0;
}

/** Why a company is excluded outright (a competitor, an agency, an existing customer), or null. */
export function exclusion(a: FitRow): string | null {
  if (a.known_as === "customer") return "Already a customer";
  const domain = (a.domain ?? "").toLowerCase();
  if (domain && (icp.company.excludeDomains as string[]).some((d) => domain === d.toLowerCase())) return "On your never-show list";
  const text = `${textOf(a)} ${(a.name ?? "").toLowerCase()}`;
  const hit = (icp.company.excludeWords as string[]).find((w) => w && new RegExp(`\\b${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text));
  return hit ? `Matches "${hit}"` : null;
}

export type FitParts = { size: number; stage: number; region: number; industry: number; tools: number; motion: number };

export function fitBreakdown(a: FitRow): { points: number; known: boolean; size: number; stage: number; region: number; matches: boolean; excluded: string | null; parts: FitParts } {
  const excluded = exclusion(a);
  const none: FitParts = { size: 0.5, stage: 0.5, region: 0.5, industry: 0.5, tools: 0.5, motion: 0.5 };
  if (!a.firmo_at) return { points: icp.signals.weights.fit * 0.6, known: false, size: 0, stage: 0, region: 0, matches: false, excluded, parts: none }; // neutral baseline, 15
  const c = icp.company;

  const n = a.employees;
  const size = n == null ? 5 : n >= c.employeesMin && n <= c.employeesMax ? 10
    : n >= c.employeesMin * 0.75 && n <= c.employeesMax * 1.25 ? 5 : 0;

  const s = (a.stage ?? "").toLowerCase();
  const stage = !s || /^(other|debt|grant|unknown|undisclosed)/.test(s) ? 5 // unclear round type: neutral, not a mismatch
    : stageWanted(s) ? 10
    : /series c/.test(s) ? 4
    : 0; // series d+, IPO, acquired

  const cc = (a.country ?? "").toUpperCase();
  const region = !cc ? 3 : inRegions(cc) ? 5 : 0;

  // Each criterion scores 0 to 1; the owner's weights decide how much each counts. With the default weights (size 10, stage 10,
  // region 5, the rest 0) this is exactly size + stage + region, as before.
  const parts: FitParts = { size: size / 10, stage: stage / 10, region: region / 5, industry: industryScore(a), tools: toolsScore(a), motion: motionScore(a) };
  const w = icp.fitWeights as Record<keyof FitParts, number>;
  const total = (Object.keys(parts) as (keyof FitParts)[]).reduce((t, k) => t + w[k], 0) || 1;
  const points = icp.signals.weights.fit * (Object.keys(parts) as (keyof FitParts)[]).reduce((t, k) => t + w[k] * parts[k], 0) / total;
  return { points, known: true, size, stage, region, matches: size === 10 && stage === 10, excluded, parts };
}

/** The fit slice of the priority score. */
export function fitPoints(a: FitRow): number {
  return fitBreakdown(a).points;
}

export const usdShort = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${Math.round(n / 1e6)}M` : `$${Math.round(n / 1e3)}K`);

/** A card-sized explanation of the fit, one line per criterion that matters: "ok", "partly", "no" or "unknown". */
export function fitReasons(a: FitRow): { key: string; label: string; state: "ok" | "partly" | "no" | "unknown"; text: string }[] {
  const b = fitBreakdown(a);
  const w = icp.fitWeights as Record<keyof FitParts, number>;
  const out: { key: string; label: string; state: "ok" | "partly" | "no" | "unknown"; text: string }[] = [];
  if (b.excluded) out.push({ key: "excluded", label: "Excluded", state: "no", text: b.excluded });
  if (!a.firmo_at) return out.concat([{ key: "facts", label: "Company facts", state: "unknown", text: "Size and stage not looked up yet" }]);
  const st = (v: number, partly = 0.5): "ok" | "partly" | "no" => (v >= 1 ? "ok" : v > 0 ? (v >= partly ? "partly" : "no") : "no");
  out.push({ key: "size", label: "Size", state: st(b.parts.size), text: a.employees != null ? `${a.employees} people` : "size unclear" });
  out.push({ key: "stage", label: "Stage", state: st(b.parts.stage), text: a.stage ?? "stage unclear" });
  out.push({ key: "region", label: "Region", state: st(b.parts.region), text: a.country ?? "region unclear" });
  const unknown = (v: number) => v === 0.5;
  if (w.industry > 0) out.push({ key: "industry", label: "Industry", state: unknown(b.parts.industry) ? "unknown" : st(b.parts.industry), text: a.industry ?? (a.tags ?? []).slice(0, 3).join(", ") ?? "no data" });
  if (w.tools > 0) out.push({ key: "tools", label: "Tools", state: unknown(b.parts.tools) ? (a.tech?.length ? "partly" : "unknown") : st(b.parts.tools), text: a.tech?.length ? a.tech.slice(0, 5).join(", ") : "not known" });
  if (w.motion > 0) out.push({ key: "motion", label: "Sales motion", state: unknown(b.parts.motion) ? "unknown" : st(b.parts.motion, 0.75), text: a.sales_motion ? a.sales_motion.replace("_", "-") : "not known" });
  return out;
}

export function firmoLine(a: { employee_band?: string | null; employees?: number | null; stage?: string | null; raised_usd?: number | null; hq_city?: string | null; country?: string | null; firmo_at?: string | null }): string {
  if (!a.firmo_at) return "";
  return [
    a.employee_band ? `${a.employee_band} people` : a.employees ? `${a.employees} people` : null,
    a.stage && !/^(other|unknown|undisclosed)$/i.test(a.stage) ? a.stage : null,
    a.raised_usd ? `${usdShort(a.raised_usd)} raised` : null,
    a.hq_city ?? a.country ?? null,
  ].filter(Boolean).join(" · ");
}
