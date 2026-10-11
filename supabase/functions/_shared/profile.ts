import { sb } from "./db.ts";
import icp from "./icp.json" with { type: "json" };
import { MIN_FITS, type MinFit } from "./fitgate.ts";

// The editable part of the ICP. Defaults come from icp.json; the owner's saved changes live in cp_state
// ("profile") and are laid over the defaults at the start of every request, so every module keeps reading
// `icp.*` as before. Nothing here is secret.

export const STAGES = ["Pre-Seed", "Seed", "Series A", "Series B", "Series C"];
export const REGIONS = ["US", "UK", "EU", "Canada", "Australia / NZ", "India"];

// The watch checks and the range each number may take (days, hours or minutes; see flags.ts).
export const WATCH_LIMITS: Record<string, [number, number]> = {
  hotUntouched: [1, 336], followupOverdue: [1, 30], leadPastTarget: [0, 1440], meetingNoDebrief: [1, 30], repliedNoNext: [1, 60],
  dealStuck: [3, 180], thinPipeline: [1, 50], mismatch: [0, 0], drift: [1, 90], system: [0, 0],
};
export type WatchCheck = { on: boolean; n: number };
export type Watch = { urgent: boolean; todoForUrgent: boolean; checks: Record<string, WatchCheck> };

/** One kind of buyer. `weight` is how good a contact this is (100 = the person we most want). `onlyBelow` limits it to small companies. */
export type Persona = { title: string; match: string[]; weight: number; hubspot: string | null; onlyBelow: number | null };
export const MAX_PERSONAS = 8;

export type Profile = {
  industries: string[];
  employeesMin: number;
  employeesMax: number;
  stages: string[];
  regions: string[];
  hiringRoles: string[];                    // job titles that count as a sales or RevOps hiring signal
  signals: { hiring: boolean; news: boolean; community: boolean };
  personas: Persona[];                      // the kinds of buyer we look for, fully editable
  discovery: boolean;                       // weekly auto-discovery on or off
  minFit: MinFit;                           // the fit bar: companies below it are hidden everywhere
  minScore: number;                         // the score needed to count as ready
  watch: Watch;                             // pipeline watch: which checks run and their limits
  fitWeights: Record<"size" | "stage" | "region" | "industry" | "tools" | "motion", number>; // how much each fit criterion counts (0-10)
  toolsGood: string[];                      // tools a good-fit company uses
  toolsAvoid: string[];                     // tools that make a company a poor fit
  motion: "any" | "sales_led" | "self_serve";
  excludeWords: string[];                   // never show a company whose industry, tags, description or name has one of these
  excludeDomains: string[];                 // never show these companies (competitors, partners)
  plAuto: boolean;                          // let the daily watch spend a few PredictLeads calls on the best accounts
};

// Snapshot of the defaults, taken before anything is applied.
const BASE_WEIGHTS = { ...icp.signals.weights };
const DEFAULT: Profile = {
  industries: [...icp.company.industries],
  employeesMin: icp.company.employeesMin,
  employeesMax: icp.company.employeesMax,
  stages: [...icp.company.stages],
  regions: [...icp.company.regions],
  hiringRoles: [...icp.signals.hiringRoles],
  signals: { hiring: true, news: true, community: true },
  personas: icp.personas.map((p) => ({ title: p.title, match: [...p.match], weight: p.weight, hubspot: p.hubspot, onlyBelow: p.onlyBelow })),
  discovery: true,
  minFit: icp.fit.minFit as MinFit,
  minScore: icp.fit.minScore,
  watch: JSON.parse(JSON.stringify(icp.watch)),
  fitWeights: { ...icp.fitWeights },
  toolsGood: [...(icp.company.toolsGood as string[])],
  toolsAvoid: [...(icp.company.toolsAvoid as string[])],
  motion: icp.company.motion as Profile["motion"],
  excludeWords: [...(icp.company.excludeWords as string[])],
  excludeDomains: [...(icp.company.excludeDomains as string[])],
  plAuto: icp.predictleads.auto !== false,
};

const list = (v: unknown, fallback: string[], max = 25, allowEmpty = false): string[] => {
  if (!Array.isArray(v)) return fallback;
  const out = [...new Set(v.map((x) => String(x).trim().replace(/\s+/g, " ").slice(0, 40)).filter(Boolean))].slice(0, max);
  return out.length || allowEmpty ? out : fallback;
};
const num = (v: unknown, fallback: number, lo: number, hi: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/**
 * The owner's own list of buyer types. A saved list from before personas were editable (title and words only) keeps its
 * original weights, HubSpot values and size limit by matching on the title. Personas with no words are dropped.
 */
function cleanPersonas(raw: unknown, legacyFounderBelow: number): Persona[] {
  if (!Array.isArray(raw)) return DEFAULT.personas.map((p) => ({ ...p, match: [...p.match] }));
  const out: Persona[] = [];
  const seen = new Set<string>();
  for (const g of raw.slice(0, MAX_PERSONAS * 2) as Record<string, unknown>[]) {
    const title = String(g?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const base = DEFAULT.personas.find((d) => d.title === title);
    const match = list(g?.match, base?.match ?? [], 20, true);
    if (!title || !match.length || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    let below = 0; // 0 = any company size
    if (g && "onlyBelow" in g) below = num(g.onlyBelow, 0, 0, 100000);
    else if (base?.onlyBelow) below = legacyFounderBelow || base.onlyBelow; // a profile saved before personas were editable
    const hubspot = g && "hubspot" in g ? (typeof g.hubspot === "string" && g.hubspot.trim() ? g.hubspot.trim().slice(0, 60) : null) : (base?.hubspot ?? null);
    out.push({ title, match, weight: g && "weight" in g ? num(g.weight, 70, 10, 100) : (base?.weight ?? 70), hubspot, onlyBelow: below >= 2 ? below : null });
    if (out.length >= MAX_PERSONAS) break;
  }
  return out.length ? out : DEFAULT.personas.map((p) => ({ ...p, match: [...p.match] }));
}

function cleanWeights(raw: unknown): Profile["fitWeights"] {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = {} as Profile["fitWeights"];
  for (const k of Object.keys(DEFAULT.fitWeights) as (keyof Profile["fitWeights"])[]) out[k] = r[k] === undefined ? DEFAULT.fitWeights[k] : num(r[k], DEFAULT.fitWeights[k], 0, 10);
  if (!Object.values(out).some((v) => v > 0)) return { ...DEFAULT.fitWeights }; // at least one criterion has to count
  return out;
}

function cleanWatch(raw: unknown): Watch {
  const w = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const given = (w.checks && typeof w.checks === "object" ? w.checks : {}) as Record<string, { on?: unknown; n?: unknown }>;
  const checks: Record<string, WatchCheck> = {};
  for (const [k, [lo, hi]] of Object.entries(WATCH_LIMITS)) {
    const base = DEFAULT.watch.checks[k];
    checks[k] = { on: given[k] ? given[k].on !== false : base.on, n: lo === hi ? base.n : num(given[k]?.n, base.n, lo, hi) };
  }
  return { urgent: w.urgent !== false, todoForUrgent: w.todoForUrgent !== false, checks };
}

/** Validates anything coming from the page. Unknown or invalid values fall back to the defaults. */
export function clean(input: unknown): Profile {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const min = num(i.employeesMin, DEFAULT.employeesMin, 1, 100000);
  const max = Math.max(min, num(i.employeesMax, DEFAULT.employeesMax, 1, 100000));
  const sig = (i.signals ?? {}) as Record<string, unknown>;
  const news = sig.news !== false, community = sig.community !== false;
  const hiring = sig.hiring !== false || (!news && !community); // at least one signal has to count
  const stages = (Array.isArray(i.stages) ? i.stages : []).map(String).filter((s) => STAGES.includes(s));
  const regions = (Array.isArray(i.regions) ? i.regions : []).map(String).filter((s) => REGIONS.includes(s));
  const personas = cleanPersonas(i.personas, num(i.founderBelow, 0, 0, 1000));
  return {
    industries: list(i.industries, DEFAULT.industries, 12),
    employeesMin: min,
    employeesMax: max,
    stages: stages.length ? stages : DEFAULT.stages,
    regions: regions.length ? regions : DEFAULT.regions,
    hiringRoles: list(i.hiringRoles, DEFAULT.hiringRoles, 30),
    signals: { hiring, news, community },
    personas,
    discovery: i.discovery !== false,
    minFit: MIN_FITS.find((m) => m === i.minFit) ?? DEFAULT.minFit,
    minScore: num(i.minScore, DEFAULT.minScore, 0, 90),
    watch: cleanWatch(i.watch),
    fitWeights: cleanWeights(i.fitWeights),
    toolsGood: list(i.toolsGood, [], 20, true),
    toolsAvoid: list(i.toolsAvoid, [], 20, true),
    motion: (["any", "sales_led", "self_serve"] as const).find((m) => m === i.motion) ?? "any",
    excludeWords: list(i.excludeWords, [], 20, true),
    excludeDomains: list(i.excludeDomains, [], 30, true).map((d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")).filter(Boolean),
    plAuto: i.plAuto !== false,
  };
}

/** Lays a profile over the shared config, in place. */
export function apply(p: Profile) {
  icp.company.industries = p.industries;
  icp.company.employeesMin = p.employeesMin;
  icp.company.employeesMax = p.employeesMax;
  icp.company.stages = p.stages;
  icp.company.regions = p.regions;
  icp.signals.hiringRoles = p.hiringRoles;
  icp.signals.weights.hiring = p.signals.hiring ? BASE_WEIGHTS.hiring : 0;
  icp.signals.weights.news = p.signals.news ? BASE_WEIGHTS.news : 0;
  icp.signals.weights.tech = p.signals.community ? BASE_WEIGHTS.tech : 0;
  (icp.personas as Persona[]).splice(0, icp.personas.length, ...p.personas.map((x) => ({ ...x, match: [...x.match] }))); // the list itself is replaced, so every module sees it
  (icp.discovery as { enabled?: boolean }).enabled = p.discovery;
  icp.fit.minFit = p.minFit;
  icp.fit.minScore = p.minScore;
  Object.assign(icp.watch, JSON.parse(JSON.stringify(p.watch)));
  icp.predictleads.auto = p.plAuto;
  Object.assign(icp.fitWeights, p.fitWeights);
  const c = icp.company as { toolsGood: string[]; toolsAvoid: string[]; motion: string; excludeWords: string[]; excludeDomains: string[] };
  c.toolsGood = p.toolsGood; c.toolsAvoid = p.toolsAvoid; c.motion = p.motion; c.excludeWords = p.excludeWords; c.excludeDomains = p.excludeDomains;
}

export async function loadProfile(): Promise<Profile> {
  const { data } = await sb.from("cp_state").select("value").eq("key", "profile").maybeSingle();
  if (!data?.value) return DEFAULT;
  try {
    return clean(JSON.parse(data.value));
  } catch {
    return DEFAULT;
  }
}

export async function saveProfile(p: Profile) {
  await sb.from("cp_state").upsert({ key: "profile", value: JSON.stringify(p), updated_at: new Date().toISOString() });
  apply(p);
}

let appliedAt = 0;
/** Called at the start of every request. A short cache keeps the extra read to a few a minute. */
export async function applyProfile() {
  if (Date.now() - appliedAt < 20_000) return;
  appliedAt = Date.now();
  try {
    apply(await loadProfile());
  } catch { /* keep the defaults */ }
}
