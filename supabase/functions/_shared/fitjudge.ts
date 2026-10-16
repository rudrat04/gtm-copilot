import { sb } from "./db.ts";
import { log } from "./log.ts";
import { icpText, icpVersion, verdictCurrent } from "./fitver.ts";
import { askClaude, BudgetError, parseJson } from "./claude.ts";
import { fetchSite } from "./signals.ts";
import { FIT_COLS } from "./firmo.ts";
import { fitState } from "./score.ts";

// The AI fit judge: the hard gates (size, places, stages, exclusions) stay rules; this reads what the company does and
// says whether it is the kind of company the owner sells to. One small call (about 0.1 cent), saved with the ICP version.

const SYSTEM = `You decide if a company is the right kind of customer for a seller. Judge only from the facts given. 
yes = clearly the kind of company the seller sells to. partial = could be, but the evidence is weak or mixed. no = clearly not (wrong business type, wrong market, a competitor, an agency when the seller targets software firms, and so on).
Return one JSON object: {"fit":"yes"|"partial"|"no","confidence":0-1,"reason":"one short plain sentence"}`;

export async function judgeFit(id: string, force = false): Promise<"judged" | "current" | "skipped" | "failed"> {
  const { data: a } = await sb.from("cp_accounts").select(`id,name,domain,segment,removed_at,fit_ai,fit_ai_ver,fit_override,${FIT_COLS}`).eq("id", id).maybeSingle();
  if (!a || a.removed_at || a.fit_override) return "skipped";
  if (!force && verdictCurrent(a)) return "current";
  if (fitState({ ...a, fit_ai: "yes", fit_ai_ver: icpVersion(), fit_override: null } as never) === "outside") return "skipped"; // size, place, stage or an exclusion already say no (the industry word match is what the judge replaces): no AI spend
  const site = await fetchSite(a.domain).catch(() => null);
  const facts = [
    `Company: ${a.name} (${a.domain})${a.segment ? `, ${a.segment}` : ""}`,
    a.industry_ai || a.industry ? `Industry: ${a.industry_ai ?? a.industry}` : "",
    (a.tags ?? []).length ? `Tags: ${(a.tags as string[]).slice(0, 8).join(", ")}` : "",
    a.blurb ? `About: ${String(a.blurb).slice(0, 300)}` : "",
    site ? `Website: ${site.title.slice(0, 120)} | ${site.description.slice(0, 250)}` : "",
  ].filter(Boolean).join("\n");
  if (!site && !a.blurb && !a.industry) return "skipped"; // nothing to judge on
  try {
    const raw = await askClaude({ feature: "fit_judge", maxTokens: 150, system: SYSTEM, user: `${icpText()}\n\n${facts}` });
    const r = parseJson<{ fit?: string; confidence?: number; reason?: string }>(raw);
    if (r.fit !== "yes" && r.fit !== "partial" && r.fit !== "no") return "failed";
    await sb.from("cp_accounts").update({
      fit_ai: r.fit, fit_ai_conf: Math.max(0, Math.min(1, Number(r.confidence) || 0.5)), fit_ai_reason: String(r.reason ?? "").slice(0, 200),
      fit_ai_ver: icpVersion(), fit_ai_at: new Date().toISOString(),
    }).eq("id", a.id);
    return "judged";
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    await log("warn", "fit_judge_failed", { account: a.domain, message: (e as Error).message });
    return "failed";
  }
}

/** Re-judges companies whose verdict is missing or made for an older profile, best first, within a count. */
export async function judgeMany(limit = 25): Promise<{ done: number; judged: number; left: number; stopped?: string }> {
  const ver = icpVersion();
  const { data } = await sb.from("cp_accounts").select("id,fit_ai_ver").is("removed_at", null).is("fit_override", null)
    .or(`fit_ai_ver.is.null,fit_ai_ver.neq.${ver}`).order("priority_score", { ascending: false, nullsFirst: false }).limit(limit + 200);
  const ids = (data ?? []).map((r) => r.id);
  let done = 0, judged = 0;
  try {
    for (const id of ids.slice(0, limit)) { const r = await judgeFit(id); done++; if (r === "judged") judged++; }
  } catch (e) { if (e instanceof BudgetError) return { done, judged, left: ids.length - done, stopped: "the daily AI limit was reached" }; throw e; }
  return { done, judged, left: Math.max(0, ids.length - done) };
}
