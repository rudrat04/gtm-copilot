import { sb } from "./db.ts";
import { log } from "./log.ts";
import { askClaude, BudgetError, parseJson } from "./claude.ts";
import { fetchSite } from "./signals.ts";
import { INDUSTRIES } from "./lists.ts";

// An industry read from the company's own website, because Hunter's label is often missing or wrong. One small AI call per company
// (about 0.1 cent), saved for good. Fit uses it ahead of Hunter's label.

/** Pure: keeps the answer only if it is one of the known industries. */
export const validIndustry = (v: unknown): string | null => (typeof v === "string" ? INDUSTRIES.find((i) => i.toLowerCase() === v.trim().toLowerCase()) ?? null : null);

export async function industryFromSite(accountId: string): Promise<"set" | "unclear" | "failed"> {
  const { data: a } = await sb.from("cp_accounts").select("id,name,domain,segment").eq("id", accountId).maybeSingle();
  if (!a) return "failed";
  const site = await fetchSite(a.domain);
  if (!site) { await sb.from("cp_accounts").update({ industry_ai_at: new Date().toISOString() }).eq("id", a.id); return "unclear"; }
  try {
    const raw = await askClaude({
      feature: "industry", maxTokens: 120, system: "You classify companies by what they sell. Return one JSON object and nothing else.",
      user: `Company: ${a.name} (${a.domain})${a.segment ? `, ${a.segment}` : ""}\nWebsite title: ${site.title.slice(0, 120)}\nDescription: ${site.description.slice(0, 250)}\nText: ${site.text.slice(0, 700)}\n\nPick the single best industry from this list, exactly as written: ${INDUSTRIES.join("; ")}.\nJSON: {"industry": "<one of the list>"}`,
    });
    const industry = validIndustry(parseJson<{ industry?: string }>(raw).industry);
    await sb.from("cp_accounts").update({ industry_ai: industry, industry_ai_at: new Date().toISOString() }).eq("id", a.id);
    return industry ? "set" : "unclear";
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    await log("warn", "industry_failed", { account: a.domain, message: (e as Error).message });
    return "failed";
  }
}

/** Companies that still have no industry read from their site, best first. */
export async function needIndustry(limit = 30): Promise<string[]> {
  const { data } = await sb.from("cp_accounts").select("id").is("industry_ai_at", null).is("removed_at", null).order("priority_score", { ascending: false, nullsFirst: false }).limit(limit);
  return (data ?? []).map((r) => r.id);
}

export async function industryCheckMany(ids: string[]): Promise<{ done: number; set: number; stopped?: string }> {
  let done = 0, set = 0;
  try {
    for (const id of ids) { const r = await industryFromSite(id); done++; if (r === "set") set++; }
  } catch (e) { if (e instanceof BudgetError) return { done, set, stopped: "the daily AI limit was reached" }; throw e; }
  return { done, set };
}
