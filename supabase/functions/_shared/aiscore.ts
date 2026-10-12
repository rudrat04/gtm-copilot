import { sb } from "./db.ts";
import { log } from "./log.ts";
import { askClaude, BudgetError, parseJson } from "./claude.ts";
import { FIT_COLS, fitReasons } from "./firmo.ts";
import { fitState } from "./score.ts";
import { worthShowing } from "./fitgate.ts";
import { hiringTrend } from "./signals.ts";
import { hashStr } from "./movements.ts";
import icp from "./icp.json" with { type: "json" };

// The AI decides how hot a company or a person is, from everything we know. The rules (heat labels, lead points) stay as the
// fallback and as an input; the AI sees the same facts and judges whether there is a concrete reason to reach out now.
// Results are cached by what they were based on, so a company is only judged again when something about it changes.

export type Ai = { label: "hot" | "warm" | "cold"; score: number; reasons: string[]; risks: string[]; at: string };
export const aiHeat = (label: string): "hot" | "warm" | "watching" => (label === "hot" ? "hot" : label === "warm" ? "warm" : "watching");
const DAY = 86_400_000;
const age = (iso?: string | null) => { const t = Date.parse(iso ?? ""); return Number.isNaN(t) ? "date unknown" : (() => { const d = Math.floor((Date.now() - t) / DAY); return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`; })(); };

const SYSTEM = `You judge sales timing for a seller. Given facts about a company (or the people at it), decide if it is HOT, WARM or COLD for the seller right now.
HOT = it fits the seller's ideal customer AND there is a concrete, recent reason to reach out in the next two weeks (several signals that stack, such as funding plus sales hiring, a new leader, a tool change, a competitor in use, a visit to the seller's pricing page, a problem named in job posts).
WARM = it fits and something is happening, but not strongly or not recently.
COLD = poor fit, nothing happening, or a reason it is a bad moment (for example a company that was acquired, laid people off, or is already being worked).
Use only the facts given. Never invent anything. Return one JSON object and nothing else.`;

type Acct = Record<string, unknown> & { id: string; name: string; domain: string };

/** Everything we know about a company as plain text, and a hash of it so unchanged companies are not judged again. */
export async function companyContext(id: string): Promise<{ text: string; hash: string; a: Acct } | null> {
  const { data: a } = await sb.from("cp_accounts").select(`id,name,domain,segment,priority_score,outreach_status,touches,lost_at,lost_reason,known_as,removed_at,watched_at,site_tools,${FIT_COLS}`).eq("id", id).maybeSingle();
  if (!a || a.removed_at) return null;
  const [{ data: sigs }, { data: evs }, { data: out }, { data: ppl }] = await Promise.all([
    sb.from("cp_signals").select("kind,title,detail,detected_at").eq("account_id", id).order("detected_at", { ascending: false }).limit(40),
    sb.from("cp_watch_events").select("kind,title,detected_at").eq("account_id", id).order("detected_at", { ascending: false }).limit(8),
    sb.from("cp_outcomes").select("kind,created_at").eq("account_id", id).order("created_at", { ascending: false }).limit(4),
    sb.from("cp_people").select("title,persona,relevance").eq("account_id", id).gte("relevance", 50).order("relevance", { ascending: false }).limit(3),
  ]);
  const isSummary = (s: { kind: string; detail?: unknown }) => s.kind === "hiring" && !!s.detail && typeof s.detail === "object" && "salesOpenings" in (s.detail as object);
  const trend = hiringTrend((sigs ?? []).filter(isSummary) as never);
  const lines: string[] = [];
  lines.push(`Company: ${a.name} (${a.domain})${a.segment ? `, ${a.segment}` : ""}`);
  lines.push(`Fit with the seller's profile: ${fitState(a as never)}. ${fitReasons(a as never).map((r) => `${r.label}: ${r.state}${r.text ? ` (${r.text})` : ""}`).join("; ")}`);
  if (a.known_as === "customer") lines.push("It is already a customer.");
  if (a.lost_at) lines.push(`A deal was lost ${age(a.lost_at as string)}${a.lost_reason ? ` (${a.lost_reason})` : ""}.`);
  lines.push(`Sales status: ${a.outreach_status}${a.touches ? `, ${a.touches} touches so far` : ""}.${(out ?? []).length ? ` Recent actions: ${(out ?? []).map((o) => `${String(o.kind).replace(/_/g, " ")} ${age(o.created_at)}`).join(", ")}.` : ""}`);
  if (trend) lines.push(`Open sales roles: ${trend.now} now${trend.before != null ? `, ${trend.before} ${trend.days} days ago` : " (no earlier count)"}.`);
  const real = (sigs ?? []).filter((s) => !isSummary(s)).slice(0, 14);
  lines.push(real.length ? "Signals (newest first):\n" + real.map((s) => `- ${s.kind}: ${s.title.slice(0, 130)} (${age(((s.detail as { published?: string } | null)?.published) ?? s.detected_at)})`).join("\n") : "No signals found.");
  if ((evs ?? []).length) lines.push("Recent movements:\n" + (evs ?? []).map((e) => `- ${e.kind}: ${e.title.slice(0, 100)} (${age(e.detected_at)})`).join("\n"));
  if ((ppl ?? []).length) lines.push(`People who match the seller's buyer types: ${(ppl ?? []).map((p) => `${p.title} (${p.persona})`).join("; ")}.`);
  const text = lines.join("\n");
  return { text, hash: hashStr(text + `|${icp.seller.pitch}`), a: a as Acct };
}

const sellerBlock = () => `The seller: ${icp.seller.pitch}\nIdeal customer: ${icp.company.industries.join(", ")}; ${icp.company.employeesMin}-${icp.company.employeesMax} employees; stages ${icp.company.stages.join(", ")}; regions ${icp.company.regions.join(", ")}. Buyers: ${icp.personas.map((p) => (p as { title: string }).title).join("; ")}.`;

const clean = (r: { label?: string; score?: number; reasons?: unknown; watch_out?: unknown }): Omit<Ai, "at"> | null => {
  const label = r.label === "hot" || r.label === "warm" || r.label === "cold" ? r.label : null;
  if (!label) return null;
  const score = Math.max(0, Math.min(100, Math.round(Number(r.score)))) || (label === "hot" ? 80 : label === "warm" ? 55 : 20);
  const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 180)).slice(0, 3) : []);
  return { label, score, reasons: arr(r.reasons), risks: arr(r.watch_out) };
};

/** Judges one company, unless it was already judged on exactly these facts. */
export async function aiScoreCompany(id: string, force = false): Promise<"scored" | "cached" | "skipped" | "failed"> {
  const ctx = await companyContext(id);
  if (!ctx) return "skipped";
  const { data: have } = await sb.from("cp_ai_scores").select("hash").eq("kind", "company").eq("ref_id", id).maybeSingle();
  if (!force && have?.hash === ctx.hash) return "cached";
  try {
    const raw = await askClaude({ feature: "ai_score", maxTokens: 380, system: SYSTEM, user: `${sellerBlock()}\n\n${ctx.text}\n\nReturn JSON: {"label": "hot"|"warm"|"cold", "score": 0-100, "reasons": [up to 3 short plain-English reasons, each naming the actual fact], "watch_out": [up to 2 short risks or things to check]}` });
    const r = clean(parseJson(raw));
    if (!r) return "failed";
    await sb.from("cp_ai_scores").upsert({ kind: "company", ref_id: id, hash: ctx.hash, label: r.label, score: r.score, reasons: r.reasons, risks: r.risks, created_at: new Date().toISOString() });
    return "scored";
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    await log("warn", "ai_score_failed", { account: ctx.a.domain, message: (e as Error).message });
    return "failed";
  }
}

/** Judges all the people at one company in one call. Names are not sent, only titles and what we know about each. */
export async function aiScorePeople(accountId: string, force = false): Promise<number> {
  const ctx = await companyContext(accountId);
  if (!ctx) return 0;
  const { data: rows } = await sb.from("cp_people").select("id,title,persona,relevance,seniority,department,email_status,hs_status,created_at").eq("account_id", accountId).order("relevance", { ascending: false }).limit(12);
  if (!rows?.length) return 0;
  const { data: evs } = await sb.from("cp_watch_events").select("person_id,kind,detected_at").in("person_id", rows.map((r) => r.id));
  const line = (r: typeof rows[number], i: number) => `${i}: ${r.title}; buyer match: ${r.persona ?? "none"} (${r.relevance}); seniority ${r.seniority}${r.department ? `; ${r.department}` : ""}; email ${r.email_status ?? "none"}; HubSpot ${r.hs_status ?? "-"}${(evs ?? []).filter((e) => e.person_id === r.id).map((e) => `; ${e.kind.replace(/_/g, " ")} ${age(e.detected_at)}`).join("")}`;
  const lines = rows.map(line);
  const { data: have } = await sb.from("cp_ai_scores").select("ref_id,hash").eq("kind", "person").in("ref_id", rows.map((r) => r.id));
  const hashes = rows.map((_r, i) => hashStr(`${ctx.hash}|${lines[i]}`));
  if (!force && rows.every((r, i) => (have ?? []).find((h) => h.ref_id === r.id)?.hash === hashes[i])) return 0;
  try {
    const raw = await askClaude({ feature: "ai_score", maxTokens: 900, system: SYSTEM, user: `${sellerBlock()}\n\nThe company:\n${ctx.text}\n\nThe people (judge each as a lead: someone worth contacting now, soon, or not):\n${lines.join("\n")}\n\nA person who is not one of the seller's buyers is never hot. A recent job change or an invalid email matters. Return JSON: {"people": [{"i": <number>, "label": "hot"|"warm"|"cold", "score": 0-100, "reasons": [up to 3 short reasons]}]}` });
    const out = parseJson<{ people?: { i?: number; label?: string; score?: number; reasons?: unknown }[] }>(raw);
    let n = 0;
    for (const p of out.people ?? []) {
      const row = rows[Number(p.i)]; const r = row ? clean(p) : null;
      if (!row || !r) continue;
      await sb.from("cp_ai_scores").upsert({ kind: "person", ref_id: row.id, hash: hashes[Number(p.i)], label: r.label, score: r.score, reasons: r.reasons, risks: [], created_at: new Date().toISOString() });
      n++;
    }
    return n;
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    await log("warn", "ai_people_failed", { account: ctx.a.domain, message: (e as Error).message });
    return 0;
  }
}

export async function aiMaps(kind: "company" | "person", ids: string[]): Promise<Map<string, Ai>> {
  const out = new Map<string, Ai>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("cp_ai_scores").select("ref_id,label,score,reasons,risks,created_at").eq("kind", kind).in("ref_id", ids.slice(i, i + 200));
    for (const r of data ?? []) out.set(r.ref_id, { label: r.label, score: r.score, reasons: r.reasons as string[], risks: r.risks as string[], at: r.created_at });
  }
  return out;
}

/** The companies worth judging: ones that pass the fit bar, followed ones and ones in progress. Best first. */
export async function candidates(limit = 60): Promise<string[]> {
  const { data } = await sb.from("cp_accounts").select(`id,priority_score,outreach_status,${FIT_COLS}`).is("removed_at", null).order("priority_score", { ascending: false, nullsFirst: false }).limit(300);
  return (data ?? []).filter((a) => a.watched_at || a.outreach_status !== "open" || worthShowing(a as never)).slice(0, limit).map((a) => a.id);
}

/** Judges companies (and the people at them) whose facts changed since they were last judged. Spends a little AI; stops at the daily budget. */
export async function aiRefresh(opts: { maxCompanies?: number; maxPeopleCompanies?: number; ids?: string[] } = {}): Promise<{ companies: number; people: number; stopped?: string }> {
  const out = { companies: 0, people: 0 } as { companies: number; people: number; stopped?: string };
  const ids = opts.ids ?? await candidates();
  let peopleLeft = opts.maxPeopleCompanies ?? 10;
  const maxC = opts.maxCompanies ?? 20;
  try {
    for (let i = 0; i < ids.length && out.companies < maxC; i += 3) { // three at a time keeps a big run inside the time limit
      await Promise.all(ids.slice(i, i + 3).map(async (id) => {
        if (out.companies >= maxC) return;
        const r = await aiScoreCompany(id);
        if (r === "scored") out.companies++;
        if (peopleLeft > 0 && r !== "skipped") { peopleLeft--; const n = await aiScorePeople(id); out.people += n; }
      }));
    }
  } catch (e) {
    if (e instanceof BudgetError) out.stopped = "the daily AI limit was reached"; else throw e;
  }
  await log("info", "ai_refresh", { detail: out });
  return out;
}
