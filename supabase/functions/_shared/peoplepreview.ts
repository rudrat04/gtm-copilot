import { normalizeDomain, sb } from "./db.ts";
import { log } from "./log.ts";
import { guardPeople } from "./guard.ts";
import { updateContact } from "./hubspot.ts";
import { suppressedSet, suppressKey, addNote } from "./personnotes.ts";
import { HUNTER_MONTHLY_CAP, monthlyUsed, peopleFilter, rank } from "./people.ts";
import { FIT_COLS } from "./firmo.ts";
import { worthShowing } from "./fitgate.ts";
import icp from "./icp.json" with { type: "json" };

// People first. Hunter's Multi-Domain Search lists the people at many companies in one free call: a shortened name, title, department,
// level, whether the person is a decision maker and whether the email is verified, but not the email. The rep sees who is there before
// spending anything, and reveals the ones worth it (1 credit each). It is a Beta endpoint at Hunter.

const BASE = "https://api.hunter.io/v2/multi-domain-search";
const PER_ACCOUNT = 5;
const period = () => new Date().toISOString().slice(0, 7);

export type PreviewRow = { reveal_handle?: string; name?: string | null; position?: string | null; department?: string | null; seniority?: string | null; decision_maker?: boolean; domain?: string; company_name?: string; verification?: { status?: string | null } };

/** Pure: the query string for one search, from company names and the buyer types (their departments and levels, as in the domain search). */
export function peekQuery(names: string[], personas: { department?: string; seniority?: string[] }[], search_after?: string): string {
  const p = new URLSearchParams();
  p.set("company_name", names.map((n) => n.replace(/[,]/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean).join(","));
  for (const part of peopleFilter(personas).split("&").filter(Boolean)) { const [k, v] = part.split("="); p.set(k, v); }
  p.set("type", "personal");
  p.set("limit", "100");
  if (search_after) p.set("search_after", search_after);
  return p.toString();
}

/** Pure: "Vineet K." into first name and last initial. */
export function splitShort(name: string): { first: string; last: string } | null {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2 || !parts[0]) return null;
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/** Pure: the rows worth keeping for each company: the ones that match a buyer type, best first, a few per company. */
export function pickPeople(rows: PreviewRow[], domains: Set<string>, employeesOf: (domain: string) => number | null | undefined, per = PER_ACCOUNT) {
  const byDomain = new Map<string, { row: PreviewRow; short: { first: string; last: string }; r: ReturnType<typeof rank> }[]>();
  for (const row of rows) {
    const domain = normalizeDomain(row.domain ?? "");
    const short = row.name ? splitShort(row.name) : null;
    if (!domain || !domains.has(domain) || !short || !row.position || !row.reveal_handle) continue;
    const r = rank(row.position, employeesOf(domain), row.department);
    if (r.relevance < 50) continue; // only people who match one of your buyer types
    (byDomain.get(domain) ?? byDomain.set(domain, []).get(domain)!).push({ row, short, r });
  }
  for (const [d, list] of byDomain) byDomain.set(d, list.sort((a, b) => (b.r.relevance - a.r.relevance) || (Number(!!b.row.decision_maker) - Number(!!a.row.decision_maker))).slice(0, per));
  return byDomain;
}

/** Pure: why a person was not kept, in plain words. */
export function whyDropped(title: string, department: string | null | undefined, seniority: string, personas: { title: string; department?: string; seniority?: string[]; match: string[] }[]): { label: string; reason: string } {
  const depts = [...new Set(personas.map((p) => p.department).filter(Boolean) as string[])];
  const dept = (department ?? "").toLowerCase();
  if (dept && depts.length && !depts.some((d) => d.toLowerCase() === dept || dept.includes(d.toLowerCase().slice(0, 5)))) return { label: "Different team", reason: `Works in ${department}; your buyer types are in ${depts.join(", ")}` };
  if (seniority === "ic") return { label: "Too junior", reason: "An individual contributor; your buyer types are leaders and managers" };
  return { label: "Title does not match", reason: `"${title}" has none of the words in your buyer-type titles` };
}

/** Pure: people the free list showed but that are not one of your buyer types, so they are not kept (listed on the Discover page so nothing is hidden silently). */
export function droppedPeople(rows: PreviewRow[], domains: Set<string>, employeesOf: (domain: string) => number | null | undefined) {
  const out: { key: string; company: string; name: string; title: string; department: string | null; level: string; label: string; reason: string }[] = [];
  const personas = icp.personas as { title: string; department?: string; seniority?: string[]; match: string[] }[];
  for (const row of rows) {
    const domain = normalizeDomain(row.domain ?? "");
    if (!domain || !domains.has(domain) || !row.name || !row.position) continue;
    const r = rank(row.position, employeesOf(domain), row.department);
    if (r.relevance < 50) { const w = whyDropped(row.position, row.department, r.seniority, personas); out.push({ key: `${domain}|${row.name}|${row.position}`.slice(0, 160), company: row.company_name ?? domain, name: row.name, title: row.position, department: row.department ?? null, level: r.seniority, ...w }); }
  }
  return out;
}

// deno-lint-ignore no-explicit-any -- Hunter's JSON
async function call(path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, any> }> {
  const key = Deno.env.get("HUNTER_API_KEY");
  if (!key) return { ok: false, status: 0, json: {} };
  const res = await fetch(path, { method: "POST", headers: { "X-API-KEY": key, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
}

/** Free: stores the people (shortened names, no emails) at these companies. Returns how many people were stored. */
export async function peekPeople(accounts: { id: string; name: string; domain: string }[]): Promise<{ stored: number; companies: number; withPeople: number }> {
  const out = { stored: 0, companies: 0, withPeople: 0 };
  const dropped: ReturnType<typeof droppedPeople> = [];
  if (!accounts.length || !Deno.env.get("HUNTER_API_KEY")) return out;
  const idOf = new Map(accounts.map((a) => [a.domain, a.id]));
  const { data: sizes } = await sb.from("cp_accounts").select("domain,employees").in("id", accounts.map((a) => a.id));
  const emp = new Map((sizes ?? []).map((s) => [s.domain, s.employees as number | null]));
  const personas = icp.personas as { department?: string; seniority?: string[] }[];
  for (let i = 0; i < accounts.length; i += 15) {
    const chunk = accounts.slice(i, i + 15);
    const rows: PreviewRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const r = await call(`${BASE}?${peekQuery(chunk.map((a) => a.name), personas, cursor)}`);
      if (!r.ok) { await log("warn", "people_peek_failed", { message: `Hunter ${r.status}`, detail: { status: r.status, errors: JSON.stringify(r.json.errors ?? "").slice(0, 200) } }); break; }
      rows.push(...((r.json.data ?? []) as PreviewRow[]));
      cursor = r.json.meta?.next_search_after;
      if (!cursor || (r.json.data ?? []).length < 100) break;
    }
    dropped.push(...droppedPeople(rows, new Set(chunk.map((a) => a.domain)), (d) => emp.get(d)));
    const picked = pickPeople(rows, new Set(chunk.map((a) => a.domain)), (d) => emp.get(d));
    const ids = chunk.map((a) => a.id);
    // Replace the earlier preview rows, but never one you follow, revealed or pushed.
    await sb.from("cp_people").delete().in("account_id", ids).eq("preview", true).is("watched_at", null).is("hubspot_contact_id", null);
    const { data: have } = await sb.from("cp_people").select("account_id,first_name,last_name,title").in("account_id", ids);
    const seen = new Set((have ?? []).map((p) => `${p.account_id}|${(p.first_name ?? "").toLowerCase()}|${(p.last_name ?? "").charAt(0).toLowerCase()}|${(p.title ?? "").toLowerCase()}`));
    const blocked = await suppressedSet();
    const inserts = [];
    for (const [domain, list] of picked) {
      const account_id = idOf.get(domain)!;
      for (const { row, short, r } of list) {
        if (blocked.has(suppressKey({ first: short.first, last: short.last, domain, title: row.position }))) continue; // never listed again
        if (seen.has(`${account_id}|${short.first.toLowerCase()}|${short.last.charAt(0).toLowerCase()}|${row.position!.toLowerCase()}`)) continue; // already known in full
        inserts.push({ account_id, provider: "hunter_preview", first_name: short.first, last_name: short.last, title: row.position, seniority: r.seniority, department: row.department ?? null, persona: r.persona, relevance: r.relevance, email: null, email_status: row.verification?.status ?? null, preview: true, reveal_handle: row.reveal_handle, handle_period: period(), decision_maker: !!row.decision_maker });
      }
      if (list.length) out.withPeople++;
    }
    if (inserts.length) { const { error } = await sb.from("cp_people").insert(inserts); if (error) await log("warn", "people_peek_store_failed", { message: error.message }); else out.stored += inserts.length; }
    await sb.from("cp_accounts").update({ people_previewed_at: new Date().toISOString() }).in("id", ids);
    out.companies += chunk.length;
  }
  if (dropped.length) await sb.from("cp_state").upsert({ key: "people_skipped", value: JSON.stringify({ at: new Date().toISOString(), items: dropped.slice(0, 60) }), updated_at: new Date().toISOString() });
  await log("info", "people_peek", { detail: out });
  return out;
}

/** 1 credit: shows the full name and email of one previewed person. */
export async function revealPerson(personId: string, retry = true): Promise<{ ok: true; credits: number } | { ok: false; error: string; code?: number }> {
  const { data: p } = await sb.from("cp_people").select("id,account_id,title,reveal_handle,handle_period,preview,hubspot_contact_id").eq("id", personId).maybeSingle();
  if (!p) return { ok: false, error: "Person not found", code: 404 };
  if (!p.preview) return { ok: false, error: "This person is already revealed", code: 409 };
  const { data: acct } = await sb.from("cp_accounts").select("id,name,domain").eq("id", p.account_id).maybeSingle();
  if (!acct) return { ok: false, error: "Company not found", code: 404 };
  if ((await monthlyUsed()) >= HUNTER_MONTHLY_CAP) return { ok: false, error: "Monthly people-search limit reached", code: 429 };
  if (!p.reveal_handle || p.handle_period !== period()) { // the handle belongs to an earlier month: look the company up again for a fresh one
    if (!retry) return { ok: false, error: "That preview expired. Search the company again.", code: 410 };
    await peekPeople([acct]);
    const { data: again } = await sb.from("cp_people").select("id").eq("account_id", acct.id).eq("preview", true).eq("title", p.title).limit(1);
    return again?.[0] ? await revealPerson(again[0].id, false) : { ok: false, error: "That person is no longer listed. Search the company again.", code: 410 };
  }
  const r = await call(`${BASE}/reveal`, { handles: [p.reveal_handle] });
  if (!r.ok) {
    await log("warn", "people_reveal_failed", { account: acct.domain, message: `Hunter ${r.status}`, detail: { errors: JSON.stringify(r.json.errors ?? "").slice(0, 200) } });
    return { ok: false, error: r.status === 429 ? "Not enough credits left at Hunter" : `Hunter said no (${r.status})`, code: 502 };
  }
  const row = (r.json.data ?? [])[0] as { email?: string; first_name?: string; last_name?: string; position?: string; linkedin_url?: string; outcome?: string } | undefined;
  const credits = Number(r.json.meta?.credits_charged ?? 0);
  if (credits) await sb.from("cp_provider_usage").insert({ provider: "hunter", action: "reveal", credits, account: acct.domain });
  if (!row?.email || !["revealed", "already_revealed"].includes(String(row.outcome))) return { ok: false, error: row?.outcome === "not_found" ? "Hunter has no email for this person" : "Could not reveal this person", code: 404 };
  const rk = rank(row.position ?? p.title ?? "", null, null);
  await sb.from("cp_people").update({
    first_name: row.first_name ?? undefined, last_name: row.last_name ?? "", email: row.email.toLowerCase(), linkedin_url: row.linkedin_url ?? null,
    provider: "hunter", preview: false, reveal_handle: null, email_revealed: true, enriched_at: new Date().toISOString(), seniority: rk.seniority,
  }).eq("id", p.id);
  if (p.hubspot_contact_id) await updateContact(p.hubspot_contact_id, { firstname: row.first_name ?? undefined, lastname: row.last_name ?? "", email: row.email.toLowerCase() }, acct.domain).catch(() => false); // a contact added before the reveal is completed in HubSpot
  await guardPeople({ accountId: acct.id });
  await addNote(p.id, "revealed", "Revealed (1 credit)");
  await log("info", "person_revealed", { account: acct.domain, detail: { credits } });
  return { ok: true, credits };
}

/** Companies worth a free look: shown by your fit bar (or followed), still open, nobody stored yet, not looked up in the last week. Best first. */
export async function peekCandidates(limit = 40): Promise<{ id: string; name: string; domain: string }[]> {
  const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data } = await sb.from("cp_accounts").select(`id,priority_score,outreach_status,people_previewed_at,${FIT_COLS}`).is("removed_at", null)
    .or(`people_previewed_at.is.null,people_previewed_at.lt.${week}`).order("priority_score", { ascending: false, nullsFirst: false }).limit(300);
  const ok = (data ?? []).filter((a) => a.outreach_status === "open" && worthShowing(a as never));
  if (!ok.length) return [];
  const { data: have } = await sb.from("cp_people").select("account_id").eq("preview", false).gte("relevance", 50).in("account_id", ok.map((a) => a.id)); // people already stored who match a buyer type
  const has = new Set((have ?? []).map((p) => p.account_id));
  return ok.filter((a) => !has.has(a.id)).slice(0, limit).map((a) => ({ id: a.id, name: a.name as string, domain: a.domain as string }));
}
