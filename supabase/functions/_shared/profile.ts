import { sb } from "./db.ts";
import icp from "./icp.json" with { type: "json" };
import { MIN_FITS, type MinFit } from "./fitgate.ts";
import { INDUSTRIES, migrateIndustries, REGIONS, RULE_TYPES, STAGES } from "./lists.ts";

export { INDUSTRIES, REGIONS, STAGES };

// The editable part of the ICP. Defaults come from icp.json; the owner's saved changes live in cp_state
// ("profile") and are laid over the defaults at the start of every request, so every module keeps reading
// `icp.*` as before. Nothing here is secret.


// The watch checks and the range each number may take (days, hours or minutes; see flags.ts).
export const WATCH_LIMITS: Record<string, [number, number]> = {
  hotUntouched: [1, 336], followupOverdue: [1, 30], leadPastTarget: [0, 1440], meetingNoDebrief: [1, 30], repliedNoNext: [1, 60],
  dealStuck: [3, 180], thinPipeline: [1, 50], mismatch: [0, 0], drift: [1, 90], system: [0, 0],
};
export type WatchCheck = { on: boolean; n: number };
export type Watch = { mail: Record<string, boolean>; urgent: boolean; todoForUrgent: boolean; alertsPerDay: number; alertSearches: number; alertReserve: number; autoFix: boolean; titleCheck: boolean; autoPush: boolean; activityPerDay: number; watchlistAlerts: boolean; todayCap: number; digestFlags: boolean; checks: Record<string, WatchCheck> };

/**
 * One kind of buyer. The list order is the priority (first = the person we most want), which sets `weight` (100 down to 60).
 * `department` and `seniority` narrow who matches; `hubspot` is the "Scored persona" value, found or created automatically on save.
 * `onlyBelow` is kept for old saved profiles and is always null now.
 */
export type Persona = { title: string; match: string[]; weight: number; hubspot: string | null; onlyBelow: number | null; department: string; seniority: string[] };
/** Hunter's own departments (what its people search accepts and what it labels each person with), so a choice here is a filter there. */
export const DEPARTMENTS = ["Executive", "Management", "Sales", "Marketing", "Operations", "Finance", "Product", "IT", "Support", "HR", "Legal", "Communication", "Design", "Procurement", "Research", "Consulting", "Education", "Health", "Administrative"];
const LEGACY_DEPARTMENTS: Record<string, string> = { "Revenue operations": "Operations", Engineering: "IT", "Customer success": "Support", "People / HR": "HR" };
/** Pure: a saved department as one of Hunter's (an older name is translated; anything else is dropped). */
export const migrateDepartment = (v: unknown): string => { const d = String(v ?? ""); return DEPARTMENTS.includes(d) ? d : LEGACY_DEPARTMENTS[d] ?? ""; };

export const SENIORITIES = [["founder_c", "Founder / C-level"], ["vp", "VP"], ["head_director", "Head / Director"], ["manager", "Manager"], ["ic", "Individual contributor"]] as const;
export const PRODUCT_MAX = 1500;

/** Who to contact, as separate filters that combine: a person must be in one of the departments, at one of the levels, and (when words are given) have one of the title words. */
export type ContactRules = { departments: string[]; seniority: string[]; titleWords: string[]; excludeTitles: string[]; maxPerCompany: number; verifiedOnly: boolean; decisionOnly: boolean };
export type CompanyAge = { min: number | null; max: number | null };

/** A signal the owner added: what kind, what to look for, and whether it is on. Weights are automatic by kind. */
export type SignalRule = { id: string; type: string; words: string[]; on: boolean };
export const MAX_RULES = 12;
export const MAX_PERSONAS = 8;

export type Profile = {
  product: { name: string; description: string; website: string }; // what the owner sells: the suggestion for everything else is made from this
  signalRules: SignalRule[];                // extra signals: tools, competitors, press, changes, watch phrases
  painWords: string[];                      // problems that, when a job post mentions them, show a company needs what you sell
  competitors: string[];                    // competitor names or domains, for the "uses a competitor" signal and the never-show list
  industries: string[];                     // Hunter's own industry names
  keywords: string[];                       // words that describe the companies you want (Hunter's keyword filter), for example crm, sales enablement
  employeesMin: number;
  employeesMax: number;
  stages: string[];
  regions: string[];
  hiringRoles: string[];                    // job titles that count as a sales or RevOps hiring signal
  signals: { hiring: boolean; news: boolean; community: boolean };
  personas: Persona[];                      // worked out from `contact` (one per department, in order); kept so the rest of the system reads the same shape
  contact: ContactRules;                    // the filters the owner sets in "Who we contact"
  excludeIndustries: string[];              // all industries except these
  excludeRegions: string[];                 // places never wanted, even inside a chosen region
  companyAge: CompanyAge;                   // years since founding
  businessModel: "any" | "b2b" | "b2c";
  companyType: "any" | "private" | "public";
  discovery: boolean;                       // weekly auto-discovery on or off
  strictFit: boolean;                       // places and industries are hard filters: a known mismatch is "outside", hidden and never alerted
  minFit: MinFit;                           // the fit bar: companies below it are hidden everywhere
  minScore: number;                         // the score needed to count as ready
  watch: Watch;                             // pipeline watch: which checks run and their limits
  fitWeights: Record<"size" | "stage" | "region" | "industry" | "tools" | "motion", number>; // how much each fit criterion counts (0-10)
  toolsGood: string[];                      // tools a good-fit company uses
  toolsAvoid: string[];                     // tools that make a company a poor fit
  motion: "any" | "sales_led" | "self_serve";
  excludeWords: string[];                   // never show a company whose industry, tags, description or name has one of these
  excludeDomains: string[];                 // never show these companies (competitors, partners)
  roundWindow: [number, number];            // days after a funding round when a company is best timed
  plAuto: boolean;                          // let the daily watch spend a few PredictLeads calls on the best accounts
};

// Snapshot of the defaults, taken before anything is applied.
const BASE_SELLER = { name: icp.seller.name, pitch: icp.seller.pitch };
const BASE_WEIGHTS = { ...icp.signals.weights };
const DEFAULT: Profile = {
  product: { name: "", description: "", website: "" },
  competitors: [],
  painWords: [...icp.signals.painWords],
  signalRules: [],
  industries: [...icp.company.industries],
  keywords: [...((icp.company as { keywords?: string[] }).keywords ?? [])],
  employeesMin: icp.company.employeesMin,
  employeesMax: icp.company.employeesMax,
  stages: [...icp.company.stages],
  regions: [...icp.company.regions],
  strictFit: icp.company.strictFit,
  hiringRoles: [...icp.signals.hiringRoles],
  signals: { hiring: true, news: true, community: true },
  personas: icp.personas.map((p, i) => ({ title: p.title, match: [...p.match], weight: Math.max(60, 100 - 5 * i), hubspot: p.hubspot, onlyBelow: null, department: "", seniority: [] })),
  contact: { departments: [], seniority: [], titleWords: [], excludeTitles: [], maxPerCompany: 2, verifiedOnly: false, decisionOnly: false },
  excludeIndustries: [], excludeRegions: [], companyAge: { min: null, max: null }, businessModel: "any", companyType: "any",
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
  roundWindow: [icp.timing.roundWindowDays[0], icp.timing.roundWindowDays[1]],
  plAuto: icp.predictleads.auto !== false,
};

const list = (v: unknown, fallback: string[], max = 25, allowEmpty = false): string[] => {
  if (!Array.isArray(v)) return fallback;
  const out = [...new Set(v.map((x) => String(x).trim().replace(/\s+/g, " ").slice(0, 40)).filter(Boolean))].slice(0, max);
  return out.length || allowEmpty ? out : fallback;
};
/** A website address as typed, reduced to a host name; anything that is not a public host is dropped. */
function cleanSite(v: unknown): string {
  const h = String(v ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(h) && h.length <= 80 ? h : "";
}
const num = (v: unknown, fallback: number, lo: number, hi: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** The owner's own list of buyer types, in priority order. Types with no job-title words are dropped. */
function cleanPersonas(raw: unknown): Persona[] {
  if (!Array.isArray(raw)) return DEFAULT.personas.map((p) => ({ ...p, match: [...p.match], seniority: [] }));
  const out: Persona[] = [];
  const seen = new Set<string>();
  for (const g of raw.slice(0, MAX_PERSONAS * 2) as Record<string, unknown>[]) {
    const title = String(g?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const base = DEFAULT.personas.find((d) => d.title === title);
    const match = list(g?.match, base?.match ?? [], 20, true);
    if (!title || !match.length || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const hubspot = g && "hubspot" in g ? (typeof g.hubspot === "string" && g.hubspot.trim() ? g.hubspot.trim().slice(0, 60) : null) : (base?.hubspot ?? null);
    const department = migrateDepartment(g?.department);
    const seniority = (Array.isArray(g?.seniority) ? g.seniority : []).map(String).filter((x) => SENIORITIES.some(([k]) => k === x));
    out.push({ title, match, weight: Math.max(60, 100 - 5 * out.length), hubspot, onlyBelow: null, department, seniority });
    if (out.length >= MAX_PERSONAS) break;
  }
  return out.length ? out : DEFAULT.personas.map((p) => ({ ...p, match: [...p.match], seniority: [] }));
}

function cleanRules(raw: unknown): SignalRule[] {
  if (!Array.isArray(raw)) return [];
  const out: SignalRule[] = [];
  for (const r of raw.slice(0, MAX_RULES * 2) as Record<string, unknown>[]) {
    const type = RULE_TYPES.find((t) => t.key === r?.type)?.key;
    const words = list(r?.words, [], 10, true);
    if (!type || !words.length) continue;
    out.push({ id: String(r?.id ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 12) || `r${out.length + 1}${type}`, type, words, on: r?.on !== false });
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

function cleanWindow(raw: unknown): [number, number] {
  const r = Array.isArray(raw) ? raw : [];
  const lo = num(r[0], DEFAULT.roundWindow[0], 0, 720);
  return [lo, Math.max(lo + 1, num(r[1], DEFAULT.roundWindow[1], 1, 1080))];
}

/** How much each fit criterion counts is automatic: size, stage and region always, the rest only when the owner gave something to compare with. */
export function autoWeights(p: Pick<Profile, "industries" | "toolsGood" | "toolsAvoid" | "motion">): Profile["fitWeights"] {
  const ownIndustries = p.industries.join() !== DEFAULT.industries.join(); // counts only once the owner has chosen their own
  return { size: 10, stage: 10, region: 5, industry: ownIndustries ? 4 : 0, tools: p.toolsGood.length + p.toolsAvoid.length ? 5 : 0, motion: p.motion !== "any" ? 4 : 0 };
}

import { MAIL_KEYS } from "./switches.ts";
function cleanMail(raw: unknown): Record<string, boolean> {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return Object.fromEntries(MAIL_KEYS.map((k) => [k, m[k] !== false]));
}

function cleanWatch(raw: unknown): Watch {
  const w = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const given = (w.checks && typeof w.checks === "object" ? w.checks : {}) as Record<string, { on?: unknown; n?: unknown }>;
  const checks: Record<string, WatchCheck> = {};
  for (const [k, [lo, hi]] of Object.entries(WATCH_LIMITS)) {
    const base = DEFAULT.watch.checks[k];
    checks[k] = { on: given[k] ? given[k].on !== false : base.on, n: lo === hi ? base.n : num(given[k]?.n, base.n, lo, hi) };
  }
  return {
    mail: cleanMail(w.mail), urgent: w.urgent !== false, todoForUrgent: w.todoForUrgent !== false, checks,
    alertsPerDay: num(w.alertsPerDay, DEFAULT.watch.alertsPerDay, 0, 10), alertSearches: num(w.alertSearches, DEFAULT.watch.alertSearches, 0, 10), alertReserve: num(w.alertReserve, DEFAULT.watch.alertReserve, 0, 45), autoFix: w.autoFix === true, titleCheck: w.titleCheck === true, autoPush: w.autoPush !== false, activityPerDay: num(w.activityPerDay, DEFAULT.watch.activityPerDay, 0, 6), watchlistAlerts: w.watchlistAlerts !== false,
    todayCap: num(w.todayCap, DEFAULT.watch.todayCap, 3, 15), digestFlags: w.digestFlags !== false,
  };
}


const isDomain = (w: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(w.trim()) && !/\s/.test(w);
const optYears = (v: unknown): number | null => { if (v === null || v === undefined || v === "") return null; const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(200, Math.max(0, n)) : null; };

/** Pure: the contact filters from what was sent. An older saved profile (buyer types only) is turned into filters so nothing is lost. */
export function cleanContact(raw: unknown, legacy: unknown): ContactRules {
  const c = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
  const old = Array.isArray(legacy) ? (legacy as Record<string, unknown>[]) : [];
  const fromOld = !c && old.length;
  const departments = c ? (Array.isArray(c.departments) ? c.departments : []).map(migrateDepartment).filter(Boolean) : fromOld ? old.map((g) => migrateDepartment(g?.department)).filter(Boolean) : [];
  const seniority = c ? (Array.isArray(c.seniority) ? c.seniority : []) : fromOld ? old.flatMap((g) => (Array.isArray(g?.seniority) ? g.seniority : [])) : [];
  const titleWords = c ? list(c.titleWords, [], 30, true) : fromOld ? list(old.flatMap((g) => (Array.isArray(g?.match) ? g.match : [])), [], 30, true) : [];
  return {
    departments: [...new Set(departments)].slice(0, MAX_PERSONAS),
    seniority: [...new Set(seniority.map(String).filter((x) => SENIORITIES.some(([k]) => k === x)))],
    titleWords, excludeTitles: list(c?.excludeTitles, [], 20, true),
    maxPerCompany: num(c?.maxPerCompany, DEFAULT.contact.maxPerCompany, 1, 5), verifiedOnly: c?.verifiedOnly === true, decisionOnly: c?.decisionOnly === true,
  };
}

/** Pure: the buyer groups the rest of the system reads, one per chosen department in order (or one general group), from the filters. */
export function personasFromContact(c: ContactRules, previous: Persona[] = []): Persona[] {
  if (!c.departments.length && !c.titleWords.length && !c.seniority.length) return DEFAULT.personas.map((p) => ({ ...p, match: [...p.match], seniority: [] }));
  const keep = (t: string) => previous.find((p) => p.title.toLowerCase() === t.toLowerCase())?.hubspot ?? DEFAULT.personas.find((p) => p.title.toLowerCase() === t.toLowerCase())?.hubspot ?? null;
  const groups = c.departments.length ? c.departments : [""];
  return groups.map((d, i) => ({ title: d || "Buyer", match: [...c.titleWords], weight: Math.max(60, 100 - 5 * i), hubspot: keep(d || "Buyer"), onlyBelow: null, department: d, seniority: [...c.seniority] }));
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
  const regions = (Array.isArray(i.regions) ? i.regions : []).map(String).map((s) => (/^city:/i.test(s) ? `city:${s.slice(5).trim().slice(0, 50)}` : s)).filter((s) => REGIONS.includes(s) || /^city:.{2,50}$/.test(s)).slice(0, 25);
  const contact = cleanContact(i.contact, i.personas);
  const personas = personasFromContact(contact, Array.isArray(i.personas) ? cleanPersonas(i.personas) : []);
  const industries = (Array.isArray(i.industries) ? i.industries : []).map(String);
  const industriesMigrated = migrateIndustries(industries).slice(0, 25); // an industry saved under an older name becomes the matching Hunter industry
  const pr = (i.product && typeof i.product === "object" ? i.product : {}) as Record<string, unknown>;
  const toolsGood = list(i.toolsGood, [], 20, true), toolsAvoid = list(i.toolsAvoid, [], 20, true);
  const motion = "any" as const; // sales style was removed from Setup; it no longer affects fit
  const industriesOut = industriesMigrated.length ? industriesMigrated : DEFAULT.industries;
  return {
    product: { name: String(pr.name ?? "").replace(/[<>\p{C}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40), description: String(pr.description ?? "").trim().slice(0, PRODUCT_MAX), website: cleanSite(pr.website) },
    competitors: list(i.competitors, [], 15, true),
    painWords: list(i.painWords, DEFAULT.painWords, 15),
    signalRules: cleanRules(i.signalRules),
    industries: industriesOut,
    keywords: list(i.keywords, [], 10, true),
    employeesMin: min,
    employeesMax: max,
    stages: stages.length ? stages : DEFAULT.stages,
    regions: regions.length ? regions : DEFAULT.regions,
    hiringRoles: list(i.hiringRoles, DEFAULT.hiringRoles, 30),
    signals: { hiring, news, community },
    personas,
    contact,
    excludeIndustries: migrateIndustries(Array.isArray(i.excludeIndustries) ? i.excludeIndustries.map(String) : []).slice(0, 25),
    excludeRegions: (Array.isArray(i.excludeRegions) ? i.excludeRegions : []).map(String).filter((x) => REGIONS.includes(x)),
    companyAge: (() => { const a = i.companyAge as Record<string, unknown> | undefined; const mn = optYears(a?.min), mx = optYears(a?.max); return { min: mn, max: mx != null && mn != null ? Math.max(mn, mx) : mx }; })(),
    businessModel: (["any", "b2b", "b2c"] as const).find((m) => m === i.businessModel) ?? "any",
    companyType: (["any", "private", "public"] as const).find((m) => m === i.companyType) ?? "any",
    discovery: i.discovery !== false,
    strictFit: i.strictFit !== false,
    minFit: MIN_FITS.find((m) => m === i.minFit) ?? DEFAULT.minFit,
    minScore: num(i.minScore, DEFAULT.minScore, 0, 90),
    watch: cleanWatch(i.watch),
    fitWeights: autoWeights({ industries: industriesOut, toolsGood, toolsAvoid, motion }),
    toolsGood,
    toolsAvoid,
    motion,
    excludeWords: list(i.excludeWords, [], 30, true).filter((w) => !isDomain(w)),
    excludeDomains: [...list(i.excludeDomains, [], 30, true), ...list(i.excludeWords, [], 30, true).filter(isDomain)].map((d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")).filter(Boolean),
    roundWindow: cleanWindow(i.roundWindow),
    plAuto: i.plAuto !== false,
  };
}

/** Lays a profile over the shared config, in place. */
export function apply(p: Profile) {
  icp.company.industries = p.industries;
  (icp.company as { keywords?: string[] }).keywords = p.keywords;
  icp.company.employeesMin = p.employeesMin;
  icp.company.employeesMax = p.employeesMax;
  icp.company.stages = p.stages;
  icp.company.regions = p.regions;
  icp.company.strictFit = p.strictFit;
  icp.seller.name = p.product.name || (p.product.description ? "the seller" : BASE_SELLER.name); // never the old sample name once you describe your own offer
  // what you sell (Setup) is what the dossiers, drafts and screening are written for
  icp.seller.pitch = p.product.description || BASE_SELLER.pitch;
  icp.signals.hiringRoles = p.hiringRoles;
  icp.signals.painWords = p.painWords;
  (icp.signals as { rules: SignalRule[] }).rules = p.signalRules.map((r) => ({ ...r, words: [...r.words] }));
  icp.signals.weights.hiring = p.signals.hiring ? BASE_WEIGHTS.hiring : 0;
  icp.signals.weights.news = p.signals.news ? BASE_WEIGHTS.news : 0;
  icp.signals.weights.tech = p.signals.community ? BASE_WEIGHTS.tech : 0;
  (icp.personas as Persona[]).splice(0, icp.personas.length, ...p.personas.map((x) => ({ ...x, match: [...x.match] }))); // the list itself is replaced, so every module sees it
  Object.assign(icp.company, { excludeIndustries: p.excludeIndustries, excludeRegions: p.excludeRegions, companyAge: p.companyAge, businessModel: p.businessModel, companyType: p.companyType });
  (icp as { contactRules?: ContactRules }).contactRules = p.contact;
  (icp.contacts as { perItem: number }).perItem = p.contact.maxPerCompany;
  (icp.discovery as { enabled?: boolean }).enabled = p.discovery;
  icp.fit.minFit = p.minFit;
  icp.fit.minScore = p.minScore;
  Object.assign(icp.watch, JSON.parse(JSON.stringify(p.watch)));
  icp.alerts.maxPerDay = p.watch.alertsPerDay; // the same number the alert emails and the daily limit read
  icp.today.cap = p.watch.todayCap;
  icp.predictleads.auto = p.plAuto;
  Object.assign(icp.fitWeights, p.fitWeights);
  icp.timing.roundWindowDays = [p.roundWindow[0], p.roundWindow[1]];
  const c = icp.company as { toolsGood: string[]; toolsAvoid: string[]; motion: string; excludeWords: string[]; excludeDomains: string[] };
  (c as { competitors?: string[] }).competitors = p.competitors;
  c.toolsGood = p.toolsGood; c.toolsAvoid = [...new Set([...p.toolsAvoid, ...p.competitors])]; // a competitor's product in use is a poor sign too
  c.motion = p.motion; c.excludeWords = p.excludeWords;
  // competitors written as domains are never shown either
  c.excludeDomains = [...new Set([...p.excludeDomains, ...p.competitors.map((x) => x.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")).filter((x) => /\.[a-z]{2,}$/.test(x))])];
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
