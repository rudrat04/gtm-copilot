import icp from "./icp.json" with { type: "json" };

export type Signal = {
  kind: "hiring" | "news" | "hn" | "tech" | "site";
  title: string;
  url?: string;
  detail?: Record<string, unknown>;
};

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

export type SiteInfo = { title: string; description: string; text: string };

export async function fetchSite(domain: string): Promise<SiteInfo | null> {
  const res = await get(`https://${domain}`);
  if (!res) return null;
  const html = (await res.text()).slice(0, 400_000);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const description =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ??
      /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(html)?.[1] ?? "";
  return { title, description, text: htmlToText(html).slice(0, 3500) };
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

export async function hiringSignals(name: string, domain: string): Promise<Signal[]> {
  const label = domain.split(".")[0];
  const slugs = [...new Set([label, name.toLowerCase().replace(/[^a-z0-9]/g, "")])];
  const all = (await Promise.all(slugs.map(jobsFor))).flat();
  if (!all.length) return [];
  const re = roleRegex();
  const sales = all.filter((j) => re.test(j.title)).slice(0, 8);
  const out: Signal[] = sales.map((j) => ({
    kind: "hiring",
    title: `Hiring: ${j.title}`,
    url: j.url,
    detail: { source: j.source },
  }));
  out.push({
    kind: "hiring",
    title: `${all.length} open roles, ${sales.length} in sales/RevOps`,
    detail: { totalOpenings: all.length, salesOpenings: sales.length },
  });
  return out;
}

export async function newsSignals(name: string): Promise<Signal[]> {
  const q = encodeURIComponent(`"${name}" when:30d`);
  const res = await get(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`);
  if (!res) return [];
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5);
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
  }).filter((s) => s.title);
}

export async function hnSignals(domain: string): Promise<Signal[]> {
  const since = Math.floor(Date.now() / 1000) - 90 * 86400;
  const res = await get(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(domain)}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=3`,
  );
  if (!res) return [];
  try {
    const hits = (await res.json()).hits ?? [];
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

export async function collectSignals(name: string, domain: string) {
  const [site, hiring, news, hn] = await Promise.all([
    fetchSite(domain),
    hiringSignals(name, domain),
    newsSignals(name),
    hnSignals(domain),
  ]);
  return { site, signals: [...hiring, ...news, ...hn] as Signal[] };
}
