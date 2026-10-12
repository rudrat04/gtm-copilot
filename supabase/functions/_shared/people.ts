import { sb } from "./db.ts";
import { log } from "./log.ts";
import icp from "./icp.json" with { type: "json" };
import { guardPeople } from "./guard.ts";
import { hashStr, recordIfWatched } from "./movements.ts";

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
// Spelled-out titles and their short forms are the same title: "Vice President of Sales" = "VP Sales", "Chief Revenue Officer" = "CRO".
const SHORT: [RegExp, string][] = [
  [/\bvice presidents?\b/g, "vp"], [/\bchief revenue officer\b/g, "cro"], [/\bchief executive officer\b/g, "ceo"],
  [/\bchief operating officer\b/g, "coo"], [/\bchief marketing officer\b/g, "cmo"], [/\bco founders?\b/g, "cofounder"],
];
export const norm = (s: string) => {
  let t = s.toLowerCase().replace(/[,&/|\-]/g, " ");
  for (const [re, to] of SHORT) t = t.replace(re, to);
  return t.replace(/\b(of|the|and|for)\b/g, " ").replace(/\s+/g, " ").trim();
};

/** The loose "other senior sales titles" fallbacks only make sense while one of the owner's personas is a sales or revenue buyer. */
const salesBuyer = () => icp.personas.some((p) => p.match.some((m) => /sales|revenue|revops|cro/i.test(m)));

type PersonaRule = { title: string; match: string[]; weight: number; onlyBelow?: number | null; department?: string; seniority?: string[] };
const SENIORITY_GROUP: Record<string, string> = { c_suite: "founder_c", vp: "vp", head: "head_director", director: "head_director", manager: "manager", ic: "ic" };

/** Does this buyer type's department and seniority choice (if any) allow this person? An unknown department never rules someone out. */
function allowed(p: PersonaRule, seniority: string, department?: string | null): boolean {
  if (p.seniority?.length && !p.seniority.includes(SENIORITY_GROUP[seniority] ?? "ic")) return false;
  if (p.department && department) {
    const want = p.department.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2), have = department.toLowerCase();
    if (!want.some((w) => have.includes(w.slice(0, 5)))) return false;
  }
  return true;
}

export function rank(title: string, employees?: number | null, department?: string | null): { persona: string | null; relevance: number; seniority: string } {
  const t = norm(title);
  const seniority = seniorityOf(title);
  // The best-weighted persona whose words appear in the title (and whose department and seniority fit) wins.
  const matched = (icp.personas as PersonaRule[]).filter((p) => p.match.some((m) => t.includes(norm(m))) && allowed(p, seniority, department)).sort((a, b) => b.weight - a.weight)[0];
  let relevance = 0;
  if (matched) {
    relevance = matched.weight;
    // A persona limited to small companies (a founder, say) counts for less at a bigger one, where someone else should be found first.
    if (matched.onlyBelow && employees != null && employees >= matched.onlyBelow) relevance = Math.min(relevance, 50);
  } else if (salesBuyer() && seniority !== "ic" && /sales|revenue|growth|business development|partnerships/.test(t)) {
    relevance = 60;
  } else if (salesBuyer() && /sales|revenue|account executive|sdr|bdr/.test(t)) {
    relevance = 25;
  }
  // Within a persona, more senior wins.
  const bonus = { c_suite: 4, vp: 3, head: 3, director: 2, manager: 1, ic: 0 }[seniority] ?? 0;
  return { persona: matched?.title ?? null, relevance: relevance ? relevance + bonus : 0, seniority };
}

/** Recomputes persona and relevance for every stored person after the persona list changes. No credits. */
export async function rerankPeople(): Promise<number> {
  const { data } = await sb.from("cp_people").select("id,title,account_id,department");
  const { data: accts } = await sb.from("cp_accounts").select("id,employees");
  const size = new Map((accts ?? []).map((a) => [a.id, a.employees as number | null]));
  for (const p of data ?? []) {
    const r = rank(p.title ?? "", size.get(p.account_id), p.department);
    await sb.from("cp_people").update({ persona: r.persona, relevance: r.relevance, seniority: r.seniority }).eq("id", p.id);
  }
  return data?.length ?? 0;
}

// ---- Hunter adapter ----

// Abbreviations in the job-title words, written out the way people put them on a profile (Hunter matches common equivalents).
const TITLE_FORMS: Record<string, string[]> = {
  cro: ["Chief Revenue Officer"], ceo: ["Chief Executive Officer", "CEO"], coo: ["Chief Operating Officer"], cmo: ["Chief Marketing Officer"],
  revops: ["Revenue Operations", "RevOps"], "vp sales": ["VP of Sales", "VP Sales", "Vice President of Sales"], "vp revenue": ["VP of Revenue", "Vice President of Revenue"],
  "sales ops": ["Sales Operations"], "co-founder": ["Co-Founder"],
};

/** The job titles to ask Hunter for, from the owner's buyer types (best-weighted first), at most 14 so the request stays short. Pure. */
export function personaTitles(personas: { match: string[]; weight: number }[] = icp.personas): string[] {
  const out: string[] = [];
  const add = (t: string) => { if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t); };
  for (const p of [...personas].sort((a, b) => b.weight - a.weight)) {
    for (const word of p.match) {
      const key = word.toLowerCase().trim();
      const forms = TITLE_FORMS[key] ?? [key.replace(/\b\w/g, (c) => c.toUpperCase())];
      forms.forEach(add);
    }
  }
  return out.slice(0, 14);
}

export const HUNTER_MONTHLY_CAP = Number(Deno.env.get("HUNTER_MONTHLY_CAP") ?? 40); // free plan has 50

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

    // 1) Ask for the owner's buyer-type titles, so the 10 results the free plan allows are the right 10. A search with no results costs nothing.
    // 2) If that finds fewer than 3 people, add the broader department search (it can cost one more credit).
    const titles = personaTitles();
    const first = titles.length ? await domainSearch(domain, key, `&job_titles=${encodeURIComponent(titles.join(","))}`) : null;
    const merged = new Map<string, Record<string, unknown>>();
    for (const e of first?.emails ?? []) merged.set(String(e.value), e);
    let credits = first?.credits ?? 0;
    if (!first || merged.size < 3) {
      const used2 = await monthlyUsed();
      if (used2 + credits < HUNTER_MONTHLY_CAP) {
        const second = await domainSearch(domain, key, "&department=executive,sales,management,operations");
        credits += second.credits;
        for (const e of second.emails) if (!merged.has(String(e.value))) merged.set(String(e.value), e);
      }
    }
    // deno-lint-ignore no-explicit-any -- JSON payloads from external APIs
    const emails = [...merged.values()] as Record<string, any>[];

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

export async function monthlyUsed(): Promise<number> {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  const { data } = await sb.from("cp_provider_usage").select("credits").eq("provider", "hunter").gte("created_at", since.toISOString());
  return (data ?? []).reduce((a, r) => a + Number(r.credits), 0);
}

/** One Hunter domain search. A search that returns people costs 1 credit, one that finds nothing costs 0. */
async function domainSearch(domain: string, key: string, filter: string): Promise<{ emails: Record<string, unknown>[]; credits: number }> {
  const started = Date.now();
  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&type=personal${filter}&limit=10`;
  const res = await fetch(url, { headers: { "X-API-KEY": key }, signal: AbortSignal.timeout(20000) });
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
  const emails = (body.data?.emails ?? []) as Record<string, unknown>[];
  const credits = emails.length ? 1 : 0;
  await sb.from("cp_provider_usage").insert({ provider: "hunter", action: "domain_search", credits, account: domain });
  await log("info", "provider_search", {
    account: domain,
    detail: { provider: "hunter", filter: filter.startsWith("&job_titles") ? "job_titles" : "department", results: emails.length, credits, indexed_total: body.meta?.results },
    ms: Date.now() - started,
  });
  return { emails, credits };
}

/** The active provider. Swap this one line (or read an env var) to change data sources. */
export function provider(): PeopleProvider {
  return hunter;
}

export async function hunterBalance(): Promise<{ remaining: number; available: number } | null> {
  const key = Deno.env.get("HUNTER_API_KEY");
  if (!key) return null;
  try {
    const r = await fetch("https://api.hunter.io/v2/account", { headers: { "X-API-KEY": key }, signal: AbortSignal.timeout(8000) });
    const c = (await r.json()).data?.requests?.credits;
    return c ? { remaining: Number(c.remaining), available: Number(c.available) } : null;
  } catch {
    return null;
  }
}


/** Searches the active provider for an account and stores what it finds. Returns how many people were stored. */
export async function searchAndStore(account: { id: string; domain: string }, opts: { auto?: boolean } = {}): Promise<{ stored: number; credits: number }> {
  const found = await provider().search(account.domain);
  await sb.from("cp_accounts").update({ people_searched_at: new Date().toISOString(), people_search_source: opts.auto ? "auto" : "manual" }).eq("id", account.id); // remembered even when nobody was found
  const { data: acc } = await sb.from("cp_accounts").select("employees").eq("id", account.id).maybeSingle();
  const rows = found.people.map((p) => {
    const r = rank(p.title, acc?.employees, p.department);
    return {
      account_id: account.id,
      provider: provider().name,
      first_name: p.firstName,
      last_name: p.lastName,
      title: p.title,
      seniority: r.seniority,
      department: p.department ?? null,
      persona: r.persona,
      relevance: r.relevance,
      linkedin_url: p.linkedinUrl ?? null,
      email: p.email?.toLowerCase() ?? null,
      email_status: p.emailStatus ?? null,
      email_confidence: p.emailConfidence ?? null,
    };
  });
  if (rows.length) {
    const { error } = await sb.from("cp_people").upsert(rows, { onConflict: "account_id,email", ignoreDuplicates: true });
    if (error) await log("error", "people_store_failed", { account: account.domain, message: error.message });
    await guardPeople({ accountId: account.id }); // opted out, bounced or already in HubSpot? (read-only, never throws)
    await recordIfWatched(account.id, { key: `people:${account.id}:${hashStr(rows.map((r) => r.email).join(","))}`, kind: "people", importance: "small", title: `${rows.length} people found: ${rows.slice(0, 2).map((r) => `${r.first_name} ${r.last_name} (${r.title})`).join(", ")}` }).catch(() => {});
  }
  return { stored: rows.length, credits: found.credits };
}
