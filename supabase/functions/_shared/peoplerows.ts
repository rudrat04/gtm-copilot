import { sb } from "./db.ts";
import { FIT_COLS } from "./firmo.ts";
import { fitState, heatOf } from "./score.ts";
import { scorePerson } from "./leadscore.ts";
import { teamSignals } from "./peoplesignals.ts";
import { aiHeat, aiMaps } from "./aiscore.ts";
import { explainRank } from "./people.ts";
import { COUNTRIES } from "./lists.ts";

// One shape for a person, with everything the cards need: who they are, the company they work at (fit, heat, facts), what is happening
// around them (their team, their activity, the company's signals), their HubSpot state, and a priority for the To-do board.
// Used by the People tab, the To-do board and the company page, so a person looks the same everywhere.

const DAY = 86_400_000;
const COLS = "id,account_id,first_name,last_name,title,persona,relevance,seniority,department,email,email_status,email_confidence,email_revealed,linkedin_url,hubspot_contact_id,persona_manual,hs_status,hs_note,watched_at,watch_notify,watch_checked_at,activity_checked_at,created_at,provider,preview,decision_maker,todo_state,todo_at";

const age = (iso: string | null | undefined) => { const d = Math.floor((Date.now() - Date.parse(iso ?? "")) / DAY); return Number.isNaN(d) ? "" : d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`; };

export async function peopleRows(admin: boolean, opts: { accountId?: string; personIds?: string[]; limit?: number } = {}) {
  let q = sb.from("cp_people").select(COLS).order("created_at", { ascending: false }).limit(opts.limit ?? 600);
  if (opts.accountId) q = q.eq("account_id", opts.accountId);
  if (opts.personIds) q = q.in("id", opts.personIds.length ? opts.personIds : ["00000000-0000-0000-0000-000000000000"]);
  const { data: rows } = await q;
  const ids = [...new Set((rows ?? []).map((p) => p.account_id))];
  const { data: accts } = ids.length ? await sb.from("cp_accounts").select(`id,name,domain,removed_at,source,hq_city,employee_band,industry_ai_at,outreach_status,touches,hubspot_company_id,hs_seen_id,hs_contacts,${FIT_COLS}`).in("id", ids) : { data: [] };
  const a = new Map((accts ?? []).map((x) => [x.id, x]));
  const since = new Date(Date.now() - 14 * DAY).toISOString();
  const [{ data: sigs }, { data: evs }, { data: coEvs }] = await Promise.all([
    ids.length ? sb.from("cp_signals").select("account_id,kind,title,url,detail,detected_at").in("account_id", ids).order("detected_at", { ascending: false }).limit(2000) : Promise.resolve({ data: [] }),
    sb.from("cp_watch_events").select("person_id,kind,title,url,detected_at").in("kind", ["job_change", "mention", "activity", "team"]).not("person_id", "is", null).order("detected_at", { ascending: false }),
    ids.length ? sb.from("cp_watch_events").select("account_id,kind,title,url,detected_at").in("account_id", ids).is("person_id", null).gt("detected_at", since).order("detected_at", { ascending: false }) : Promise.resolve({ data: [] }),
  ]);
  const aiCo = await aiMaps("company", ids);
  const heatOfAcct = new Map<string, "hot" | "warm" | "watching">();
  for (const id of ids) heatOfAcct.set(id, aiCo.has(id) ? aiHeat(aiCo.get(id)!.label) : heatOf((sigs ?? []).filter((s) => s.account_id === id) as never, fitState(a.get(id) as never)));
  const aiPeople = await aiMaps("person", (rows ?? []).map((p) => p.id));
  const daysSince = (kind: string, pid: string) => { const e = (evs ?? []).find((x) => x.person_id === pid && x.kind === kind); return e ? Math.floor((Date.now() - Date.parse(e.detected_at)) / DAY) : null; };
  const isSummary = (s: { kind: string; detail?: unknown }) => s.kind === "hiring" && !!s.detail && typeof s.detail === "object" && "salesOpenings" in (s.detail as object);

  const people = (rows ?? []).filter((p) => a.has(p.account_id) && !a.get(p.account_id)!.removed_at).map((p) => {
    const c = a.get(p.account_id)!;
    const fit = fitState(c as never), heat = heatOfAcct.get(p.account_id) ?? "watching";
    const mine = (sigs ?? []).filter((s) => s.account_id === p.account_id);
    const activity = (evs ?? []).filter((x) => x.person_id === p.id).slice(0, 4).map((x) => ({ kind: x.kind, title: x.title, url: x.url, at: x.detected_at }));
    const place = [c.hq_city, c.country].filter(Boolean).join(", ");
    return {
      lead: scorePerson({ relevance: p.relevance, persona: p.persona, companyFit: fit, companyHeat: heat, jobChangeDays: daysSince("job_change", p.id), mentionDays: daysSince("mention", p.id), emailStatus: p.email_status, hasEmail: !!p.email, hsStatus: p.hs_status }) as ReturnType<typeof scorePerson> & { ai?: boolean },
      id: p.id, account_id: p.account_id, company: c.name as string, domain: c.domain as string,
      name: admin ? `${p.first_name} ${p.last_name}`.trim() : `${p.first_name} ${(p.last_name || "").charAt(0)}.`.trim(),
      title: p.title, persona: p.persona, relevance: p.relevance, seniority: p.seniority, department: p.department,
      decision_maker: p.decision_maker ?? null, preview: !!p.preview, persona_manual: !!p.persona_manual,
      match_why: p.persona_manual ? (p.persona ? `You set this buyer type by hand (${p.persona}).` : "You marked this person as not a buyer.") : explainRank(p.title ?? "", p.department),
      has_email: !!p.email, revealed: admin && !!p.email_revealed, email: admin && p.email_revealed ? p.email : null, email_status: p.email_status, email_confidence: p.email_confidence,
      linkedin: admin && p.linkedin_url ? p.linkedin_url : null,
      in_hubspot: !!p.hubspot_contact_id, hs_status: p.hs_status, hs_note: p.hs_note,
      hs_company: c.hubspot_company_id || c.hs_seen_id ? { contacts: c.hs_contacts ?? null, ours: !!c.hubspot_company_id } : null,
      watched: !!p.watched_at, added: p.created_at, manual: p.provider === "manual", todo_state: p.todo_state ?? null,
      company_fit: fit, company_heat: heat,
      co: {
        stage: c.stage ?? null, industry: c.industry_ai ?? c.industry ?? null, location: place || null, city: c.hq_city ?? null, country: c.country ?? null, country_name: c.country ? (COUNTRIES.find(([k]) => k === String(c.country).toUpperCase())?.[1] ?? String(c.country)) : null, size: c.employee_band ? `${c.employee_band} people` : c.employees ? `${c.employees} people` : null,
        source: c.source, checked: !!c.firmo_at, industry_read: !!c.industry_ai_at, watched: !!c.watched_at, outreach: c.outreach_status, touches: c.touches,
      },
      signals: mine.filter((s) => !isSummary(s)).slice(0, 3).map((s) => ({ kind: s.kind, title: s.title, url: s.url, age: age(((s.detail as { published?: string } | null)?.published) ?? s.detected_at) })),
      company_events: (coEvs ?? []).filter((x) => x.account_id === p.account_id).slice(0, 2).map((x) => ({ kind: x.kind, title: x.title, url: x.url, at: x.detected_at })),
      team: teamSignals(p.department, p.title, mine as never),
      activity,
      latest: [activity[0]?.at, (coEvs ?? []).find((x) => x.account_id === p.account_id)?.detected_at, mine.find((x) => !isSummary(x))?.detected_at].filter(Boolean).sort().pop() ?? null,
      watch: { notify: p.watch_notify, checked: p.watch_checked_at, activity_checked: p.activity_checked_at },
      priority: 0,
    };
  });
  // The AI's judgement replaces the rule-based lead when there is one; a person who opted out stays blocked either way.
  for (const p of people) {
    const ai = aiPeople.get(p.id);
    if (ai && p.lead.label !== "blocked") p.lead = { ...p.lead, score: ai.score, label: ai.label, reasons: ai.reasons.length ? ai.reasons : p.lead.reasons, ai: true } as typeof p.lead;
    // Priority for the board: the lead score, a little for fit, and a lift when something just happened to the person or their company.
    const fresh = (e: { at: string }) => Date.now() - Date.parse(e.at) < 7 * DAY;
    p.priority = Math.round(p.lead.score + (p.company_fit === "matches" ? 6 : p.company_fit === "close" ? 2 : 0) + (p.activity.some(fresh) ? 12 : 0) + (p.company_events.some(fresh) ? 6 : 0) + (p.todo_state === "pinned" ? 25 : 0) + (p.decision_maker ? 3 : 0));
  }
  return people;
}
