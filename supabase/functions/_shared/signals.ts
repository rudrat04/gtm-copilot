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
type Job = { title: string; url: string; source: string; desc?: string };

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
        jobs.push({ title: j.text, url: j.hostedUrl, source: "lever", desc: String(j.descriptionPlain ?? "").slice(0, 4000) });
      }
    }
    if (ab.res) {
      for (const j of (await ab.res.json()).jobs ?? []) {
        jobs.push({ title: j.title, url: j.jobUrl, source: "ashby", desc: String(j.descriptionPlain ?? "").slice(0, 4000) });
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

// ---- What the sales job posts say about the company ----

// Tool names. Ones that are also everyday words (close, outreach, segment, dynamics) only count in a specific form.
const TOOLS: [string, RegExp][] = [
  ["salesforce", /\bsalesforce\b/i], ["hubspot", /\bhubspot\b/i], ["outreach", /\boutreach\.io\b|\boutreach (platform|sequences)\b/i], ["salesloft", /\bsalesloft\b/i],
  ["gong", /\bgong\b/i], ["apollo", /\bapollo\.io\b|\bapollo (platform|crm)\b/i], ["zoominfo", /\bzoominfo\b/i], ["clay", /\bclay\.com\b|\bclay (workflows?|tables?)\b/i],
  ["pipedrive", /\bpipedrive\b/i], ["attio", /\battio\b/i], ["clari", /\bclari\b/i], ["groove", /\bgroove\.co\b|\bgroove (crm|platform)\b/i],
  ["sales navigator", /\bsales navigator\b/i], ["6sense", /\b6sense\b/i], ["close", /\bclose\.com\b|\bclose crm\b/i], ["dynamics", /\bmicrosoft dynamics\b|\bdynamics 365\b/i],
  ["zoho", /\bzoho\b/i], ["intercom", /\bintercom\b/i], ["segment", /\bsegment\.(com|io)\b|\btwilio segment\b/i], ["marketo", /\bmarketo\b/i], ["pardot", /\bpardot\b/i], ["netsuite", /\bnetsuite\b/i],
];
const PAINS = ["forecasting", "pipeline", "crm", "revops", "sales process", "attribution", "data quality", "outbound", "playbook", "enablement", "territory"];
const hasWord = (text: string, w: string) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);

export type JobInsights = { leader: boolean; founding: boolean; tools: string[]; pains: string[] };

/** Reads the sales and revenue roles for seniority, "founding" roles, and the tools and problems the posts mention. Pure. */
export function jobInsights(matched: Job[]): JobInsights {
  const leader = matched.some((j) => /\b(head of|vp|vice president|chief|director)\b/i.test(j.title));
  const founding = matched.some((j) => /\b(founding|first|1st)\b/i.test(j.title) || /\bfirst (sales|sdr|ae|account executive|revenue)\b|\bbuild (out )?(our|the) (sales|revenue) (team|function|motion)|\bfounding (ae|sdr|sales)/i.test(j.desc ?? ""));
  const text = matched.map((j) => `${j.title} ${j.desc ?? ""}`).join(" \n ");
  return { leader, founding, tools: TOOLS.filter(([, re]) => re.test(text)).map(([name]) => name).slice(0, 8), pains: ((icp.signals as { painWords?: string[] }).painWords ?? PAINS).filter((p) => hasWord(text, p)).slice(0, 6) };
}

// ---- Sales-led or self-serve, from the company's own homepage ----

const SALES_CTA = /\b((book|request|schedule|get)( a| your)?( live| personal| free)? demo|talk to (our )?sales|contact (our )?sales|speak (to|with) (our )?sales)\b/i;
const SELF_CTA = /\b((start|try)( it| for)? free|get started (for )?free|sign up (for )?free|free trial|create (a |your )?free account|start (building|now) (for )?free|no credit card)\b/i;

/** Which way the homepage invites you in: a demo or sales call, a free start, or both. Null when it says neither. */
export function salesMotion(html: string): "sales_led" | "self_serve" | "both" | null {
  const text = htmlToText(html).slice(0, 60_000);
  const sales = SALES_CTA.test(text), self = SELF_CTA.test(text);
  return sales && self ? "both" : sales ? "sales_led" : self ? "self_serve" : null;
}

/** `unknown` means a job board could not be reached, so the open-role COUNT cannot be trusted this time and is not written. */
export type Hiring = { signals: Signal[]; verified: boolean; sample: string[]; unknown: boolean };

/** Stores the sales style seen on the homepage and the tools named in job posts (added to what Hunter told us). */
export async function saveSiteFacts(accountId: string, f: { motion: string | null; jobTools: string[] }) {
  const upd: Record<string, unknown> = {};
  if (f.motion) upd.sales_motion = f.motion;
  if (f.jobTools.length) {
    const { data } = await sb.from("cp_accounts").select("tech").eq("id", accountId).maybeSingle();
    const merged = [...new Set([...(data?.tech ?? []), ...f.jobTools.map((t) => t.toLowerCase())])].slice(0, 80);
    if (merged.length !== (data?.tech ?? []).length) upd.tech = merged;
  }
  if (Object.keys(upd).length) await sb.from("cp_accounts").update(upd).eq("id", accountId);
}

/** Tools named in the sales job posts, from the stored summary, so the Tools fit criterion has data without a paid lookup. */
export function toolsFromHiring(signals: Signal[]): string[] {
  const t = signals.find((s) => s.kind === "hiring" && s.detail && "salesOpenings" in s.detail)?.detail?.tools;
  return Array.isArray(t) ? t.map(String) : [];
}

/** Pure: turns the jobs we read into signals. If any board errored, the individual roles are kept but the count is left out. */
export function buildHiring(all: Job[], errored: boolean, discovered: boolean, re: RegExp): Hiring {
  if (!all.length) return { signals: [], verified: true, sample: [], unknown: errored };
  const matched = all.filter((j) => re.test(j.title));
  const seen = new Set<string>();
  const sales = matched.filter((j) => !seen.has(j.title) && seen.add(j.title)).slice(0, 8);
  const out: Signal[] = sales.map((j) => ({ kind: "hiring", title: `Hiring: ${j.title}`, url: j.url, detail: { source: j.source } }));
  if (!errored) {
    out.push({ kind: "hiring", title: `${all.length} open roles, ${matched.length} in sales/RevOps`, detail: { totalOpenings: all.length, salesOpenings: matched.length, ...jobInsights(matched) } });
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
  const q = encodeURIComponent(`"${name}" (SaaS OR startup OR software OR funding OR launch OR hiring) when:60d`);
  const res = await get(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`);
  if (!res) return [];
  return newsItems(await res.text(), name, segment).map((it) => ({ kind: "news" as const, title: it.title, url: it.url, detail: { published: it.published } })).slice(0, 5);
}

/** Any dated Google News results for a query (free). The caller decides what counts, so this only drops undated items and data pages. */
export async function newsRaw(query: string, days = 30): Promise<{ title: string; url?: string; published: string }[]> {
  const res = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${days}d`)}&hl=en-US&gl=US&ceid=US:en`);
  if (!res) return [];
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({
    title: (/<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").trim(),
    url: /<link>([\s\S]*?)<\/link>/.exec(m[1])?.[1],
    published: /<pubDate>([\s\S]*?)<\/pubDate>/.exec(m[1])?.[1] ?? "",
  })).filter((s) => s.title && s.published && !isListing(s.title));
}

export const EVENT_WORDS = /\b(webinar|conference|summit|keynote|meetup|roadshow|workshop|expo|hosts?|hosting|hosted|launch event|annual event|user conference|event)\b/i;
/** Pure: does this headline say the company is hosting, sponsoring or speaking at an event, and is it about that company? */
export function isEventHeadline(title: string, name: string): boolean {
  return title.toLowerCase().includes(name.toLowerCase()) && EVENT_WORDS.test(title);
}

/** News about a company hosting or joining an event (webinar, conference, summit). Free. Used for followed companies. */
export async function eventSignals(name: string, domain: string): Promise<Signal[]> {
  const items = await newsRaw(`"${name}" (webinar OR conference OR summit OR keynote OR "launch event" OR meetup OR hosts OR hosting)`, 30);
  return items.filter((i) => isEventHeadline(i.title, name)).slice(0, 2).map((i) => ({ kind: "news" as const, title: i.title, url: i.url, detail: { published: i.published, newsType: "event", source: "events", domain } }));
}

/** Dated news items from a Google News feed that are about this company: the name is in the title and the title is on topic. */
function newsItems(xml: string, name: string, segment: string): { title: string; url?: string; published: string }[] {
  const segWords = segment.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
  const needle = name.toLowerCase();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({
    title: (/<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").trim(),
    url: /<link>([\s\S]*?)<\/link>/.exec(m[1])?.[1],
    published: /<pubDate>([\s\S]*?)<\/pubDate>/.exec(m[1])?.[1] ?? "",
  })).filter((s) => {
    const t = s.title.toLowerCase();
    return t.includes(needle) && (TECH_CONTEXT.test(t) || segWords.some((w) => t.includes(w))) && !NOISE.test(t) && !isListing(s.title) && !!s.published;
  });
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

// ---- Signals the owner added in Setup (tools, competitors, press, changes, watch phrases) ----

type Rule = { id: string; type: string; words: string[]; on: boolean };
const normTool = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Does a company's tool list contain this tool? Equal, or the same product with a suffix ("salesforce" matches "salesforce-crm"). Pure. */
export function usesTool(tech: string[], word: string): boolean {
  const w = normTool(word);
  return !!w && tech.some((t) => { const n = normTool(t); return n === w || (w.length >= 4 && n.startsWith(w)); });
}

/** Tool and competitor rules read the stored tool list; press, change and watch rules search news about the company (free, dated, same namesake guard as news). */
export async function ruleSignals(name: string, domain: string, segment: string, rules: Rule[]): Promise<Signal[]> {
  const on = rules.filter((r) => r.on && r.words.length);
  if (!on.length) return [];
  const out: Signal[] = [];
  const techRules = on.filter((r) => r.type === "tool" || r.type === "competitor");
  if (techRules.length) {
    const { data } = await sb.from("cp_accounts").select("tech").eq("domain", domain).maybeSingle();
    const tech = (data?.tech ?? []) as string[];
    for (const r of techRules) for (const w of r.words) {
      if (usesTool(tech, w)) out.push({ kind: "tech", title: r.type === "competitor" ? `Uses a competitor: ${w}` : `Uses ${w}`, detail: { rule: r.id, ruleType: r.type } });
    }
  }
  const newsRules = on.filter((r) => r.type === "press" || r.type === "change" || r.type === "watch").slice(0, 4);
  const found = await Promise.all(newsRules.map(async (r) => {
    const q = encodeURIComponent(`"${name}" (${r.words.slice(0, 8).map((w) => `"${w}"`).join(" OR ")}) when:90d`);
    const res = await get(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`);
    return res ? { r, items: newsItems(await res.text(), name, segment) } : { r, items: [] };
  }));
  for (const { r, items } of found) for (const it of items.filter((x) => r.words.some((w) => x.title.toLowerCase().includes(w.toLowerCase()))).slice(0, 2)) { // the headline itself must contain one of the words (Google also returns loose matches)
    out.push({ kind: "news", title: it.title, url: it.url, detail: { published: it.published, newsType: "rule", rule: r.id, ruleType: r.type } });
  }
  return out;
}

// ---- Tools seen on a company's own website, and when they change ----

const SITE_TOOLS: [string, RegExp][] = [
  ["hubspot", /js\.hs-scripts\.com|hs-analytics\.net|js\.hsforms\.net|hubspot\.com\/hs-fs/i], ["pardot", /pi\.pardot\.com|pardot\.com/i], ["marketo", /munchkin\.marketo|marketo\.net|marketo\.com\/js/i],
  ["salesforce", /force\.com\/|salesforce\.com\/(embed|servlet)|exacttarget/i], ["intercom", /widget\.intercom\.io|intercomcdn\.com/i], ["drift", /js\.driftt\.com|drift\.com\/include/i],
  ["zendesk", /static\.zdassets\.com|zopim\.com/i], ["segment", /cdn\.segment\.(com|io)/i], ["mixpanel", /cdn\.mxpnl\.com|mixpanel\.com\/libs/i], ["amplitude", /cdn\.amplitude\.com/i],
  ["posthog", /posthog\.com|us\.i\.posthog|app\.posthog/i], ["hotjar", /static\.hotjar\.com/i], ["fullstory", /fullstory\.com\/s\/fs\.js|edge\.fullstory/i], ["heap", /cdn\.heapanalytics\.com/i],
  ["gong", /gong\.io\/|gong\.app/i], ["6sense", /6sc\.co|6sense\.com/i], ["clearbit", /clearbit\.com\/|tag\.clearbitscripts\.com/i], ["zoominfo", /ws\.zoominfo\.com|zoominfo\.com\/|zi-scripts/i],
  ["apollo", /assets\.apollo\.io|apollo\.io\/(js|tracking)/i], ["outreach", /outreach\.io\/(js|track)/i], ["salesloft", /salesloft\.com\/(js|track)|sl-?tracker/i], ["chili piper", /chilipiper\.com/i],
  ["calendly", /assets\.calendly\.com|calendly\.com\/(assets|embed)/i], ["qualified", /js\.qualified\.com|qualified\.com\/js/i], ["commonroom", /commonroom\.io|cdn\.cr-relay/i], ["optimizely", /cdn\.optimizely\.com/i],
  ["stripe", /js\.stripe\.com/i], ["webflow", /webflow\.com|assets\.website-files/i], ["wordpress", /wp-content\/|wp-includes\//i], ["g2", /\bg2\.com\/(.*)(track|badge)|g2crowd\.com/i], ["rb2b", /rb2b\.com/i], ["warmly", /warmly\.ai/i],
];
/** Pure: the known tools a page's HTML loads. */
export const siteTools = (html: string): string[] => SITE_TOOLS.filter(([, re]) => re.test(html)).map(([n]) => n);

/** Pure: what changed between two tool lists. */
export function toolDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const b = new Set(before), a = new Set(after);
  return { added: after.filter((t) => !b.has(t)), removed: before.filter((t) => !a.has(t)) };
}

/** Remembers the tools on the website and returns a signal for each one added or dropped since the last look. The first look only records. */
async function siteToolChanges(domain: string, html: string): Promise<Signal[]> {
  if (!html) return [];
  const now = siteTools(html);
  const { data: row } = await sb.from("cp_accounts").select("id,site_tools").eq("domain", domain).maybeSingle();
  if (!row) return [];
  await sb.from("cp_accounts").update({ site_tools: now, site_tools_at: new Date().toISOString() }).eq("id", row.id);
  if (!row.site_tools) return [];
  const { added, removed } = toolDiff(row.site_tools, now);
  return [
    ...added.slice(0, 3).map((t) => ({ kind: "tech" as const, title: `Added ${t} (seen on their website)`, detail: { ruleType: "change", change: "added", tool: t, published: new Date().toISOString() } })),
    ...removed.slice(0, 3).map((t) => ({ kind: "tech" as const, title: `No longer uses ${t} (seen on their website)`, detail: { ruleType: "change", change: "removed", tool: t, published: new Date().toISOString() } })),
  ];
}

/** Pure: how the number of open sales roles has moved. Reads the stored "N open roles" rows, newest first or not. */
export function hiringTrend(rows: { detail?: Record<string, unknown> | null; detected_at: string }[], now = Date.now()): { now: number; before: number | null; days: number | null } | null {
  const pts = rows.filter((r) => r.detail && "salesOpenings" in r.detail).map((r) => ({ n: Number(r.detail!.salesOpenings), t: Date.parse(r.detected_at) })).filter((p) => !Number.isNaN(p.t)).sort((a, b) => b.t - a.t);
  if (!pts.length) return null;
  const old = pts.find((p) => now - p.t >= 21 * 86_400_000 && now - p.t <= 60 * 86_400_000);
  return { now: pts[0].n, before: old ? old.n : null, days: old ? Math.round((now - old.t) / 86_400_000) : null };
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
  const have = new Set(signals.map((s) => s.title));
  for (const s of await ruleSignals(name, domain, segment, ((icp.signals as { rules?: Rule[] }).rules ?? [])).catch(() => [])) if (!have.has(s.title)) signals.push(s);
  const hiringUnknown = hiring.unknown && rel.jobsOk; // a board could not be reached: callers fall back on the stored open-role count

  // A company we discovered because it posted sales roles on Hacker News keeps that as a hiring signal while the post is recent.
  const { data: found } = await sb.from("cp_discovered").select("snippet,source_url,found_at").eq("domain", domain).eq("status", "added").maybeSingle();
  if (found && Date.now() - Date.parse(found.found_at) < icp.discovery.maxAgeDays * 86_400_000) {
    const roles = rolesFromSnippet(found.snippet ?? "");
    // Only a post that actually names a sales or go-to-market role counts as a hiring signal; engineering or content roles do not.
    if (roles) signals.push({ kind: "hiring", title: `Hiring: ${roles} (Hacker News Who is hiring)`, url: found.source_url ?? undefined, detail: { source: "hn_hiring", published: found.found_at } });
  }
  // Tool changes on their website, and the problems their job posts mention (your pain words).
  for (const s of await siteToolChanges(domain, site?.html ?? "").catch(() => [] as Signal[])) if (!have.has(s.title)) signals.push(s);
  const pains = (hiring.signals.find((s) => s.kind === "hiring" && s.detail && "salesOpenings" in s.detail)?.detail?.pains ?? []) as string[];
  if (pains.length && rel.jobsOk) signals.push({ kind: "tech", title: `Job posts mention: ${pains.slice(0, 4).join(", ")}`, detail: { ruleType: "pain", rule: "pain" } });
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
  return { site, signals, hiringUnknown, motion: site?.html ? salesMotion(site.html) : null, jobTools: rel.jobsOk ? toolsFromHiring(hiring.signals) : [] };
}
