import { sb } from "./db.ts";
import icp from "./icp.json" with { type: "json" };

// The editable part of the ICP. Defaults come from icp.json; the owner's saved changes live in cp_state
// ("profile") and are laid over the defaults at the start of every request, so every module keeps reading
// `icp.*` as before. Nothing here is secret.

export const STAGES = ["Pre-Seed", "Seed", "Series A", "Series B", "Series C"];
export const REGIONS = ["US", "UK", "EU", "Canada", "Australia / NZ", "India"];

export type Profile = {
  industries: string[];
  employeesMin: number;
  employeesMax: number;
  stages: string[];
  regions: string[];
  hiringRoles: string[];                    // job titles that count as a sales or RevOps hiring signal
  signals: { hiring: boolean; news: boolean; community: boolean };
  personas: { title: string; match: string[] }[]; // job titles we want to contact
  founderBelow: number;                     // a founder is the buyer only under this many people
  discovery: boolean;                       // weekly auto-discovery on or off
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
  personas: icp.personas.map((p) => ({ title: p.title, match: [...p.match] })),
  founderBelow: (icp.personas.find((p) => "onlyIfEmployeesBelow" in p) as { onlyIfEmployeesBelow?: number } | undefined)?.onlyIfEmployeesBelow ?? 30,
  discovery: true,
};

const list = (v: unknown, fallback: string[], max = 25): string[] => {
  if (!Array.isArray(v)) return fallback;
  const out = [...new Set(v.map((x) => String(x).trim().replace(/\s+/g, " ").slice(0, 40)).filter(Boolean))].slice(0, max);
  return out.length ? out : fallback;
};
const num = (v: unknown, fallback: number, lo: number, hi: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

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
  const given = Array.isArray(i.personas) ? i.personas as { title?: string; match?: unknown }[] : [];
  return {
    industries: list(i.industries, DEFAULT.industries, 12),
    employeesMin: min,
    employeesMax: max,
    stages: stages.length ? stages : DEFAULT.stages,
    regions: regions.length ? regions : DEFAULT.regions,
    hiringRoles: list(i.hiringRoles, DEFAULT.hiringRoles, 30),
    signals: { hiring, news, community },
    personas: DEFAULT.personas.map((p) => ({ title: p.title, match: list(given.find((g) => g.title === p.title)?.match, p.match, 20) })),
    founderBelow: num(i.founderBelow, DEFAULT.founderBelow, 2, 1000),
    discovery: i.discovery !== false,
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
  for (const persona of icp.personas) {
    const mine = p.personas.find((x) => x.title === persona.title);
    if (mine) persona.match = mine.match;
    if ("onlyIfEmployeesBelow" in persona) (persona as { onlyIfEmployeesBelow: number }).onlyIfEmployeesBelow = p.founderBelow;
  }
  (icp.discovery as { enabled?: boolean }).enabled = p.discovery;
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
