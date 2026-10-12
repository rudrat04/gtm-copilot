import { askClaude, parseJson } from "./claude.ts";
import { log } from "./log.ts";
import type { Signal } from "./signals.ts";

/** The kinds of news that say something about buying intent. Opinion pieces, directory pages and partnerships do not. */
export const USEFUL_NEWS = new Set(["funding", "leadership", "expansion", "product", "customer", "event"]);

/**
 * Names like "Knock", "Linear" or "Axiom" collide with unrelated companies and headlines.
 * Keyword rules cannot resolve that, so one small model call keeps only evidence that is
 * actually about this company. If the call fails, headlines pass through (already
 * heuristically filtered) and unverified job boards are dropped. The same call also labels each kept news item
 * (funding, leadership, product...), so opinion pieces and data pages stop counting as buying signals.
 */
export async function keepRelevant(
  name: string,
  domain: string,
  segment: string,
  headlines: Signal[],
  jobSample: string[] | null,
): Promise<{ headlines: Signal[]; jobsOk: boolean }> {
  if (!headlines.length && !jobSample?.length) return { headlines, jobsOk: true };

  try {
    const raw = await askClaude({
      feature: "relevance",
      maxTokens: 900,
      system:
        "You filter research evidence. Many company names are shared by unrelated companies, products and everyday words. Return a single JSON object and nothing else.",
      user: `The company is "${name}" (${domain})${segment ? `, a ${segment} company` : ""}.

Headlines:
${headlines.map((h, i) => `${i}: ${h.title}`).join("\n") || "(none)"}
${jobSample?.length ? `\nSample job titles from a job board that may belong to a different company with the same name:\n${jobSample.join("; ")}` : ""}

For every headline decide (a) whether it is clearly about THIS company and not a namesake (a clinic, charity, agency, band, place, or a company in another industry; when in doubt, no), and (b) what kind of news it is:
- "funding": the company raised money or was valued/acquired
- "leadership": a new executive or senior hire, or a leadership change
- "expansion": a new office, market, team or large hiring push
- "product": the company launched a product or feature
- "customer": a notable customer win
- "event": the company is hosting, sponsoring or speaking at an event (webinar, conference, summit, launch event)
- "partnership": an integration or partnership
- "opinion": an interview, podcast, column or commentary about the company or its founder
- "listing": a data page about the company (revenue estimate, funding list, profile, comparison)
- "other": anything else
Return JSON: {"items": [{"i": <headline number>, "this_company": true or false, "type": "<one of the types>"}], "jobs_ok": ${jobSample?.length ? "true unless the job titles clearly belong to a different kind of business (for example mortgage, retail or food); software, GTM and engineering roles are consistent with a software company" : "true"}}`,
    });
    const r = parseJson<{ items?: { i?: number; this_company?: boolean; type?: string }[]; jobs_ok?: boolean }>(raw);
    const kept = new Map<number, string>();
    for (const it of r.items ?? []) {
      if (Number.isInteger(it.i) && it.this_company === true) kept.set(it.i!, String(it.type ?? "other"));
    }
    const keep = new Set([...kept].filter(([i, type]) => headlines[i]?.kind !== "news" || USEFUL_NEWS.has(type)).map(([i]) => i));
    await log("info", "relevance_checked", {
      account: domain,
      detail: { headlines: headlines.length, kept: keep.size, jobs_checked: !!jobSample?.length, jobs_ok: r.jobs_ok },
    });
    return {
      headlines: headlines.filter((_, i) => keep.has(i)).map((h) => {
        const type = kept.get(headlines.indexOf(h));
        return h.kind === "news" && type ? { ...h, detail: { ...(h.detail ?? {}), newsType: type } } : h;
      }),
      jobsOk: jobSample?.length ? r.jobs_ok === true : true,
    };
  } catch (e) {
    await log("warn", "relevance_fallback", {
      account: domain,
      message: (e as Error).message,
      detail: { headlines_passed_through: headlines.length, jobs_dropped: !!jobSample?.length },
    });
    return { headlines, jobsOk: !jobSample?.length };
  }
}
