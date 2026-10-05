import { askClaude, parseJson } from "./claude.ts";
import { log } from "./log.ts";
import type { Signal } from "./signals.ts";

/**
 * Names like "Knock", "Linear" or "Axiom" collide with unrelated companies and headlines.
 * Keyword rules cannot resolve that, so one small model call keeps only evidence that is
 * actually about this company. If the call fails, headlines pass through (already
 * heuristically filtered) and unverified job boards are dropped.
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
      maxTokens: 200,
      system:
        "You filter research evidence. Many company names are shared by unrelated companies, products and everyday words. Return a single JSON object and nothing else.",
      user: `The company is "${name}" (${domain})${segment ? `, a ${segment} company` : ""}.

Headlines:
${headlines.map((h, i) => `${i}: ${h.title}`).join("\n") || "(none)"}
${jobSample?.length ? `\nSample job titles from a job board that may belong to a different company with the same name:\n${jobSample.join("; ")}` : ""}

Return JSON: {"keep": [indices of headlines clearly about THIS company, not a namesake], "jobs_ok": ${jobSample?.length ? "true unless the job titles clearly belong to a different kind of business (for example mortgage, retail or food); software, GTM and engineering roles are consistent with a software company" : "true"}}`,
    });
    const r = parseJson<{ keep?: number[]; jobs_ok?: boolean }>(raw);
    const keep = new Set((r.keep ?? []).filter((n) => Number.isInteger(n)));
    await log("info", "relevance_checked", {
      account: domain,
      detail: { headlines: headlines.length, kept: keep.size, jobs_checked: !!jobSample?.length, jobs_ok: r.jobs_ok },
    });
    return {
      headlines: headlines.filter((_, i) => keep.has(i)),
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
