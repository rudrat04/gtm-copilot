import { normalizeDomain, sb } from "./db.ts";
import { log } from "./log.ts";
import { notify } from "./notify.ts";
import { askClaude, parseJson } from "./claude.ts";
import { fetchSite } from "./signals.ts";
import { fetchFirmo, fitBreakdown, inRegions, saveFirmo } from "./firmo.ts";
import { meetsFit } from "./fitgate.ts";
import { fitState } from "./score.ts";
import { collectWeb } from "./websearch.ts";
import { collectHunter } from "./hunterdiscover.ts";
import { collectYc } from "./yc.ts";
import { peekPeople } from "./peoplepreview.ts";
import { aiRefresh } from "./aiscore.ts";
import { scanOne } from "./scan.ts";
import { industryFromSite } from "./industry.ts";
import { FIT_COLS } from "./firmo.ts";
import icp from "./icp.json" with { type: "json" };

// Finds new companies for the pipeline from public sources, so reps do not have to hunt for them.
// Source today: the monthly Hacker News "Who is hiring" thread, which lists companies that are hiring right now.
// Companies hiring sales or RevOps roles are the strongest signal for the seller, so only those posts are kept.

/** Pure: a plain-language category for why a company was skipped. */
export function skipCategory(reason: string): string {
  if (/^Outside your places/i.test(reason)) return "Outside your places";
  if (/^Below the fit bar/i.test(reason)) return "Outside your size or stage";
  if (/did not load/i.test(reason)) return "Website did not load";
  if (/(agency|consult|staffing|systems integrator|service provider|services firm|custom software for clients|builds software for clients|reseller)/i.test(reason)) return "Services or agency";
  if (/(consumer|B2C|personal learning)/i.test(reason)) return "Consumer product";
  if (/(hardware|manufactur|materials|insurance|brokerage|exchange|marketplace|non-?profit|universit|research-stage|biotech|robot)/i.test(reason)) return "Not a software company";
  return "Not a fit for what you sell";
}

export type Candidate = { name: string; domain: string; source: string; sourceUrl: string; snippet: string; band?: string; size?: number; country?: string | null; city?: string | null };

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
  const since = Date.now() - ((cfg as { postAgeDays?: number }).postAgeDays ?? cfg.maxAgeDays) * 86_400_000; // a company is worth finding long after its post; the hiring signal itself still fades after maxAgeDays
  const out = new Map<string, Candidate>();
  for (const id of ids) {
    const page = await getJson(`https://hn.algolia.com/api/v1/search?tags=comment,story_${id}&hitsPerPage=1000`);
    for (const h of page?.hits ?? []) {
      if (String(h.parent_id) !== String(h.story_id)) continue; // replies are not job posts
      if (Date.parse(h.created_at) < since) continue; // older posts are likely filled
      const c = parsePost(h.comment_text ?? "", h.objectID);
      if (c && !out.has(c.domain)) out.set(c.domain, c);
    }
  }
  await log("info", "discover_collected", { detail: { threads: ids.length, candidates: out.size } });
  return [...out.values()];
}

/** Pure: a "Launch HN" title to a company name, or null. "Launch HN: Acme (YC S24) – CRM that fixes itself" gives "Acme". */
export function launchName(title: string): string | null {
  const m = /^Launch HN:\s*([^(–—:|-]{2,60}?)\s*(\(|–|—|:|\||-|$)/i.exec(title.trim());
  return m ? m[1].trim() : null;
}

/** Startups that launched on Hacker News ("Launch HN") in the last few months: another place to find B2B companies, free. */
export async function collectLaunches(): Promise<Candidate[]> {
  if ((cfg as { launchHn?: boolean }).launchHn === false) return [];
  const since = Math.floor((Date.now() - 120 * 86_400_000) / 1000);
  const page = await getJson(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent('"Launch HN"')}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=100`);
  const out = new Map<string, Candidate>();
  for (const h of page?.hits ?? []) {
    const name = launchName(String(h.title ?? ""));
    if (!name || !h.url) continue;
    let host = "";
    try { host = new URL(h.url).hostname.replace(/^www\./, "").toLowerCase(); } catch { continue; }
    if (NOT_COMPANY.test(host) || !normalizeDomain(host) || out.has(host)) continue;
    out.set(host, { name, domain: host, source: "launch_hn", sourceUrl: `https://news.ycombinator.com/item?id=${h.objectID}`, snippet: String(h.title).slice(0, 220) });
  }
  await log("info", "discover_launches", { detail: { candidates: out.size } });
  return [...out.values()];
}

type Verdict = { fit?: boolean; name?: string; segment?: string; reason?: string };

/** One small model call: is this a B2B software company that could buy from the seller? */
/** If the owner chose service industries (marketing, advertising, consulting, staffing and so on) as targets, agencies are customers, not noise. */
const wantsServices = () => icp.company.industries.some((i: string) => /(services|consult|agenc|marketing|advertising|staffing|outsourc|public relations|design)/i.test(i));

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
Places: ${icp.company.regions.map((r: string) => r.replace(/^city:/, "")).join(", ")}

Company: ${c.name} (${c.domain})
${c.source === "launch_hn" ? "Launch post" : c.source === "web" ? "Found on the web" : c.source === "hunter" ? "Matches the seller's filters in a company database" : c.source === "yc" ? "Y Combinator company that is hiring" : "Job post"}: ${c.snippet}
Website title: ${site.title.slice(0, 120)}
Website description: ${site.description.slice(0, 250)}
Website text: ${site.text.slice(0, 600)}

${wantsServices() ? "Does this company operate in one of the Target industries and have a sales or growth need the seller could serve? Companies in the Target industries are a fit even when they are agencies, consultancies or service firms. Say false for consumer apps, universities, non-profits, government, hardware, big public companies, companies clearly outside the Target industries, or anything unclear." : "Is this a company that SELLS B2B software, developer tools or infrastructure to other businesses, with a sales team that could use the seller's product? Say false for consumer apps, agencies, consultancies, staffing, universities, non-profits, hardware, big public companies or anything unclear."}
Also say false if the company is clearly based and operating only outside the Places above, or clearly belongs to a different industry than the Target (when unsure, say true).
JSON: {"fit": true|false, "name": "proper company name", "segment": "2-4 word description, e.g. API monitoring platform", "reason": "one short plain-English sentence"}`,
    });
    return parseJson<Verdict>(raw);
  } catch (e) {
    await log("warn", "discover_qualify_failed", { account: c.domain, message: (e as Error).message });
    return null; // try again next week
  }
}

/** The companies just added get their public signals read, an industry from their website, an AI judgement, and the people who work there are listed for free (names shortened, no emails), so the rep finds people ready to look at. */
async function readyTheNew(ids: string[]) {
  const { data: fresh } = ids.length ? await sb.from("cp_accounts").select("id,name,domain,status,segment,employees,stage,country,firmo_at,light_source,employee_band,tech,industry,tags,blurb,sales_motion,known_as,last_round_date,industry_ai").in("id", ids) : { data: [] };
  for (let i = 0; i < (fresh ?? []).length; i += 4) await Promise.allSettled((fresh ?? []).slice(i, i + 4).map((a) => scanOne(a as never))); // so a new company arrives with signals and a score
  for (let i = 0; i < ids.length; i += 4) await Promise.allSettled(ids.slice(i, i + 4).map((id) => industryFromSite(id))); // the industry from their website, about 0.1 cent each, no credit
  const { data: fit } = ids.length ? await sb.from("cp_accounts").select(`id,name,domain,watched_at,priority_score,${FIT_COLS}`).in("id", ids) : { data: [] };
  const worth = (fit ?? []).filter((a) => fitState(a as never) !== "outside").map((a) => ({ id: a.id, name: a.name as string, domain: a.domain as string }));
  const peek = worth.length ? await peekPeople(worth).catch(() => ({ stored: 0, companies: 0, withPeople: 0 })) : { stored: 0, companies: 0, withPeople: 0 };
  const ai = ids.length ? await aiRefresh({ ids: ids.slice(0, 12), maxCompanies: 12, maxPeopleCompanies: 6 }).catch(() => ({ companies: 0, people: 0 })) : { companies: 0, people: 0 };
  return { searched: peek.stored, judged: ai.companies };
}

/** Pure: which candidates get checked this run. Each source keeps a few places, so a busy Hacker News week cannot crowd out the others. */
export function pickBatch<T extends { source: string }>(fresh: T[], max: number, reserve: Record<string, number>): T[] {
  const chosen = new Set<T>();
  for (const [source, n] of Object.entries(reserve)) for (const c of fresh.filter((x) => x.source === source).slice(0, n)) if (chosen.size < max) chosen.add(c);
  for (const c of fresh) if (chosen.size < max) chosen.add(c);
  return fresh.filter((c) => chosen.has(c)); // keeps the original order (strongest signal first)
}

/** Pure: cuts a reason at the end of a word (never mid-word) and adds an ellipsis only when something was cut. */
export const tidy = (t: string, n: number): string => { const x = t.replace(/\s+/g, " ").trim(); if (x.length <= n) return x; const cut = x.slice(0, n); const sp = cut.lastIndexOf(" "); return `${cut.slice(0, sp > n * 0.6 ? sp : n).replace(/[,;:.\s]+$/, "")}…`; };

export async function runDiscovery(opts: { dry?: boolean; firmo?: boolean; web?: boolean; maxAi?: number } = {}) {
  const hiring = await collectHiring();
  const seenDomains = new Set(hiring.map((c) => c.domain));
  const launches = (await collectLaunches()).filter((c) => !seenDomains.has(c.domain));
  const useWeb = (opts.web ?? !opts.dry) && (cfg as { web?: boolean }).web !== false; // a dry run stays free unless asked
  const web = useWeb ? (await collectWeb()).filter((c) => !seenDomains.has(c.domain) && !launches.some((l) => l.domain === c.domain)) : [];
  const hunter = (await collectHunter()).filter((c) => !seenDomains.has(c.domain)); // free (no credits), so a dry run uses it too
  const yc = (await collectYc()).filter((c) => !seenDomains.has(c.domain) && !hunter.some((h) => h.domain === c.domain));
  const found: Candidate[] = [...hiring, ...hunter, ...yc, ...web, ...launches].filter((c, i, all) => all.findIndex((x) => x.domain === c.domain) === i); // hiring posts first (the strongest signal), then the company database, YC, the web search, launches
  const domains = found.map((c) => c.domain);
  const [{ data: have }, { data: seen }] = await Promise.all([
    sb.from("cp_accounts").select("domain").in("domain", domains.length ? domains : ["-"]),
    sb.from("cp_discovered").select("domain,status,reason,found_at").in("domain", domains.length ? domains : ["-"]),
  ]);
  // A company turned down only for its size or stage gets another look after two weeks, in case you have widened the profile since.
  const retry = (r: { status: string; reason: string | null; found_at: string }) => r.status === "rejected" && ((wantsServices() && skipCategory(r.reason ?? "") === "Services or agency") || (/^Below the fit bar/.test(r.reason ?? "") && Date.now() - Date.parse(r.found_at) > 14 * 86_400_000) || (/^Outside your places \(([A-Za-z]{2})\)/.test(r.reason ?? "") && inRegions(/^Outside your places \(([A-Za-z]{2})\)/.exec(r.reason ?? "")![1].toUpperCase()))); // a company skipped for its place is looked at again as soon as that place is one of yours
  const known = new Set([...(have ?? []), ...(seen ?? []).filter((r) => !retry(r))].map((r) => r.domain));
  const fresh = found.filter((c) => !known.has(c.domain)); // all of them; pickBatch decides which get checked
  const addedIds: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const slots = { hunter: 12, web: 6, yc: 5, ...((cfg as { slots?: Record<string, number> }).slots ?? {}) };
  const summary = { collected: found.length, from_web: web.length, from_hunter: hunter.length, from_yc: yc.length, already_known: found.length - fresh.length, checked: 0, added: [] as string[], rejected: 0, dry: !!opts.dry };
  if (opts.dry) return { ...summary, would_check: pickBatch(fresh, opts.maxAi ?? cfg.maxAiPerRun, slots).map((c) => `${c.name} (${c.domain})`) };

  let firmoLeft = opts.firmo === false ? 0 : cfg.firmoPerRun;
  const batch = pickBatch(fresh, opts.maxAi ?? cfg.maxAiPerRun, slots);
  const verdicts = new Map<string, Verdict | null>();
  for (let i = 0; i < batch.length; i += 4) await Promise.all(batch.slice(i, i + 4).map(async (c) => { verdicts.set(c.domain, await qualify(c)); })); // four at a time keeps a bigger run inside the time limit
  for (const c of batch) {
    const v = verdicts.get(c.domain) ?? null;
    if (!v) continue; // a failure is not a verdict; it is retried next week
    summary.checked++;
    const row = { domain: c.domain, name: (v.name || c.name).slice(0, 80), source: c.source, source_url: c.sourceUrl, snippet: c.snippet };
    if (!v.fit) {
      { const reason = tidy(v.reason ?? "Not a B2B software company", 220); await sb.from("cp_discovered").upsert({ ...row, status: "rejected", reason, category: skipCategory(reason) }, { onConflict: "domain" }); }
      summary.rejected++;
      skipped.push({ name: row.name, reason: tidy(v.reason ?? "Not a B2B software company", 140) });
      continue;
    }
    // Company facts (0.2 Hunter credit) screen out companies clearly outside the target size or stage.
    let firmo = null;
    const light = !!(c.band || c.size); // the company search already gave its size: no paid lookup for that
    if (firmoLeft > 0 && !light) {
      firmoLeft--;
      firmo = await fetchFirmo(c.domain);
      if (firmo) {
        const f = fitBreakdown({ employees: firmo.employees, stage: firmo.stage, country: firmo.country, firmo_at: "now" });
        if (f.known && !meetsFit(fitState({ employees: firmo.employees, stage: firmo.stage, country: firmo.country, firmo_at: "now" }))) {
          const why = f.placeMiss ? `Outside your places (${firmo.country})` : `Below the fit bar (${firmo.employees ?? "?"} people, ${firmo.stage ?? "unknown stage"})`;
          await sb.from("cp_discovered").upsert({ ...row, status: "rejected", reason: why, category: skipCategory(why) }, { onConflict: "domain" });
          summary.rejected++;
          skipped.push({ name: row.name, reason: why });
          continue;
        }
      }
    }
    const { data: acct, error } = await sb.from("cp_accounts")
      .insert({ domain: c.domain, name: row.name, segment: (v.segment ?? "").slice(0, 80) || null, source: "discovered", status: "new", ...(light ? { light_source: c.source, employee_band: c.band ?? null, employees: c.size ?? null, country: c.country ?? null, hq_city: c.city ?? null } : {}) })
      .select("id").single();
    if (error || !acct) {
      await log("warn", "discover_insert_failed", { account: c.domain, message: error?.message });
      continue;
    }
    if (firmo) await saveFirmo(acct.id, firmo);
    await sb.from("cp_discovered").upsert({ ...row, status: "added", reason: tidy(v.reason ?? "Hiring sales roles", 220), account_id: acct.id }, { onConflict: "domain" });
    summary.added.push(row.name);
    addedIds.push(acct.id);
  }
  const save = (ready: { searched: number; judged: number }) => summary.checked > 0 ? sb.from("cp_state").upsert({ key: "discovery_last", value: JSON.stringify({ at: new Date().toISOString(), collected: summary.collected, from_web: summary.from_web, already_known: summary.already_known, checked: summary.checked, added: summary.added.slice(0, 20), skipped: skipped.slice(0, 20), skipped_n: summary.rejected, people_searched: ready.searched, judged: ready.judged, facts_checked: (opts.firmo === false ? 0 : cfg.firmoPerRun) - firmoLeft }), updated_at: new Date().toISOString() }) : Promise.resolve(); // an empty run keeps the last real report
  await save({ searched: 0, judged: 0 }); // saved first, in case the slower steps below run out of time
  const ready = await readyTheNew(addedIds.slice(0, 12)).catch(() => ({ searched: 0, judged: 0 }));
  Object.assign(summary, { people_searched: ready.searched, judged: ready.judged, skipped: skipped.slice(0, 20) });
  await save(ready);
  if (summary.checked > 0) await notify({ key: `discovery:${new Date().toISOString().slice(0, 13)}`, kind: "discovery", title: `Discovery: ${summary.added.length} companies added, ${summary.rejected} skipped`, body: summary.added.slice(0, 6).join(", "), route: "#/discover" });
  await log("info", "discover_done", { detail: summary });
  return summary;
}
