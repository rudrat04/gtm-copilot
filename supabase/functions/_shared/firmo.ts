import { sb } from "./db.ts";
import { log } from "./log.ts";
import icp from "./icp.json" with { type: "json" };

// Company facts from Hunter's Company Enrichment (about 0.2 credit per company). Saved once, refreshed rarely.

const EU = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "NO", "CH"]);
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
};

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
  const res = await fetch(`https://api.hunter.io/v2/companies/find?domain=${encodeURIComponent(domain)}&api_key=${key}`, { signal: AbortSignal.timeout(20000) });
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
  };
  await log("info", "firmo_fetched", { account: domain, detail: { employees: firmo.employees, stage: firmo.stage, country: firmo.country }, ms: Date.now() - started });
  return firmo;
}

export async function saveFirmo(accountId: string, f: Firmo) {
  await sb.from("cp_accounts").update({
    employees: f.employees, employee_band: f.band, raised_usd: f.raised, stage: f.stage, last_round_date: f.lastRoundDate,
    founded_year: f.founded, country: f.country, hq_city: f.city, firmo_at: new Date().toISOString(),
  }).eq("id", accountId);
}

// ---- Fit against the ICP (25 points, the "fit" slice of the priority score) ----

type Row = { employees?: number | null; stage?: string | null; country?: string | null; firmo_at?: string | null };

export function fitBreakdown(a: Row): { points: number; known: boolean; size: number; stage: number; region: number; matches: boolean } {
  if (!a.firmo_at) return { points: icp.signals.weights.fit * 0.6, known: false, size: 0, stage: 0, region: 0, matches: false }; // neutral baseline, 15
  const c = icp.company;

  const n = a.employees;
  const size = n == null ? 5 : n >= c.employeesMin && n <= c.employeesMax ? 10
    : n >= c.employeesMin * 0.75 && n <= c.employeesMax * 1.25 ? 5 : 0;

  const s = (a.stage ?? "").toLowerCase();
  const stage = !s || /^(other|debt|grant|unknown|undisclosed)/.test(s) ? 5 // unclear round type: neutral, not a mismatch
    : /pre-?seed|angel|seed|series a|series b/.test(s) ? 10
    : /series c/.test(s) ? 4
    : 0; // series d+, IPO, acquired

  const cc = (a.country ?? "").toUpperCase();
  const region = !cc ? 3 : cc === "US" || cc === "GB" || EU.has(cc) ? 5 : 0;

  return { points: size + stage + region, known: true, size, stage, region, matches: size === 10 && stage === 10 };
}

export const fitPoints = (a: Row) => fitBreakdown(a).points;

const usd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${Math.round(n / 1e6)}M` : `$${Math.round(n / 1e3)}K`);

/** "51-250 people · Series B · $167M raised · London", empty when nothing is known. */
export function firmoLine(a: { employee_band?: string | null; employees?: number | null; stage?: string | null; raised_usd?: number | null; hq_city?: string | null; country?: string | null; firmo_at?: string | null }): string {
  if (!a.firmo_at) return "";
  return [
    a.employee_band ? `${a.employee_band} people` : a.employees ? `${a.employees} people` : null,
    a.stage ?? null,
    a.raised_usd ? `${usd(a.raised_usd)} raised` : null,
    a.hq_city ?? a.country ?? null,
  ].filter(Boolean).join(" · ");
}
