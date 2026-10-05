import { sb } from "./db.ts";
import { log } from "./log.ts";
import icp from "./icp.json" with { type: "json" };

/** A person as returned by any provider, before ranking. */
export type FoundPerson = {
  firstName: string;
  lastName: string;
  title: string;
  department?: string;
  email?: string;
  emailStatus?: string | null;
  emailConfidence?: number | null;
  linkedinUrl?: string | null;
};

/**
 * Every data source implements this. The UI and the HubSpot push only talk to
 * `findPeople`, so adding Apollo later means adding one adapter, not changing the app.
 */
export interface PeopleProvider {
  name: string;
  /** Returns people and the credits the call cost. */
  search(domain: string): Promise<{ people: FoundPerson[]; credits: number }>;
}

// ---- Ranking: our own rules, because providers label seniority inconsistently ----

const SENIORITY: [string, RegExp][] = [
  ["c_suite", /\b(ceo|cro|coo|cto|cfo|chief|founder|co-founder|president|owner)\b/i],
  ["vp", /\b(vp|vice president)\b/i],
  ["head", /\bhead of\b/i],
  ["director", /\bdirector\b/i],
  ["manager", /\bmanager|lead\b/i],
];

export function seniorityOf(title: string): string {
  return SENIORITY.find(([, re]) => re.test(title))?.[0] ?? "ic";
}

// "VP of Sales", "VP, Sales" and "vp sales" must all be the same title.
const norm = (s: string) =>
  s.toLowerCase().replace(/[,&/|\-]/g, " ").replace(/\b(of|the|and|for)\b/g, " ").replace(/\s+/g, " ").trim();

export function rank(title: string): { persona: string | null; relevance: number; seniority: string } {
  const t = norm(title);
  const seniority = seniorityOf(title);
  const matched = icp.personas.find((p) => p.match.some((m) => t.includes(norm(m))));
  let relevance = 0;
  if (matched) {
    // Sales and RevOps leaders are the buyers; founders only count when they are the buyer.
    relevance = /sales|revenue|revops|cro/.test(matched.match.join(" ")) ? 100 : 70;
    if (matched.title.startsWith("Head of RevOps")) relevance = 95;
  } else if (seniority !== "ic" && /sales|revenue|growth|business development|partnerships/.test(t)) {
    relevance = 60;
  } else if (/sales|revenue|account executive|sdr|bdr/.test(t)) {
    relevance = 25;
  }
  // Within a persona, more senior wins.
  const bonus = { c_suite: 4, vp: 3, head: 3, director: 2, manager: 1, ic: 0 }[seniority] ?? 0;
  return { persona: matched?.title ?? null, relevance: relevance ? relevance + bonus : 0, seniority };
}

// ---- Hunter adapter ----

const HUNTER_MONTHLY_CAP = Number(Deno.env.get("HUNTER_MONTHLY_CAP") ?? 40); // free plan has 50

export const hunter: PeopleProvider = {
  name: "hunter",
  async search(domain) {
    const key = Deno.env.get("HUNTER_API_KEY");
    if (!key) throw new Error("HUNTER_API_KEY is not set");

    const since = new Date();
    since.setUTCDate(1);
    since.setUTCHours(0, 0, 0, 0);
    const { data } = await sb.from("cp_provider_usage").select("credits").eq("provider", "hunter")
      .gte("created_at", since.toISOString());
    const used = (data ?? []).reduce((a, r) => a + Number(r.credits), 0);
    if (used >= HUNTER_MONTHLY_CAP) {
      await log("warn", "provider_cap_reached", { account: domain, detail: { provider: "hunter", used, cap: HUNTER_MONTHLY_CAP } });
      throw new Error("Monthly people-search limit reached");
    }

    const started = Date.now();
    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}` +
      `&type=personal&department=executive,sales,management,operations&limit=10&api_key=${key}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      await log("error", "provider_request_failed", {
        account: domain,
        message: `Hunter ${res.status}`,
        detail: { provider: "hunter", status: res.status, errors: JSON.stringify(body.errors ?? body).slice(0, 300) },
        ms: Date.now() - started,
      });
      throw new Error(`Hunter ${res.status}`);
    }

    const emails = (body.data?.emails ?? []) as Record<string, any>[];
    // Hunter charges 1 credit for a domain search that returns results, 0 when nothing is found.
    const credits = emails.length ? 1 : 0;
    await sb.from("cp_provider_usage").insert({ provider: "hunter", action: "domain_search", credits, account: domain });
    await log("info", "provider_search", {
      account: domain,
      detail: { provider: "hunter", results: emails.length, credits, indexed_total: body.meta?.results },
      ms: Date.now() - started,
    });

    return {
      credits,
      people: emails.filter((e) => e.first_name && e.position).map((e) => ({
        firstName: e.first_name,
        lastName: e.last_name ?? "",
        title: e.position,
        department: e.department ?? undefined,
        email: e.value,
        emailStatus: e.verification?.status ?? null,
        emailConfidence: e.confidence ?? null,
        linkedinUrl: e.linkedin ?? null,
      })),
    };
  },
};

/** The active provider. Swap this one line (or read an env var) to change data sources. */
export function provider(): PeopleProvider {
  return hunter;
}

export async function hunterBalance(): Promise<{ remaining: number; available: number } | null> {
  const key = Deno.env.get("HUNTER_API_KEY");
  if (!key) return null;
  try {
    const r = await fetch(`https://api.hunter.io/v2/account?api_key=${key}`, { signal: AbortSignal.timeout(8000) });
    const c = (await r.json()).data?.requests?.credits;
    return c ? { remaining: Number(c.remaining), available: Number(c.available) } : null;
  } catch {
    return null;
  }
}
