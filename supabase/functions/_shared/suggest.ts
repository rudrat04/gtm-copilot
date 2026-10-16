import { askClaude, parseJson } from "./claude.ts";
import { clean, DEPARTMENTS, type Profile, SENIORITIES } from "./profile.ts";
import { INDUSTRIES, REGION_GROUPS, STAGES } from "./lists.ts";
import { fetchSite } from "./signals.ts";

// "What you sell" in, a full proposal for the profile out: one small AI call (about 1 to 2 cents). The owner reviews it before saving.

type Raw = Partial<{
  summary: string; industries: string[]; keywords: string[]; employeesMin: number; employeesMax: number; stages: string[]; regions: string[];
  contact: { departments?: string[]; seniority?: string[]; titleWords?: string[]; excludeTitles?: string[] }; excludeIndustries: string[]; businessModel: string;
  hiringRoles: string[]; painWords: string[]; toolsGood: string[]; toolsAvoid: string[]; competitors: string[]; excludeWords: string[]; motion: string;
}>;

/** Reads the owner's description (and homepage, when given) and proposes who to sell to. Returns a cleaned profile and a one-line summary. */
export async function suggestProfile(current: Profile, description: string, website: string): Promise<{ proposal: Profile; summary: string }> {
  const site = website ? await fetchSite(website).catch(() => null) : null;
  const siteText = site ? `${site.title}. ${site.description}. ${site.text}`.slice(0, 2500) : "";
  const raw = await askClaude({
    feature: "profile_suggest",
    maxTokens: 1400,
    system: "You help a seller decide which companies and people to target. Answer with one JSON object and nothing else. Only use the allowed values where a list is given.",
    user: `What the seller offers:
${description.slice(0, 1500)}
${siteText ? `\nTheir website says:\n${siteText}\n` : ""}
Return JSON with these keys:
- "summary": one plain sentence on who this seller should target
- "industries": 1 to 6 of exactly these (the broad ones fit most software companies; use narrower ones only when they really fit): ${INDUSTRIES.join("; ")}
- "keywords": 3 to 8 short words or phrases that describe what the target companies make or do (for example "crm", "sales enablement", "revenue operations"), used to narrow a company search
- "employeesMin", "employeesMax": the company size (people) that fits best
- "stages": 1 to 5 of: ${STAGES.join("; ")}
- "regions": 1 to 4 of: ${Object.keys(REGION_GROUPS).join("; ")} (or a country name)
- "contact": who to contact, as filters: {"departments": 1 to 4 of ${DEPARTMENTS.join("; ")} in priority order, "seniority": any of ${SENIORITIES.map(([k]) => k).join(", ")}, "titleWords": 3 to 10 job-title phrases people actually have, "excludeTitles": 0 to 5 title words to never contact (for example intern, assistant)}
- "excludeIndustries": industries to never target, from the same list as "industries" (empty is fine)
- "businessModel": "b2b", "b2c" or "any"
- "hiringRoles": 4 to 10 job titles that, when a company hires them, show it needs this seller
- "toolsGood": tools (software names) a good customer probably uses, up to 8
- "toolsAvoid": only software that directly competes with what the seller offers, up to 4 (empty is fine)
- "painWords": 4 to 10 short problems a company has when it needs this seller, as words that would appear in its job posts (for example "crm", "data quality")
- "competitors": only real competitors you are sure exist, up to 5 (empty is fine; never invent names)
- "excludeWords": words that mark a company as not a customer (for example agency, staffing), up to 6
- "motion": "any", "sales_led" or "self_serve"`,
  });
  const r = parseJson<Raw>(raw);
  const merged = {
    ...current,
    industries: r.industries?.length ? r.industries : current.industries,
    keywords: r.keywords?.length ? r.keywords : current.keywords,
    employeesMin: r.employeesMin ?? current.employeesMin,
    employeesMax: r.employeesMax ?? current.employeesMax,
    stages: r.stages?.length ? r.stages : current.stages,
    regions: r.regions?.length ? r.regions : current.regions,
    contact: r.contact && (r.contact.departments?.length || r.contact.titleWords?.length) ? { ...current.contact, ...r.contact } : current.contact,
    personas: current.personas,
    excludeIndustries: r.excludeIndustries ?? current.excludeIndustries,
    businessModel: r.businessModel ?? current.businessModel,
    hiringRoles: r.hiringRoles?.length ? r.hiringRoles : current.hiringRoles,
    painWords: r.painWords?.length ? r.painWords : current.painWords,
    toolsGood: r.toolsGood ?? current.toolsGood,
    toolsAvoid: r.toolsAvoid ?? current.toolsAvoid,
    competitors: r.competitors ?? current.competitors,
    excludeWords: r.excludeWords ?? current.excludeWords,
    motion: r.motion ?? current.motion,
    product: { name: current.product.name, description, website },
  };
  return { proposal: clean(merged), summary: String(r.summary ?? "").slice(0, 300) };
}
