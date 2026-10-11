import icp from "./icp.json" with { type: "json" };

export type Signal = {
  kind: "hiring" | "news" | "hn" | "tech" | "site";
  title: string;
  url?: string;
  detail?: Record<string, unknown>;
};

import { keepRelevant } from "./relevance.ts";
import { log } from "./log.ts";
import { sb } from "./db.ts";

const UA = "Mozilla/5.0 (compatible; AccountCopilot/0.1; +https://github.com/rudrat04/gtm-copilot)";

async function get(url: string, ms = 7000): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "*/*" },
      signal: AbortSignal.timeout(ms),
      redirect: "follow",
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      await log("warn", "fetch_failed", { detail: { host: new URL(url).host, status: res.status } });
    }
    return res.ok ? res : null;
  } catch (e) {
    await log("warn", "fetch_failed", {
      detail: { host: new URL(url).host, error: (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message.slice(0, 120) },
    });
    return null;
  }
}

type Fetched = { res: Response | null; state: "ok" | "missing" | "error" };

/**
 * Like get(), but says WHY there is no answer: "missing" (404, the company has no such board) or "error" (timeout, network
 * or server trouble, so we simply do not know). One quiet retry first, because job-board APIs time out now and then.
 */
async function getChecked(url: string, ms = 7000): Promise<Fetched> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(attempt ? ms + 5000 : ms), redirect: "follow" });
      if (res.ok) return { res, state: "ok" };
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return { res: null, state: "missing" }; // 404, 410, 403: there is no public board here
    } catch (e) {
      if (attempt) {
        await log("warn", "fetch_failed", { detail: { host: new URL(url).host, error: (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message.slice(0, 120), retried: true } });
        return { res: null, state: "error" };
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return { res: null, state: "error" };
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&#39;|&quot;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type SiteInfo = { title: string; description: string; text: string; html: string };

export async function fetchSite(domain: string): Promise<SiteInfo | null> {
  const res = await get(`https://${domain}`);
  if (!res) return null;
  const html = (await res.text()).slice(0, 400_000);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const description =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ??
      /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(html)?.[1] ?? "";
  return { title, description, text: htmlToText(html).slice(0, 3500), html };
}

// Public job-board APIs: Greenhouse, Lever, Ashby. No keys needed.
type Job = { title: string; url: string; source: string };

async function jobsFor(slug: string): Promise<{ jobs: Job[]; errored: boolean }> {
  const [gh, lv, ab] = await Promise.all([
    getChecked(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`),
    getChecked(`https://api.lever.co/v0/postings/${slug}?mode=json`),
    getChecked(`https://api.ashbyhq.com/posting-api/job-board/${slug}`),
  ]);
  const jobs: Job[] = [];
  let errored = [gh, lv, ab].some((f) => f.state === "error"); // a board we could not reach is "unknown", never "no roles"
  try {
    if (gh.res) {
      for (const j of (await gh.res.json()).jobs ?? []) {
        jobs.push({ title: j.title, url: j.absolute_url, source: "greenhouse" });
      }
    }
    if (lv.res) {
      for (const j of (await lv.res.json()) ?? []) {
        jobs.push({ title: j.text, url: j.hostedUrl, source: "lever" });
      }
    }
    if (ab.res) {
      for (const j of (await ab.res.json()).jobs ?? []) {
        jobs.push({ title: j.title, url: j.jobUrl, source: "ashby" });
      }
    }
  } catch (e) {
    errored = true;
    await log("warn", "job_board_parse_failed", { detail: { slug, error: (e as Error).message.slice(0, 120) } });
  }
  return { jobs, errored };
}

function roleRegex(): RegExp {
  const alts = icp.signals.hiringRoles.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${alts.join("|")})\\b`, "i");
}

const BOARD_LINK =
  /(?:jobs\.ashbyhq\.com|boards\.greenhouse\.io|job-boards\.greenhouse\.io|jobs\.lever\.co|apply\.workable\.com)\/([a-z0-9_-]+)/gi;

async function discoverSlugs(domain: string, homeHtml: string): Promise<string[]> {
  const found = new Set<string>();
  const scan = (html: string) => {
    for (const m of html.matchAll(BOARD_LINK)) found.add(m[1].toLowerCase());
  };
  scan(homeHtml);
  const careers = await Promise.all(
    ["careers", "jobs", "company/careers"].map((p) => get(`https://${domain}/${p}`, 5000)),
  );
  for (const r of careers) if (r) scan((await r.text()).slice(0, 400_000));
  found.delete("embed");
  return [...found];
}

/** `unknown` means a job board could not be reached, so the open-role COUNT cannot be trusted this time and is not written. */
export type Hiring = { signals: Signal[]; verified: boolean; sample: string[]; unknown: boolean };

/** Pure: turns the jobs we read into signals. If any board errored, the individual roles are kept but the count is left out. */
export function buildHiring(all: Job[], errored: boolean, discovered: boolean, re: RegExp): Hiring {
  if (!all.length) return { signals: [], verified: true, sample: [], unknown: errored };
  const matched = all.filter((j) => re.test(j.title));
  const seen = new Set<string>();
  const sales = matched.filter((j) => !seen.has(j.title) && seen.add(j.title)).slice(0, 8);
  const out: Signal[] = sales.map((j) => ({ kind: "hiring", title: `Hiring: ${j.title}`, url: j.url, detail: { source: j.source } }));
  if (!errored) {
    out.push({ kind: "hiring", title: `${all.length} open roles, ${matched.length} in sales/RevOps`, detail: { totalOpenings: all.length, salesOpenings: matched.length } });
  }
  const sample = [...new Set(all.map((j) => j.title))].slice(0, 10);
  return { signals: out, verified: discovered, sample, unknown: errored };
}

export async function hiringSignals(name: string, domain: string, homeHtml = ""): Promise<Hiring> {
  const label = domain.split(".")[0];
  const discovered = await discoverSlugs(domain, homeHtml);
  const slugs = [...new Set([...discovered, label, name.toLowerCase().replace(/[^a-z0-9]/g, "")])];
  const results = await Promise.all(slugs.map(jobsFor));
  return buildHiring(results.flatMap((r) => r.jobs), results.some((r) => r.errored), discovered.length > 0, roleRegex());
}

/** The hiring signals stored earlier, used for scoring when a board could not be reached today. */
export async function storedHiringSignals(accountId: string): Promise<Signal[]> {
  const { data } = await sb.from("cp_signals").select("kind,title,url,detail,detected_at").eq("account_id", accountId).eq("kind", "hiring").order("detected_at", { ascending: false }).limit(12);
  const rows = (data ?? []).map((s) => ({ kind: "hiring" as const, title: s.title, url: s.url ?? undefined, detail: { ...(s.detail ?? {}), detected_at: s.detected_at } }));
  const summary = rows.find((r) => r.detail && "salesOpenings" in r.detail); // only the newest count
  return rows.filter((r) => !(r.detail && "salesOpenings" in r.detail) || r === summary);
}

/** Role words from a Hacker News job post, so a signal reads "Hiring: Account Executive, GTM", never a URL or a city. */
const ROLE_LABEL: Record<string, string> = {
  "account executive": "Account Executive", "account executives": "Account Executive", sdr: "SDR", sdrs: "SDR", bdr: "BDR", bdrs: "BDR",
  gtm: "GTM", "go-to-market": "GTM", "go to market": "GTM", revops: "RevOps", "revenue operations": "Revenue Operations",
};
export function rolesFromSnippet(snippet: string): string {
  const re = /\b(account executives?|sdrs?|bdrs?|sales development|business development|head of sales|vp of sales|vp sales|sales (?:director|manager|engineer|ops|operations)|revenue operations|revops|gtm|go[- ]to[- ]market|sales)\b/gi;
  const out: string[] = [];
  for (const m of snippet.replace(/https?:\/\/\S+/g, " ").matchAll(re)) {
    const w = m[1].toLowerCase();
    const label = ROLE_LABEL[w] ?? w.charAt(0).toUpperCase() + w.slice(1);
    if (!out.includes(label)) out.push(label);
  }
  return out.slice(0, 3).join(", ");
}

// Generic company names ("Linear", "Default") attract unrelated finance/media headlines.
const NOISE = /nasdaq|nyse|streaming|programming|channel|stock|shares|earnings|ticker/i;

const TECH_CONTEXT =
  /\b(saas|software|platform|startup|start-up|raises?|raised|funding|series [a-d]|seed|valuation|acquires?|acquired|ai|cloud|data|developers?|api|launch(es|ed)?|customers?|revenue|arr|hiring|ceo|founder|product|app)\b/i;

// Data sites and directories publish "pages about" a company (revenue estimates, funding lists, profiles), not news about it.
const LISTING_SOURCES =
  /\s-\s(tracxn|getlatka|latka|crunchbase|pitchbook|cb ?insights|zoominfo|owler|growjo|craft(\.co)?|g2|capterra|trustpilot|glassdoor|indeed|wikipedia|linkedin|stockanalysis|macrotrends|marketscreener|similarweb|comparably|rocketreach|apollo(\.io)?|dun & bradstreet|dnb|sacra|dealroom|cbinsights|tech\.eu directory|startupranking|failory|seedtable|wellfound|angel\.co|builtwith|stackshare|slintel|6sense|lusha|cognism|leadiq|signalhire|ensun|globaldata|statista|ibisworld|yahoo finance|google finance|investing\.com|seekingalpha)\b[^-]*$/i;
const LISTING_TITLE =
  /(list of investors|funding rounds?\s*(&|and)|\brevenue\s+(20\d\d|and growth|&)|est\.?\s*(arr|valuation|revenue)|estimated (arr|revenue|valuation)|company profile|\bcompany overview\b|\balternatives?( to)?\b|competitors?\s*(&|and)\s*alternatives|(pricing|features),?\s*(&|and)?\s*reviews?|\breviews?,?\s*(pricing|features)|\bvs\.?\s)/i;

/** True for pages ABOUT a company (directories, estimates, comparisons) rather than news. Pure, so it can be tested. */
export function isListing(title: string): boolean {
  return LISTING_SOURCES.test(title) || LISTING_TITLE.test(title);
}

export async function newsSignals(name: string, segment = ""): Promise<Signal[]> {
  const segWords = segment.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
  const q = encodeURIComponent(`"${name}" (SaaS OR startup OR software OR funding OR launch OR hiring) when:60d`);
  const res = await get(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`);
  if (!res) return [];
  const xml = await res.text();
  const needle = name.toLowerCase();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  return items.map((m) => {
    const title = /<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1] ?? "";
    const link = /<link>([\s\S]*?)<\/link>/.exec(m[1])?.[1];
    const date = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(m[1])?.[1];
    return {
      kind: "news" as const,
      title: title.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").trim(),
      url: link,
      detail: { published: date },
    };
  }).filter((s) => {
    const t = s.title.toLowerCase();
    const onTopic = TECH_CONTEXT.test(t) || segWords.some((w) => t.includes(w));
    return t.includes(needle) && onTopic && !NOISE.test(t) && !isListing(s.title) && !!s.detail.published; // a dated article about the company, not a directory page
  }).slice(0, 5);
}

export async function hnSignals(name: string, domain: string): Promise<Signal[]> {
  const since = Math.floor(Date.now() / 1000) - 90 * 86400;
  const res = await get(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(domain)}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=3`,
  );
  if (!res) return [];
  try {
    const hits = ((await res.json()).hits ?? []).filter(
      (h: { title?: string; url?: string }) =>
        (h.url ?? "").toLowerCase().includes(domain) ||
        new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(h.title ?? ""),
    );
    return hits.map((h: { title: string; objectID: string; points: number; created_at?: string }) => ({
      kind: "hn" as const,
      title: `Hacker News: ${h.title}`,
      url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      detail: { points: h.points, created: h.created_at },
    }));
  } catch {
    return [];
  }
}

export async function collectSignals(name: string, domain: string, segment = "") {
  const site = await fetchSite(domain);
  const [hiring, news, hn] = await Promise.all([
    hiringSignals(name, domain, site?.html ?? ""),
    newsSignals(name, segment),
    hnSignals(name, domain),
  ]);

  // Boards found via the company's own site are trusted; guessed boards must pass the check.
  const checkJobs = hiring.signals.length > 0 && !hiring.verified;
  const rel = await keepRelevant(
    name,
    domain,
    segment,
    [...news, ...hn],
    checkJobs ? hiring.sample : null,
  );

  const signals: Signal[] = [...(rel.jobsOk ? hiring.signals : []), ...rel.headlines];
  const hiringUnknown = hiring.unknown && rel.jobsOk; // a board could not be reached: callers fall back on the stored open-role count

  // A company we discovered because it posted sales roles on Hacker News keeps that as a hiring signal while the post is recent.
  const { data: found } = await sb.from("cp_discovered").select("snippet,source_url,found_at").eq("domain", domain).eq("status", "added").maybeSingle();
  if (found && Date.now() - Date.parse(found.found_at) < icp.discovery.maxAgeDays * 86_400_000) {
    const roles = rolesFromSnippet(found.snippet ?? "");
    // Only a post that actually names a sales or go-to-market role counts as a hiring signal; engineering or content roles do not.
    if (roles) signals.push({ kind: "hiring", title: `Hiring: ${roles} (Hacker News Who is hiring)`, url: found.source_url ?? undefined, detail: { source: "hn_hiring", published: found.found_at } });
  }
  await log("info", "signals_collected", {
    account: domain,
    detail: {
      site: !!site,
      hiring: hiring.signals.length,
      hiring_verified: hiring.verified,
      hiring_dropped: !rel.jobsOk && hiring.signals.length > 0,
      hiring_unknown: hiringUnknown,
      news_found: news.length,
      hn_found: hn.length,
      headlines_kept: rel.headlines.length,
      total: signals.length,
    },
  });
  if (!site) await log("warn", "site_unreachable", { account: domain });
  return { site, signals, hiringUnknown };
}
