import icp from "./icp.json" with { type: "json" };

export type Signal = {
  kind: "hiring" | "news" | "hn" | "tech" | "site";
  title: string;
  url?: string;
  detail?: Record<string, unknown>;
};

import { keepRelevant } from "./relevance.ts";

const UA = "Mozilla/5.0 (compatible; AccountCopilot/0.1; +https://github.com/rudrat04/gtm-copilot)";

async function get(url: string, ms = 7000): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "*/*" },
      signal: AbortSignal.timeout(ms),
      redirect: "follow",
    });
    return res.ok ? res : null;
  } catch {
    return null;
  }
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

async function jobsFor(slug: string): Promise<Job[]> {
  const [gh, lv, ab] = await Promise.all([
    get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`),
    get(`https://api.lever.co/v0/postings/${slug}?mode=json`),
    get(`https://api.ashbyhq.com/posting-api/job-board/${slug}`),
  ]);
  const jobs: Job[] = [];
  try {
    if (gh) {
      for (const j of (await gh.json()).jobs ?? []) {
        jobs.push({ title: j.title, url: j.absolute_url, source: "greenhouse" });
      }
    }
    if (lv) {
      for (const j of (await lv.json()) ?? []) {
        jobs.push({ title: j.text, url: j.hostedUrl, source: "lever" });
      }
    }
    if (ab) {
      for (const j of (await ab.json()).jobs ?? []) {
        jobs.push({ title: j.title, url: j.jobUrl, source: "ashby" });
      }
    }
  } catch { /* a malformed board is the same as no board */ }
  return jobs;
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

export type Hiring = { signals: Signal[]; verified: boolean; sample: string[] };

export async function hiringSignals(name: string, domain: string, homeHtml = ""): Promise<Hiring> {
  const label = domain.split(".")[0];
  const discovered = await discoverSlugs(domain, homeHtml);
  const slugs = [...new Set([...discovered, label, name.toLowerCase().replace(/[^a-z0-9]/g, "")])];
  const all = (await Promise.all(slugs.map(jobsFor))).flat();
  if (!all.length) return { signals: [], verified: true, sample: [] };
  const re = roleRegex();
  const matched = all.filter((j) => re.test(j.title));
  const seen = new Set<string>();
  const sales = matched.filter((j) => !seen.has(j.title) && seen.add(j.title)).slice(0, 8);
  const out: Signal[] = sales.map((j) => ({
    kind: "hiring",
    title: `Hiring: ${j.title}`,
    url: j.url,
    detail: { source: j.source },
  }));
  out.push({
    kind: "hiring",
    title: `${all.length} open roles, ${matched.length} in sales/RevOps`,
    detail: { totalOpenings: all.length, salesOpenings: matched.length },
  });
  const sample = [...new Set(all.map((j) => j.title))].slice(0, 10);
  return { signals: out, verified: discovered.length > 0, sample };
}

// Generic company names ("Linear", "Default") attract unrelated finance/media headlines.
const NOISE = /nasdaq|nyse|streaming|programming|channel|stock|shares|earnings|ticker/i;

const TECH_CONTEXT =
  /\b(saas|software|platform|startup|start-up|raises?|raised|funding|series [a-d]|seed|valuation|acquires?|acquired|ai|cloud|data|developers?|api|launch(es|ed)?|customers?|revenue|arr|hiring|ceo|founder|product|app)\b/i;

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
    return t.includes(needle) && onTopic && !NOISE.test(t);
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
    return hits.map((h: { title: string; objectID: string; points: number }) => ({
      kind: "hn" as const,
      title: `Hacker News: ${h.title}`,
      url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      detail: { points: h.points },
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
  return { site, signals };
}
