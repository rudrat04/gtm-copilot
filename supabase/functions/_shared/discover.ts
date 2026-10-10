import { normalizeDomain, sb } from "./db.ts";
import { log } from "./log.ts";
import { askClaude, parseJson } from "./claude.ts";
import { fetchSite } from "./signals.ts";
import { fetchFirmo, fitBreakdown, saveFirmo } from "./firmo.ts";
import icp from "./icp.json" with { type: "json" };

// Finds new companies for the pipeline from public sources, so reps do not have to hunt for them.
// Source today: the monthly Hacker News "Who is hiring" thread, which lists companies that are hiring right now.
// Companies hiring sales or RevOps roles are the strongest signal for the seller, so only those posts are kept.

export type Candidate = { name: string; domain: string; source: string; sourceUrl: string; snippet: string };

const cfg = icp.discovery;
/** Sales or RevOps roles to look for: the profile's hiring roles plus the general words. */
const salesRegex = () => new RegExp(`\\b(${[...icp.signals.hiringRoles, "sales", "go-to-market", "gtm", "business development"].map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
// Links that are not the company's own website.
const NOT_COMPANY = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|rippling\.com|linkedin\.com|github\.com|gitlab\.com|notion\.(site|so)|google\.com|docs\.google\.com|twitter\.com|x\.com|youtube\.com|medium\.com|ycombinator\.com|techcrunch\.com|venturebeat\.com|forbes\.com|bloomberg\.com|wsj\.com|reddit\.com|substack\.com|producthunt\.com|arxiv\.org|wikipedia\.org|workatastartup\.com|wellfound\.com|angel\.co|jobs\.|bamboohr\.com|smartrecruiters\.com|teamtailor\.com|recruitee\.com|breezy\.hr|jobvite\.com|myworkdayjobs\.com|hn\.algolia\.com|news\.ycombinator\.com|linktr\.ee|calendly\.com)$/i;

function decode(html: string): string {
  return html
    .replace(/<p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&#x2F;/g, "/").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ").trim();
}

/** The company's own site from a post, ignoring job boards and social links. */
export function companyDomain(text: string, nameSegment: string): string | null {
  const asDomain = normalizeDomain(nameSegment.split(/\s/)[0] ?? "");
  if (asDomain && !NOT_COMPANY.test(asDomain)) return asDomain; // the post is headed by the site itself
  for (const m of text.matchAll(/https?:\/\/[^\s)"'<>,]+/gi)) {
    let host = "";
    try {
      host = new URL(m[0]).hostname.replace(/^www\./, "").toLowerCase();
    } catch { continue; }
    if (!NOT_COMPANY.test(host) && normalizeDomain(host)) return host;
  }
  return null;
}

/** Pure parsing of one top-level thread comment. Returns null when it is not a usable company post. */
export function parsePost(html: string, id: string): Candidate | null {
  const text = decode(html);
  const first = text.split("\n")[0] ?? "";
  if ((first.match(/\|/g) ?? []).length < 2) return null; // company posts start "Company | Role | Place | ..."
  const name = first.split("|")[0].trim().replace(/\s*\(.*$/, "").slice(0, 60);
  if (!name || name.length < 2) return null;
  if (!salesRegex().test(text.slice(0, 500))) return null; // keep only companies hiring sales / RevOps roles
  const domain = companyDomain(text, first.split("|")[0]);
  if (!domain) return null;
  return { name, domain, source: "hn_hiring", sourceUrl: `https://news.ycombinator.com/item?id=${id}`, snippet: first.slice(0, 220) };
}

async function getJson(url: string) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Companies hiring sales roles in the latest "Who is hiring" threads. */
export async function collectHiring(): Promise<Candidate[]> {
  const threads = await getJson(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent('"Ask HN: Who is hiring"')}&tags=story,author_whoishiring&hitsPerPage=${cfg.threads + 2}`);
  const ids: string[] = (threads?.hits ?? []).filter((h: { title: string }) => /who is hiring/i.test(h.title)).slice(0, cfg.threads).map((h: { objectID: string }) => h.objectID);
  const since = Date.now() - cfg.maxAgeDays * 86_400_000;
  const out = new Map<string, Candidate>();
  for (const id of ids) {
    const page = await getJson(`https://hn.algolia.com/api/v1/search?tags=comment,story_${id}&hitsPerPage=1000`);
    for (const h of page?.hits ?? []) {
      if (String(h.parent_id) !== String(h.story_id)) continue; // replies are not job posts
      if (Date.parse(h.created_at) < since) continue;
      const c = parsePost(h.comment_text ?? "", h.objectID);
      if (c && !out.has(c.domain)) out.set(c.domain, c);
    }
  }
  await log("info", "discover_collected", { detail: { threads: ids.length, candidates: out.size } });
  return [...out.values()];
}

type Verdict = { fit?: boolean; name?: string; segment?: string; reason?: string };

/** One small model call: is this a B2B software company that could buy from the seller? */
async function qualify(c: Candidate): Promise<Verdict | null> {
  const site = await fetchSite(c.domain);
  if (!site) return { fit: false, reason: "Website did not load" };
  try {
    const raw = await askClaude({
      feature: "discover",
      maxTokens: 220,
      system: "You screen companies for a B2B sales team. Return a single JSON object and nothing else.",
      user: `Seller: ${icp.seller.name}, ${icp.seller.pitch}
Target: ${icp.company.industries.join(", ")}; ${icp.company.employeesMin}-${icp.company.employeesMax} employees.

Company: ${c.name} (${c.domain})
Job post: ${c.snippet}
Website title: ${site.title.slice(0, 120)}
Website description: ${site.description.slice(0, 250)}
Website text: ${site.text.slice(0, 600)}

Is this a company that SELLS B2B software, developer tools or infrastructure to other businesses, with a sales team that could use the seller's product? Say false for consumer apps, agencies, consultancies, staffing, universities, non-profits, hardware, big public companies or anything unclear.
JSON: {"fit": true|false, "name": "proper company name", "segment": "2-4 word description, e.g. API monitoring platform", "reason": "one short plain-English sentence"}`,
    });
    return parseJson<Verdict>(raw);
  } catch (e) {
    await log("warn", "discover_qualify_failed", { account: c.domain, message: (e as Error).message });
    return null; // try again next week
  }
}

export async function runDiscovery(opts: { dry?: boolean; firmo?: boolean } = {}) {
  const found = await collectHiring();
  const domains = found.map((c) => c.domain);
  const [{ data: have }, { data: seen }] = await Promise.all([
    sb.from("cp_accounts").select("domain").in("domain", domains.length ? domains : ["-"]),
    sb.from("cp_discovered").select("domain").in("domain", domains.length ? domains : ["-"]),
  ]);
  const known = new Set([...(have ?? []), ...(seen ?? [])].map((r) => r.domain));
  const fresh = found.filter((c) => !known.has(c.domain)).slice(0, cfg.maxCandidates);
  const summary = { collected: found.length, already_known: found.length - fresh.length, checked: 0, added: [] as string[], rejected: 0, dry: !!opts.dry };
  if (opts.dry) return { ...summary, would_check: fresh.slice(0, cfg.maxAiPerRun).map((c) => `${c.name} (${c.domain})`) };

  let firmoLeft = opts.firmo === false ? 0 : cfg.firmoPerRun;
  for (const c of fresh.slice(0, cfg.maxAiPerRun)) {
    const v = await qualify(c);
    if (!v) continue; // a failure is not a verdict; it is retried next week
    summary.checked++;
    const row = { domain: c.domain, name: (v.name || c.name).slice(0, 80), source: c.source, source_url: c.sourceUrl, snippet: c.snippet };
    if (!v.fit) {
      await sb.from("cp_discovered").upsert({ ...row, status: "rejected", reason: (v.reason ?? "Not a B2B software company").slice(0, 200) }, { onConflict: "domain" });
      summary.rejected++;
      continue;
    }
    // Company facts (0.2 Hunter credit) screen out companies clearly outside the target size or stage.
    let firmo = null;
    if (firmoLeft > 0) {
      firmoLeft--;
      firmo = await fetchFirmo(c.domain);
      if (firmo) {
        const f = fitBreakdown({ employees: firmo.employees, stage: firmo.stage, country: firmo.country, firmo_at: "now" });
        if (f.known && (f.size === 0 || f.stage === 0)) {
          await sb.from("cp_discovered").upsert({ ...row, status: "rejected", reason: `Outside target size or stage (${firmo.employees ?? "?"} people, ${firmo.stage ?? "unknown stage"})` }, { onConflict: "domain" });
          summary.rejected++;
          continue;
        }
      }
    }
    const { data: acct, error } = await sb.from("cp_accounts")
      .insert({ domain: c.domain, name: row.name, segment: (v.segment ?? "").slice(0, 80) || null, source: "discovered", status: "new" })
      .select("id").single();
    if (error || !acct) {
      await log("warn", "discover_insert_failed", { account: c.domain, message: error?.message });
      continue;
    }
    if (firmo) await saveFirmo(acct.id, firmo);
    await sb.from("cp_discovered").upsert({ ...row, status: "added", reason: (v.reason ?? "Hiring sales roles").slice(0, 200), account_id: acct.id }, { onConflict: "domain" });
    summary.added.push(row.name);
  }
  await log("info", "discover_done", { detail: summary });
  return summary;
}
