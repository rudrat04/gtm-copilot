import { json, sb } from "../_shared/db.ts";
import { isAdmin } from "../_shared/auth.ts";
import { log, serve } from "../_shared/log.ts";
import { applyOutcome, type OutcomeKind } from "../_shared/lifecycle.ts";
import { buildToday, reasonLine } from "../_shared/today.ts";
import { buildBoard } from "../_shared/board.ts";
import { listNotifications, markRead } from "../_shared/notify.ts";
import { signalsFeed } from "../_shared/signalsfeed.ts";
import { addNote, exportPerson, listNotes, suppressPerson } from "../_shared/personnotes.ts";
import { revealPerson } from "../_shared/peoplepreview.ts";
import { hunterBalance, monthlyUsed, HUNTER_MONTHLY_CAP } from "../_shared/people.ts";
import { draftNoteHtml, noteToHubSpot } from "../_shared/hsnotes.ts";
import { writeDraft } from "../_shared/draft.ts";
import { FIT_COLS, fetchFirmo, firmoLine, fitBreakdown, fitReasons, saveFirmo, usdShort } from "../_shared/firmo.ts";
import { fitState, heatOf, scoreAccount } from "../_shared/score.ts";
import { contactsFor } from "../_shared/contacts.ts";
import { fetchSite } from "../_shared/signals.ts";
import { BudgetError } from "../_shared/claude.ts";
import { tierOf } from "../_shared/score.ts";
import { activeFlags, flagAction } from "../_shared/flags.ts";
import { meetsFit, queueThreshold, worthShowing } from "../_shared/fitgate.ts";
import { clean, DEPARTMENTS, INDUSTRIES, loadProfile, REGIONS, saveProfile, SENIORITIES, STAGES } from "../_shared/profile.ts";
import { REGION_GROUPS, RULE_TYPES } from "../_shared/lists.ts";
import { addPersonToWatchlist, addToWatchlist, checkNow, markSeen, setNotify, setPersonWatched, setWatched, watchlistView } from "../_shared/watchlist.ts";
import { cleanBrand, loadBrand, saveBrand } from "../_shared/brand.ts";
import { peopleRows } from "../_shared/peoplerows.ts";
import { peekCandidates, peekPeople } from "../_shared/peoplepreview.ts";
import { aiHeat, aiMaps, aiRefresh, aiScoreCompany, aiScorePeople, candidates } from "../_shared/aiscore.ts";
import { industryCheckMany, needIndustry } from "../_shared/industry.ts";
import { judgeMany, judgeFit } from "../_shared/fitjudge.ts";
import { icpVersion } from "../_shared/fitver.ts";
import { capacityMode, markDiscoveryVersion, readyCount, todayCap } from "../_shared/capacity.ts";
import { customerInsights } from "../_shared/customers.ts";
import { suggestProfile } from "../_shared/suggest.ts";
import { rerankPeople } from "../_shared/people.ts";
import { runDiscovery } from "../_shared/discover.ts";
import { applyLossReason, isLossReason, verifyLoss } from "../_shared/lossreason.ts";
import { applyDebrief, endsAt, OUTCOME_LABEL, OUTCOMES, type Outcome, verify } from "../_shared/debrief.ts";
import { countryName, refreshAllFields } from "../_shared/hsfields.ts";
import { stageOf } from "../_shared/stage.ts";
import { isNotFitReason, markNotFit, NOT_FIT_REASONS } from "../_shared/notfit.ts";
import { planBulkFind, runBulkFind } from "../_shared/bulkfind.ts";
import { guardPeople } from "../_shared/guard.ts";
import { cleanSignals } from "../_shared/cleanup.ts";
import { plCap, plConfigured, plUsed, refreshFromPredictLeads } from "../_shared/predictleads.ts";
import { ensurePersonaOption } from "../_shared/hubspot.ts";
import { checkConnections, healthView } from "../_shared/health.ts";
import icp from "../_shared/icp.json" with { type: "json" };

const DAY = 86_400_000;

// Queue views: what still needs a first touch, what is in progress, and what is parked.
const VIEWS: Record<string, string[]> = {
  todo: ["open"],
  progress: ["contacted", "replied", "meeting"],
  parked: ["snoozed", "not_now"],
};

/** Next Monday 06:00 UTC (11:30 IST) strictly after now (the weekly scan window opens then). */
function nextScan(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0));
  const add = (8 - d.getUTCDay()) % 7; // days until Monday (1)
  d.setUTCDate(d.getUTCDate() + (add === 0 ? 0 : add));
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString();
}

async function scanInfo() {
  const [{ data: sched }, { data: state }, { data: last }] = await Promise.all([
    sb.rpc("cp_scan_schedule"),
    sb.from("cp_state").select("value").eq("key", "scan_last").maybeSingle(),
    sb.from("cp_accounts").select("last_scanned_at").not("last_scanned_at", "is", null)
      .order("last_scanned_at", { ascending: false }).limit(1),
  ]);
  return {
    label: icp.schedule.label,
    active: Array.isArray(sched) ? !!sched[0]?.active : false,
    // The real weekly scan time; researching a single company also touches last_scanned_at, so it is only a fallback.
    last_scan: state?.value ?? last?.[0]?.last_scanned_at ?? null,
    next_scan: nextScan(),
  };
}

async function list(view = "todo", admin = false) {
  const { data: accounts } = await sb.from("cp_accounts")
    .select("id,name,domain,segment,source,created_at,priority_score,icp_score,why_now,status,hubspot_company_id,last_scanned_at,outreach_status,touches,contacted_at,next_followup_at,snoozed_until,employees,employee_band,stage,raised_usd,hq_city,country,firmo_at,light_source,tech,industry,tags,blurb,sales_motion,known_as,last_round_date,industry_ai")
    .is("removed_at", null).in("status", ["queued", "pushed"])
    .in("outreach_status", VIEWS[view] ?? VIEWS.todo)
    .order("priority_score", { ascending: false })
    .limit(30);
  const ids = (accounts ?? []).map((a) => a.id);
  const scan = await scanInfo();
  if (!ids.length) return { accounts: [], scanned: 0, scan };

  const contactMap = await contactsFor(ids, admin);
  const [{ data: signals }, { data: drafts }, { data: dossiers }, { count }] = await Promise.all([
    sb.from("cp_signals").select("account_id,kind,title,url,detail,detected_at").in("account_id", ids)
      .order("detected_at", { ascending: false }),
    sb.from("cp_outreach_drafts").select("account_id,persona,subject,body,status").in("account_id", ids)
      .order("created_at", { ascending: false }),
    sb.from("cp_dossiers").select("account_id").in("account_id", ids),
    sb.from("cp_accounts").select("id", { count: "exact", head: true }).not("last_scanned_at", "is", null),
  ]);
  const withDossier = new Set((dossiers ?? []).map((d) => d.account_id));

  return {
    scanned: count ?? 0,
    scan,
    accounts: (accounts ?? []).map((a) => ({
      ...a,
      has_dossier: withDossier.has(a.id),
      firmo: firmoLine(a),
      outside_icp: (() => { const f = fitBreakdown(a); return f.known && f.size === 0; })(),
      contacts: contactMap.get(a.id) ?? [],
      tier: tierOf(a.priority_score),
      signals: (signals ?? []).filter((s) => s.account_id === a.id).slice(0, 6).map((s) => ({
        kind: s.kind,
        title: s.title,
        url: s.url,
        first_seen: s.detected_at,
        published: (s.detail as { published?: string } | null)?.published ?? null,
        is_new: Date.now() - new Date(s.detected_at).getTime() < 7 * DAY,
      })),
      draft: (drafts ?? []).find((d) => d.account_id === a.id) ?? null,
    })),
  };
}

// The tools worth showing on a card: sales, marketing, support, billing, product analytics and people tools. A website also lists dozens of
// technical tools (hosting, fonts, frameworks) that say nothing about how the company sells, so they are counted but not shown.
const BUSINESS_TECH = /^(salesforce|hubspot|salesloft|outreach|gong|apollo|zoominfo|clay|pipedrive|attio|clari|close|zoho.*|dynamics.*|intercom|drift|zendesk|freshdesk|freshworks|help-?scout|segment|mixpanel|amplitude|posthog|heap|hotjar|fullstory|stripe|chargebee|zuora|paddle|recurly|marketo|pardot|mailchimp|sendgrid|customer-io|braze|klaviyo|iterable|calendly|chili-?piper|docusign|pandadoc|notion|slack|zapier|okta|auth0|shopify|netsuite|quickbooks|gusto|rippling|workday|greenhouse|lever|ashby|vanta|drata|linkedin.*|g2.*|crisp|livechat|typeform|webflow|wordpress|squarespace|wix)$/;

/** What the Accounts card shows, with every field present (a missing value is shown as "Unknown" by the page, never hidden). */
function accountFacts(a: { firmo_at: string | null; employees: number | null; employee_band: string | null; stage: string | null; raised_usd: number | null; last_round_date: string | null; hq_city: string | null; country: string | null; founded_year: number | null; industry: string | null; tags: string[] | null; segment: string | null; tech: string[] | null; sales_motion: string | null; linkedin_handle: string | null }) {
  const place = [a.hq_city, countryName(a.country)].filter(Boolean).join(", ");
  const all = a.tech ?? [];
  const tools = all.filter((t) => BUSINESS_TECH.test(t));
  return {
    checked: !!a.firmo_at,
    employees: a.employees,
    size: a.employee_band ? `${a.employee_band} people` : a.employees ? `${a.employees} people` : null,
    stage: a.stage && !/^(other|unknown|undisclosed)$/i.test(a.stage) ? a.stage : null,
    raised: a.raised_usd ? usdShort(a.raised_usd) : null,
    last_round: a.last_round_date,
    location: place || null,
    city: a.hq_city || null,
    country_name: a.country ? countryName(a.country) : null,
    founded: a.founded_year,
    industry: a.industry || (a.tags ?? []).slice(0, 3).join(", ") || null,
    tools: tools.slice(0, 6), more_tools: Math.max(0, tools.length - 6), tech_count: all.length,
    motion: a.sales_motion,
    linkedin: a.linkedin_handle,
  };
}

/**
 * Every company worth showing, in one list. Low-fit companies (clearly outside the target size or stage, or with
 * no signal) are flagged `low` so the page can hide them. Skipped discovery candidates are never returned.
 */
async function accountsView(admin: boolean) {
  const { data: all } = await sb.from("cp_accounts")
    .select("id,name,domain,segment,source,created_at,won_at,not_fit_reason,lost_at,lost_reason,priority_score,icp_score,why_now,status,hubspot_company_id,last_scanned_at,outreach_status,touches,contacted_at,next_followup_at,snoozed_until,employees,employee_band,stage,raised_usd,hq_city,country,firmo_at,light_source,tech,industry,tags,blurb,sales_motion,known_as,last_round_date,industry_ai,founded_year,linkedin_handle,removed_at,watched_at,people_searched_at,industry_ai_at,pl_checked_at,hs_seen_id,hs_contacts")
    .order("priority_score", { ascending: false, nullsFirst: false }).limit(400);
  const rows = (all ?? []).map((a) => {
    const f = fitBreakdown(a);
    const outside = f.known && (f.size === 0 || f.stage === 0);
    const deliberate = !!a.watched_at || a.source === "research" || a.source === "discovered" || a.source === "hubspot" || !!a.lost_at; // someone chose or the system found it
    const low = !deliberate && !worthShowing(a) && a.outreach_status === "open";
    const isNew = a.source === "discovered" && a.outreach_status === "open" && Date.now() - Date.parse(a.created_at) < 14 * DAY;
    return { a, removed: !!a.removed_at, low: !a.removed_at && !a.watched_at && (low || (a.source === "discovered" && !!a.firmo_at && !meetsFit(fitState(a)) && a.outreach_status === "open")), outside, isNew }; // found by the system and checked, and below the fit bar: hidden. One not checked yet stays in Prospects as "fit unknown"
  });
  const aiById = await aiMaps("company", rows.map((r) => r.a.id));
  const shown = rows.filter((r) => !r.low && !r.removed).map((r) => r.a.id);
  const ids = shown.length ? shown : ["00000000-0000-0000-0000-000000000000"];
  const [contactMap, { data: signals }, { data: ppl }, { data: disc }] = await Promise.all([
    contactsFor(ids, admin),
    sb.from("cp_signals").select("account_id,kind,title,url,detail,detected_at").in("account_id", ids).order("detected_at", { ascending: false }).limit(1500),
    sb.from("cp_people").select("account_id").in("account_id", ids),
    sb.from("cp_discovered").select("domain,reason,found_at,source,source_url").eq("status", "added").order("found_at", { ascending: false }).limit(100),
  ]);
  const { data: lastRun } = await sb.from("cp_state").select("value").eq("key", "discovery_last").maybeSingle();
  const searched = new Set((ppl ?? []).map((p) => p.account_id));
  const peopleCount = new Map<string, number>();
  for (const p of ppl ?? []) peopleCount.set(p.account_id, (peopleCount.get(p.account_id) ?? 0) + 1);
  const why = new Map((disc ?? []).map((d) => [d.domain, d.reason]));
  const via = new Map((disc ?? []).map((d) => [d.domain, { source: d.source, url: d.source_url }]));
  const sigsBy = new Map<string, NonNullable<typeof signals>>();
  for (const s of signals ?? []) (sigsBy.get(s.account_id) ?? sigsBy.set(s.account_id, []).get(s.account_id)!).push(s);
  const isSummary = (s: { kind: string; detail: unknown }) => s.kind === "hiring" && !!s.detail && typeof s.detail === "object" && "salesOpenings" in (s.detail as object);

  return {
    discovery: { added_30d: (disc ?? []).filter((d) => Date.parse(d.found_at) > Date.now() - 30 * DAY).length, last: disc?.[0]?.found_at ?? null, report: (() => { try { return lastRun?.value ? JSON.parse(lastRun.value) : null; } catch { return null; } })() },
    scan: await scanInfo(),
    ai_missing: rows.filter((r) => !r.removed && !r.low && !aiById.has(r.a.id)).length,
    industry_missing: rows.filter((r) => !r.removed && !r.a.industry_ai_at).length,
    good_tools: (icp.company.toolsGood as string[]).map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, "")),
    accounts: rows.map(({ a, low, removed, outside, isNew }) => {
      const mine = (sigsBy.get(a.id) ?? []).filter((s, i, arr) => !isSummary(s) || arr.findIndex(isSummary) === i);
      return {
        id: a.id, name: a.name, domain: a.domain, segment: a.segment, source: a.source, created_at: a.created_at,
        tier: tierOf(a.priority_score), priority: a.priority_score, icp_score: a.icp_score, why_now: a.why_now,
        facts: accountFacts(a), firmo: firmoLine(a), outside_icp: outside, fit: fitState(a), fit_reasons: fitReasons(a), excluded: fitBreakdown(a).excluded,
        heat: aiById.has(a.id) ? aiHeat(aiById.get(a.id)!.label) : heatOf(sigsBy.get(a.id) as never ?? [], fitState(a)), ai: aiById.get(a.id) ?? null,
        ...(() => { const heat = aiById.has(a.id) ? aiHeat(aiById.get(a.id)!.label) : heatOf(sigsBy.get(a.id) as never ?? [], fitState(a)); const s = stageOf({ removed, outreach: a.outreach_status ?? null, won: !!a.won_at, lost: !!a.lost_at && a.outreach_status === "not_now", customer: a.known_as === "customer", notFit: !!a.not_fit_reason, snoozed: !!a.snoozed_until && Date.parse(a.snoozed_until) > Date.now(), fit: fitState(a), hasBuyer: (contactMap.get(a.id) ?? []).length > 0, heat, watched: !!a.watched_at }); return { pstage: s.stage, pstage_why: s.why }; })(),
        hs_seen: !!a.hs_seen_id, hs_contacts: a.hs_contacts ?? null, firmo_known: !!a.firmo_at, industry_read: !!a.industry_ai_at, news_checked: !!a.pl_checked_at, low, removed, watched: !!a.watched_at, is_new: isNew, hubspot: a.status === "pushed" || !!a.hubspot_company_id,
        outreach_status: a.outreach_status, touches: a.touches, contacted_at: a.contacted_at, next_followup_at: a.next_followup_at, snoozed_until: a.snoozed_until,
        lost_at: a.lost_at, lost_reason: a.lost_reason, not_fit_reason: a.not_fit_reason,
        last_scanned_at: a.last_scanned_at, found_reason: why.get(a.domain) ?? null, found_via: via.get(a.domain) ?? null,
        searched: searched.has(a.id), people_count: peopleCount.get(a.id) ?? 0, searched_at: a.people_searched_at ?? null, contacts: contactMap.get(a.id) ?? [],
        signals: low || removed ? [] : mine.slice(0, 3).map((s) => ({
          kind: s.kind, title: s.title, url: s.url, first_seen: s.detected_at,
          published: (s.detail as { published?: string } | null)?.published ?? null,
          is_new: Date.now() - new Date(s.detected_at).getTime() < 7 * DAY,
        })),
      };
    }),
  };
}

/** Everyone we have searched, found or added, with or without an email, so nothing has to be searched twice. One company, or all (newest first). */
async function peopleList(admin: boolean, accountId?: string) {
  return { people: await peopleRows(admin, { accountId }) };
}

/** One company in full: its card, every signal, what moved, its history and meetings. */
async function companyView(id: string, admin: boolean) {
  const view = await accountsView(admin);
  const account = view.accounts.find((a) => a.id === id);
  if (!account) return null;
  const [{ data: sigs }, { data: events }, { data: outcomes }, { data: meetings }, { data: acct }, people, { data: drafts }] = await Promise.all([
    sb.from("cp_signals").select("kind,title,url,detail,detected_at").eq("account_id", id).order("detected_at", { ascending: false }).limit(40),
    sb.from("cp_watch_events").select("kind,title,url,detected_at,importance").eq("account_id", id).order("detected_at", { ascending: false }).limit(20),
    sb.from("cp_outcomes").select("kind,note,created_at").eq("account_id", id).order("created_at", { ascending: false }).limit(15),
    sb.from("cp_meetings").select("title,starts_at,outcome,status").eq("account_id", id).order("starts_at", { ascending: false }).limit(8),
    sb.from("cp_accounts").select("hubspot_company_id").eq("id", id).maybeSingle(),
    peopleList(admin, id),
    sb.from("cp_outreach_drafts").select("persona,subject,body,created_at").eq("account_id", id).order("created_at", { ascending: false }).limit(3),
  ]);
  const isSummary = (s: { kind: string; detail: unknown }) => s.kind === "hiring" && !!s.detail && typeof s.detail === "object" && "salesOpenings" in (s.detail as object);
  const seenSummary = { v: false };
  const signals = (sigs ?? []).filter((s) => !isSummary(s) || (!seenSummary.v && (seenSummary.v = true))).slice(0, 25).map((s) => ({
    kind: s.kind, title: s.title, url: s.url, first_seen: s.detected_at, published: (s.detail as { published?: string } | null)?.published ?? null,
    is_new: Date.now() - Date.parse(s.detected_at) < 7 * DAY,
  }));
  return {
    account, signals, events: events ?? [], history: (outcomes ?? []).map((o) => ({ kind: o.kind, note: o.note, at: o.created_at })),
    meetings: admin ? (meetings ?? []) : [], people: people.people, drafts: admin ? (drafts ?? []) : [], good_tools: view.good_tools,
    hubspot_url: acct?.hubspot_company_id ? `https://${icp.owner.hubspotHost}/contacts/${icp.owner.hubspotPortal}/record/0-2/${acct.hubspot_company_id}` : null,
    admin,
  };
}

const shortName = (n: string | null) => { const p = (n ?? "").trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0] || "Attendee"; };

/** Meetings: what needs a debrief, what is coming up, and what already happened. Public viewers see no names, emails or notes. */
async function meetingsView(admin: boolean) {
  const now = Date.now();
  const { data } = await sb.from("cp_meetings")
    .select("id,title,starts_at,ends_at,status,cancelled_at,rescheduled_from,reschedule_count,attendee_name,attendee_email,attendee_domain,account_id,brief,outcome,debriefed_at,notes,recap,crm_sync")
    .in("status", ["briefed", "cancelled"]).order("starts_at", { ascending: false }).limit(60);
  const ids = [...new Set((data ?? []).map((m) => m.account_id).filter(Boolean))] as string[];
  const { data: accts } = ids.length ? await sb.from("cp_accounts").select("id,name,domain,hubspot_company_id").in("id", ids) : { data: [] };
  const byId = new Map((accts ?? []).map((a) => [a.id, a]));
  const view = (m: NonNullable<typeof data>[number]) => {
    const a = m.account_id ? byId.get(m.account_id) : null;
    return {
      id: m.id, title: m.title, starts_at: m.starts_at, ends_at: new Date(endsAt(m)).toISOString(),
      attendee: admin ? m.attendee_name : shortName(m.attendee_name), email: admin ? m.attendee_email : null,
      company: a?.name ?? m.attendee_domain, domain: m.attendee_domain, in_hubspot: !!a?.hubspot_company_id,
      outcome: m.outcome, debriefed_at: m.debriefed_at, status: m.status, cancelled_at: m.cancelled_at, moved_from: m.rescheduled_from, moves: m.reschedule_count,
      brief: admin ? m.brief : null, notes: admin ? m.notes : null, recap: admin ? m.recap : null, crm: admin ? m.crm_sync : null,
    };
  };
  const all = (data ?? []).map(view);
  const rows = all.filter((m) => m.status === "briefed");
  const ended = (m: { ends_at: string }) => Date.parse(m.ends_at) <= now;
  return {
    labels: OUTCOME_LABEL,
    needs: rows.filter((m) => ended(m) && !m.outcome && Date.parse(m.starts_at) > now - 14 * DAY),
    upcoming: rows.filter((m) => !ended(m)).reverse(),
    done: rows.filter((m) => m.outcome).slice(0, 12),
    cancelled: all.filter((m) => m.status === "cancelled" && Date.parse(m.cancelled_at ?? m.starts_at) > now - 14 * DAY).slice(0, 8),
  };
}

/** Everything the Setup tab needs: the editable profile, discovery status and a few counts. */
async function setupView() {
  const [profile, { data: disc }, { count: unknown }, { data: ai }, { data: fitRows }] = await Promise.all([
    loadProfile(),
    sb.from("cp_discovered").select("status,found_at").order("found_at", { ascending: false }).limit(60),
    sb.from("cp_accounts").select("id", { count: "exact", head: true }).is("firmo_at", null),
    sb.from("cp_ai_spend_today").select("usd").single(),
    sb.from("cp_accounts").select("employees,stage,country,firmo_at,light_source,employee_band,tech,industry,tags,blurb,sales_motion,known_as,last_round_date,industry_ai,domain,name,source,lost_at,outreach_status").limit(1000),
  ]);
  const fitCounts = { matches: 0, close: 0, unknown: 0, outside: 0 };
  for (const r of fitRows ?? []) fitCounts[fitState(r)]++;
  const month = Date.now() - 30 * DAY;
  return {
    profile,
    options: { stages: STAGES, regions: REGIONS, region_groups: Object.keys(REGION_GROUPS).length, rule_types: RULE_TYPES, industries: INDUSTRIES, departments: DEPARTMENTS, seniorities: SENIORITIES, not_fit_reasons: NOT_FIT_REASONS },
    discovery: {
      schedule: "Mondays at 10:30 IST, an hour before the signal scan",
      last: disc?.[0]?.found_at ?? null,
      added_30d: (disc ?? []).filter((d) => d.status === "added" && Date.parse(d.found_at) > month).length,
    },
    unknown_fit: unknown ?? 0,
    fit_counts: fitCounts,
    predictleads: { configured: plConfigured(), used: plConfigured() ? await plUsed() : 0, cap: plCap() },
    digest_time_ist: await digestTimeIst(),
    ai: { today_usd: Number(ai?.usd ?? 0), cap_usd: icp.ai.dailyBudgetUsd },
  };
}

/** The daily email time as IST "HH:MM", read from the schedule. */
async function digestTimeIst(): Promise<string> {
  const { data } = await sb.rpc("cp_digest_time");
  const m = /^(\d{2}):(\d{2})$/.exec(String(data ?? ""));
  const mins = m ? ((Number(m[1]) * 60 + Number(m[2]) + 330) % 1440) : 8 * 60;
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/** The ICP playbook for the sales team, straight from the live config plus a few counts. */
async function playbook() {
  const { data: accts } = await sb.from("cp_accounts").select("priority_score,status,last_scanned_at,employees,stage,country,firmo_at");
  const rows = accts ?? [];
  const tiers = { tier_1: 0, tier_2: 0, tier_3: 0 };
  for (const r of rows) if (r.priority_score != null) tiers[tierOf(r.priority_score)]++;
  const { data: disc } = await sb.from("cp_discovered").select("name,domain,status,reason,source_url,found_at").order("found_at", { ascending: false }).limit(40);
  const month = Date.now() - 30 * DAY;
  const recent = (disc ?? []).filter((d) => Date.parse(d.found_at) > month);
  return {
    discovery: {
      note: icp.discovery.note,
      added: recent.filter((d) => d.status === "added").length,
      rejected: recent.filter((d) => d.status === "rejected").length,
      last: disc?.[0]?.found_at ?? null,
      recent: (disc ?? []).slice(0, 14),
    },
    seller: icp.seller,
    company: icp.company,
    personas: icp.personas.map((p) => ({ title: p.title, note: p.onlyBelow ? `Only when the company has under ${p.onlyBelow} people` : null })),
    signals: icp.signals.catalog,
    tiers: icp.tiers,
    queue_threshold: 30,
    schedule: icp.schedule.label,
    follow_up: { days: icp.followUp.days, note: icp.followUp.note },
    today: { cap: icp.today.cap, hot_hours: icp.today.hotHours },
    stats: {
      companies: rows.length,
      scanned: rows.filter((r) => r.last_scanned_at).length,
      queued: rows.filter((r) => r.status === "queued").length,
      enriched: rows.filter((r) => r.employees != null).length,
      matching: rows.filter((r) => fitBreakdown(r).matches).length,
      ...tiers,
    },
  };
}

/** Owner only. Looks up company facts once per company (about 0.2 Hunter credit each), then re-scores them. */
async function enrichCompanies(rescoreAll = false, only?: string[]) {
  const q = sb.from("cp_accounts").select("id,domain");
  const { data: todo } = await (only ? q.in("id", only) : q.is("firmo_at", null))
    .order("priority_score", { ascending: false, nullsFirst: false }).limit(60);
  const out = { looked_up: 0, no_data: 0, failed: 0, rescored: 0 };
  const accounts = rescoreAll ? [] : (todo ?? []);

  for (let i = 0; i < accounts.length; i += 5) {
    await Promise.allSettled(accounts.slice(i, i + 5).map(async (a) => {
      try {
        const f = await fetchFirmo(a.domain);
        if (!f) {
          out.no_data++;
          await sb.from("cp_accounts").update({ firmo_at: new Date().toISOString() }).eq("id", a.id); // do not retry endlessly
          return;
        }
        await saveFirmo(a.id, f);
        out.looked_up++;
      } catch (e) {
        out.failed++;
        await log("error", "firmo_failed", { account: a.domain, message: (e as Error).message });
      }
    }));
  }

  // New fit points change the priority score, so recompute it from the stored signals.
  const ids = rescoreAll ? ((await sb.from("cp_accounts").select("id")).data ?? []).map((a) => a.id) : accounts.map((a) => a.id);
  if (ids.length) {
    const [{ data: rows }, { data: sigs }] = await Promise.all([
      sb.from("cp_accounts").select("id,status,employees,stage,country,firmo_at,light_source,employee_band,tech,industry,tags,blurb,sales_motion,known_as,last_round_date,industry_ai,domain,name").in("id", ids),
      sb.from("cp_signals").select("account_id,kind,title,detail,detected_at").in("account_id", ids),
    ]);
    for (const r of rows ?? []) {
      const mine = (sigs ?? []).filter((s) => s.account_id === r.id).map((s) => ({ ...s, url: null, detail: { ...(s.detail ?? {}), detected_at: s.detected_at } }));
      const score = scoreAccount(mine as never, r).score;
      const upd: Record<string, unknown> = { priority_score: score };
      if (r.status === "new" && score >= queueThreshold()) { upd.status = "queued"; upd.why_now = reasonLine(mine as never); }
      await sb.from("cp_accounts").update(upd).eq("id", r.id);
      out.rescored++;
    }
  }
  await log("info", "companies_enriched", { detail: out });
  return out;
}

/**
 * Owner only. Adds industry, tools, tags and a description to companies that already have size and stage, best accounts first
 * and only ones that pass the fit bar (0.2 Hunter credit each). `dry` just says how many and what it would cost.
 */
async function refreshFacts(limit: number, dry: boolean) {
  const { data } = await sb.from("cp_accounts").select("id,priority_score,employees,stage,country,firmo_at,light_source,employee_band,tech,industry,tags,blurb,sales_motion,domain,name,known_as")
    .not("firmo_at", "is", null).is("facts2_at", null).order("priority_score", { ascending: false, nullsFirst: false }).limit(300);
  const todo = (data ?? []).filter((a) => worthShowing(a));
  const ids = todo.slice(0, Math.max(1, Math.min(25, limit))).map((a) => a.id);
  if (dry) return { dry: true, missing: todo.length, will_look_up: ids.length, credits: Math.round(ids.length * 0.2 * 10) / 10 };
  return { dry: false, missing: todo.length, ...(await enrichCompanies(false, ids)) };
}

/** Writes the outreach draft only when someone asks for it. The owner generates; everyone can read a saved one. */
async function draft(accountId: string, admin: boolean) {
  const { data: a } = await sb.from("cp_accounts").select("id,name,domain").eq("id", accountId).maybeSingle();
  if (!a) return json({ error: "Account not found" }, 404);

  const { data: saved } = await sb.from("cp_outreach_drafts").select("persona,subject,body").eq("account_id", a.id)
    .in("status", ["pending", "approved"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (saved) return json({ mode: "saved", draft: saved });
  if (!admin) return json({ mode: "dry_run", message: "Demo mode: the owner can generate a draft (about 1 cent)." });

  try {
    const [{ data: sigs }, site] = await Promise.all([
      sb.from("cp_signals").select("kind,title,url,detail").eq("account_id", a.id).order("detected_at", { ascending: false }).limit(12),
      fetchSite(a.domain),
    ]);
    const d = await writeDraft(a.name, a.domain, site, (sigs ?? []) as never);
    await sb.from("cp_outreach_drafts").insert({ account_id: a.id, persona: d.persona, subject: d.subject, body: d.body });
    const noted = await noteToHubSpot(a.id, draftNoteHtml(d), "draft"); // a draft is a suggestion: HubSpot gets it labelled "not sent"
    await log("info", "draft_written", { account: a.domain, detail: { noted } });
    return json({ mode: "live", draft: { persona: d.persona, subject: d.subject, body: d.body } });
  } catch (e) {
    if (e instanceof BudgetError) return json({ error: "Daily AI budget reached. Try again tomorrow." }, 429);
    await log("error", "draft_failed", { account: a.domain, message: (e as Error).message });
    return json({ error: "Could not write the draft. Try again." }, 502);
  }
}

serve("queue", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = (await req.json().catch(() => null)) ?? {};
  const admin = await isAdmin(req);

  if (body.action === "list") return json({ ...(await list(String(body.view ?? "todo"), admin)), admin });
  if (body.action === "accounts") return json({ ...(await accountsView(admin)), admin });
  if (body.action === "meetings") return json({ ...(await meetingsView(admin)), admin });
  if (body.action === "debrief" && typeof body.meeting_id === "string") {
    const outcome = String(body.outcome) as Outcome;
    if (!(OUTCOMES as readonly string[]).includes(outcome)) return json({ error: "Unknown outcome" }, 400);
    const signed = typeof body.sig === "string" && (await verify(body.meeting_id, outcome, body.sig)); // the one-tap link from the email
    if (!admin && !signed) return json({ mode: "dry_run", message: "Demo mode: nothing was saved. Unlock to record a debrief." });
    const r = await applyDebrief(body.meeting_id, outcome, typeof body.notes === "string" ? body.notes : undefined);
    if ("error" in r) return json({ error: r.error }, 404);
    return json({ mode: "live", outcome, recap: r.recap, crm: r.crm, notes: (r.meeting as { notes?: string }).notes ?? null });
  }
  if (body.action === "loss_reason" && typeof body.account_id === "string") {
    if (!isLossReason(body.reason)) return json({ error: "Unknown reason" }, 400);
    const signed = typeof body.sig === "string" && (await verifyLoss(body.account_id, body.reason, body.sig)); // the one-tap link from the email
    if (!admin && !signed) return json({ mode: "dry_run", message: "Demo mode: nothing was saved. Unlock to record a loss reason." });
    const r = await applyLossReason(body.account_id, body.reason);
    return "error" in r ? json({ error: r.error }, 404) : json({ mode: "live", ...r });
  }
  if (body.action === "brand") return json(await loadBrand()); // public: it is only the name, tagline and logo
  if (body.action === "brand_save") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to change the look." });
    const b = cleanBrand(body.brand);
    await saveBrand(b);
    return json({ mode: "live", ...b });
  }
  if (body.action === "setup") return json({ ...(await setupView()), admin });
  if (body.action === "profile_save") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to save changes." });
    const next = clean(body.profile);
    // Each buyer type needs a "Scored persona" value in HubSpot: reuse a matching one, or add it there. Never blocks the save.
    if (Deno.env.get("HUBSPOT_TOKEN")) {
      for (const p of next.personas) p.hubspot = await ensurePersonaOption(p.title, p.hubspot).catch(() => p.hubspot);
    }
    await saveProfile(next);
    // The daily email time is kept in the schedule itself (IST in, UTC stored). Not part of the profile.
    const t = /^(\d{1,2}):(\d{2})$/.exec(String(body.digest_time_ist ?? ""));
    if (t) {
      const utc = (Number(t[1]) * 60 + Number(t[2]) - 330 + 1440) % 1440;
      await sb.rpc("cp_set_digest_time", { h: Math.floor(utc / 60), m: utc % 60 }).then((r) => { if (r.error) return log("warn", "digest_time_failed", { message: r.error.message }); });
    }
    const rescored = await enrichCompanies(true); // fit and weights changed: recompute every score (no credits)
    await rerankPeople(); // the buyer types may have changed: re-rank the people we already have (no credits)
    await log("info", "profile_saved", { detail: { rescored: rescored.rescored } });
    return json({ mode: "live", ...(await setupView()), rescored: rescored.rescored });
  }
  if (body.action === "profile_suggest") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to get suggestions." });
    const description = String(body.description ?? "").trim();
    if (description.length < 20) return json({ error: "Describe what you sell in a sentence or two first." }, 400);
    try {
      const r = await suggestProfile(await loadProfile(), description, clean({ product: { website: body.website } }).product.website);
      return json({ mode: "live", ...r });
    } catch (e) {
      if (e instanceof BudgetError) return json({ error: "Today's AI limit is reached. Try again tomorrow." }, 429);
      await log("error", "profile_suggest_failed", { message: (e as Error).message });
      return json({ error: "Could not make a suggestion. Try again." }, 502);
    }
  }
  if (body.action === "hubspot_refresh") {
    if (!admin) return json({ mode: "dry_run", message: "Owner only." }, 403);
    return json({ mode: "live", ...(await refreshAllFields({ dry: body.dry === true })) });
  }
  if (body.action === "not_fit" && typeof body.account_id === "string") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: nothing was changed. Unlock to mark a company as not a fit." });
    if (!isNotFitReason(body.reason)) return json({ error: "Unknown reason" }, 400);
    const r = await markNotFit(body.account_id, body.reason);
    return "error" in r ? json({ error: r.error }, 404) : json({ mode: "live", ...r });
  }
  if (body.action === "remove_account" || body.action === "restore_account") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: nothing was changed. Unlock to remove or restore companies." });
    if (typeof body.account_id !== "string") return json({ error: "account_id required" }, 400);
    const { data: a } = await sb.from("cp_accounts").select("id,domain,outreach_status").eq("id", body.account_id).maybeSingle();
    if (!a) return json({ error: "Account not found" }, 404);
    const restoring = body.action === "restore_account";
    if (!restoring && ["contacted", "replied", "meeting"].includes(a.outreach_status)) return json({ error: "You have already been in touch with this company. Use Not now or Not a fit instead." }, 400);
    if (restoring) await sb.from("cp_accounts").update({ removed_at: null }).eq("id", a.id);
    else await sb.rpc("cp_purge_accounts", { ids: [a.id] }); // permanent: the company and everything about it are deleted; only the domain is remembered so it is not found again
    await log("info", restoring ? "account_restored" : "account_purged", { account: a.domain });
    return json({ mode: "live", ok: true });
  }
  if (body.action === "company" && typeof body.account_id === "string") return json(await companyView(body.account_id, admin) ?? { error: "Company not found" }, 200);
  if (body.action === "person_rows" && Array.isArray(body.ids)) return json({ admin, people: await peopleRows(admin, { personIds: body.ids.map(String).slice(0, 10) }) });
  if (body.action === "person_rows" && typeof body.account_id === "string") return json({ admin, people: await peopleRows(admin, { accountId: body.account_id, limit: 60 }) });
  if (body.action === "people_keep" && Array.isArray(body.ids)) { // add researched people to your People list (their company is already saved)
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to add people." });
    await sb.from("cp_people").update({ kept_at: new Date().toISOString() }).in("id", body.ids.map(String).slice(0, 20));
    return json({ mode: "live", ok: true });
  }
  if (body.action === "people_list") {
    const { people } = await peopleList(admin);
    // Companies we searched that returned nobody: shown so they are not searched again by mistake.
    const { data: s } = await sb.from("cp_accounts").select("id,name,domain,people_searched_at,people_search_source").not("people_searched_at", "is", null).is("removed_at", null).order("people_searched_at", { ascending: false }).limit(300);
    const have = new Set(people.map((p) => p.account_id));
    return json({ admin, people, nobody: (s ?? []).filter((x) => !have.has(x.id)).map((x) => ({ id: x.id, name: x.name, domain: x.domain, at: x.people_searched_at, by: x.people_search_source })), personas: icp.personas.map((p) => p.title) });
  }
  if (body.action === "discover_list") {
    const { data } = await sb.from("cp_discovered").select("domain,name,reason,source,source_url,snippet,category,found_at,status").eq("status", "rejected").is("hidden_at", null).order("found_at", { ascending: false }).limit(80);
    const [{ data: last }, { data: sp }, { data: all }] = await Promise.all([
      sb.from("cp_state").select("value").eq("key", "discovery_last").maybeSingle(),
      sb.from("cp_state").select("value").eq("key", "people_skipped").maybeSingle(),
      sb.from("cp_discovered").select("source,status").limit(5000),
    ]);
    const sources: Record<string, { added: number; skipped: number }> = {};
    for (const r of all ?? []) { const x = (sources[r.source] ??= { added: 0, skipped: 0 }); if (r.status === "added") x.added++; else if (r.status === "rejected") x.skipped++; }
    const parse = (v?: string | null) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
    const { count: unknownFit } = await sb.from("cp_accounts").select("id", { count: "exact", head: true }).is("firmo_at", null).is("removed_at", null);
    const { data: runRows } = await sb.from("cp_discovery_runs").select("id,started_at,trigger,summary").order("started_at", { ascending: false }).limit(15);
    const runIds = (runRows ?? []).map((r) => r.id);
    const { data: runItems } = runIds.length ? await sb.from("cp_discovered").select("domain,name,source,source_url,snippet,status,reason,category,account_id,run_id,found_at").in("run_id", runIds).is("hidden_at", null).limit(800) : { data: [] };
    const { data: runAccts } = (runItems ?? []).some((i) => i.account_id) ? await sb.from("cp_accounts").select(`id,name,domain,segment,removed_at,stage,hubspot_company_id,${FIT_COLS}`).in("id", (runItems ?? []).map((i) => i.account_id).filter(Boolean) as string[]) : { data: [] };
    const runs = (runRows ?? []).map((r) => ({
      id: r.id, at: r.started_at, trigger: r.trigger, summary: r.summary,
      added: (runItems ?? []).filter((i) => i.run_id === r.id && i.status === "added").map((i) => {
        const a = (runAccts ?? []).find((x) => x.id === i.account_id);
        return { domain: i.domain, name: i.name, source: i.source, source_url: i.source_url, why: i.reason, id: a && !a.removed_at ? a.id : null, deleted: !a || !!a.removed_at, fit: a ? fitState(a as never) : null, about: a?.segment ?? a?.industry_ai ?? null, industry: a?.industry_ai ?? a?.industry ?? null, country: a?.country ?? null, size: a?.employees ?? a?.employee_band ?? null, stage: a?.stage ?? null, in_hubspot: !!a?.hubspot_company_id, found_at: i.found_at };
      }),
      skipped: (runItems ?? []).filter((i) => i.run_id === r.id && i.status === "rejected").map((i) => ({ domain: i.domain, name: i.name, source: i.source, source_url: i.source_url, snippet: i.snippet, reason: i.reason, category: i.category, found_at: i.found_at })),
    }));
    const { data: addedLog } = await sb.from("cp_discovered").select("domain,source,found_at,account_id").eq("status", "added").not("account_id", "is", null).order("found_at", { ascending: false }).limit(30);
    const { data: addedAcc } = (addedLog ?? []).length ? await sb.from("cp_accounts").select(`id,name,domain,segment,removed_at,${FIT_COLS}`).in("id", (addedLog ?? []).map((r) => r.account_id)) : { data: [] };
    const addedRows = (addedLog ?? []).map((r) => { const a = (addedAcc ?? []).find((x) => x.id === r.account_id); return a && !a.removed_at ? { id: a.id, name: a.name, domain: a.domain, about: a.segment ?? a.industry_ai ?? null, fit: fitState(a as never), country: a.country ?? null, size: a.employees ?? a.employee_band ?? null, source: r.source, found_at: r.found_at } : null; }).filter(Boolean);
    const ready = await readyCount(); const capacity = { ready, ...capacityMode({ ready, cap: todayCap(), icpChanged: false }) };
    return json({ admin, runs, added_rows: addedRows, capacity, unknown_fit: unknownFit ?? 0, skipped: data ?? [], report: parse(last?.value), people_skipped: parse(sp?.value), sources, enabled: (icp.discovery as { enabled?: boolean }).enabled !== false, web: (icp.discovery as { web?: boolean }).web !== false });
  }
  if (body.action === "discover_hide") { // take a skipped company or person off the list (the company is still remembered, so it is not looked at again)
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to remove." });
    if (typeof body.domain === "string") await sb.from("cp_discovered").update({ hidden_at: new Date().toISOString() }).eq("domain", body.domain);
    else if (typeof body.person_key === "string") {
      const { data: sp } = await sb.from("cp_state").select("value").eq("key", "people_skipped").maybeSingle();
      try { const v = JSON.parse(sp?.value ?? "{}"); v.items = (v.items ?? []).filter((x: { key: string }) => x.key !== body.person_key); await sb.from("cp_state").upsert({ key: "people_skipped", value: JSON.stringify(v), updated_at: new Date().toISOString() }); } catch { /* nothing to remove */ }
    }
    return json({ mode: "live", ok: true });
  }
  if (body.action === "discover_add" && typeof body.domain === "string") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to add a company." });
    const { data: d } = await sb.from("cp_discovered").select("domain,name,status").eq("domain", body.domain).maybeSingle();
    if (!d) return json({ error: "That company was not found" }, 404);
    const { data: have } = await sb.from("cp_accounts").select("id").eq("domain", d.domain).maybeSingle();
    let id = have?.id as string | undefined;
    if (!id) {
      const ins = await sb.from("cp_accounts").insert({ domain: d.domain, name: d.name ?? d.domain, source: "discovered", status: "new" }).select("id").single();
      if (ins.error || !ins.data) return json({ error: "Could not add it" }, 500);
      id = ins.data.id;
    }
    await sb.from("cp_discovered").update({ status: "added", account_id: id, reason: "Added by you after it was skipped" }).eq("domain", d.domain);
    return json({ mode: "live", id, name: d.name });
  }
  if (body.action === "usage_log") {
    if (!admin) return json({ mode: "dry_run", message: "Owner only." }, 403);
    const { data } = await sb.from("cp_provider_usage").select("provider,action,credits,account,created_at").order("created_at", { ascending: false }).limit(25);
    return json({ log: data ?? [] });
  }
  if (body.action === "icp_insights") {
    if (!admin) return json({ mode: "dry_run", message: "Owner only." }, 403);
    return json({ mode: "live", ...(await customerInsights()) });
  }
  if (body.action === "ai_rescore") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: the owner can score with AI." });
    if (typeof body.account_id === "string") { // one company, judged again now (the people there too)
      try { await aiScoreCompany(body.account_id, true); await aiScorePeople(body.account_id, true); } catch (e) { return json({ error: e instanceof BudgetError ? "Today's AI limit is reached." : "Could not score it." }, 429); }
      return json({ mode: "live", companies: 1 });
    }
    const ids = await candidates(60);
    const have = await aiMaps("company", ids);
    const todo = ids.filter((id) => !have.has(id)).slice(0, 25);
    if (body.dry !== false) return json({ mode: "plan", companies: todo.length, cost_usd: +(todo.length * 0.003).toFixed(3) });
    return json({ mode: "live", ...(await aiRefresh({ ids: todo, maxCompanies: 25, maxPeopleCompanies: 25 })) });
  }
  if (body.action === "fit_judge") { // AI fit verdicts: dry shows how many are waiting (profile changed or never judged)
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: the owner can run this." });
    const { count } = await sb.from("cp_accounts").select("id", { count: "exact", head: true }).is("removed_at", null).is("fit_override", null).or(`fit_ai_ver.is.null,fit_ai_ver.neq.${icpVersion()}`);
    if (body.dry !== false) return json({ mode: "plan", waiting: count ?? 0, cost_usd: +(Math.min(count ?? 0, 25) * 0.0015).toFixed(3) });
    if (typeof body.account_id === "string") return json({ mode: "live", result: await judgeFit(body.account_id, true), rescored: (await enrichCompanies(true)).rescored });
    const r = await judgeMany(25);
    return json({ mode: "live", ...r, rescored: (await enrichCompanies(true)).rescored });
  }
  if (body.action === "fit_override" && typeof body.account_id === "string") { // the owner's word beats the AI and the rules; null clears it
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to change a company's fit." });
    const v = body.value === "yes" || body.value === "no" ? body.value : null;
    await sb.from("cp_accounts").update({ fit_override: v, fit_override_note: v ? String(body.note ?? "").slice(0, 200) : null }).eq("id", body.account_id);
    await sb.from("cp_outcomes").insert({ account_id: body.account_id, kind: `fit_override_${v ?? "cleared"}`, note: String(body.note ?? "").slice(0, 200) }).then(() => {}, () => {});
    return json({ mode: "live", rescored: (await enrichCompanies(true)).rescored });
  }
  if (body.action === "industry_check") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: the owner can run this." });
    const ids = typeof body.account_id === "string" ? [body.account_id] : await needIndustry(30);
    if (body.dry !== false) return json({ mode: "plan", companies: ids.length, cost_usd: +(ids.length * 0.0015).toFixed(3) });
    const r = await industryCheckMany(ids);
    const rescored = (await enrichCompanies(true)).rescored; // fit follows the new industries (no credits)
    return json({ mode: "live", ...r, rescored });
  }
  if (body.action === "peek_bulk") { // free: who works at the companies worth working that have nobody listed yet
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to look up people." });
    const list = await peekCandidates(typeof body.limit === "number" ? Math.min(60, body.limit) : 40);
    if (body.dry === true) return json({ mode: "plan", companies: list.length, names: list.slice(0, 8).map((a) => a.name) });
    return json({ mode: "live", ...(await peekPeople(list)) });
  }
  if (body.action === "watchlist") return json({ ...(await watchlistView(admin)), admin });
  if (body.action === "watch_toggle" && (typeof body.account_id === "string" || typeof body.person_id === "string")) {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to follow companies and people." });
    const r = typeof body.person_id === "string" ? await setPersonWatched(body.person_id, body.on !== false) : await setWatched(body.account_id as string, body.on !== false);
    return "error" in r ? json({ error: r.error }, 400) : json({ mode: "live", ok: true });
  }
  if (body.action === "watch_check" && (body.kind === "company" || body.kind === "person") && typeof body.id === "string") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to check now." });
    if (body.dry === true) return json({ mode: "plan", cost: body.kind === "person" ? "about 5 cents of AI" : "free" });
    try { return json({ mode: "live", ...(await checkNow(body.kind, body.id)) }); } catch (e) { return json({ error: (e as Error).message }, e instanceof BudgetError ? 429 : 500); }
  }
  if (body.action === "watch_notify") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to change this." });
    const ok = (body.kind === "company" || body.kind === "person") && typeof body.id === "string" && (await setNotify(body.kind, body.id, String(body.notify)));
    return ok ? json({ mode: "live", ok: true }) : json({ error: "Could not save that." }, 400);
  }
  if (body.action === "watch_seen") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode." });
    await markSeen();
    return json({ mode: "live", ok: true });
  }
  if (body.action === "watch_add_person") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to follow people." });
    const r = await addPersonToWatchlist({ name: String(body.name ?? ""), domain: String(body.domain ?? ""), title: typeof body.title === "string" ? body.title : "" });
    return "error" in r ? json({ error: r.error }, 400) : json({ mode: "live", ...r });
  }
  if (body.action === "watch_add") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to add companies." });
    const r = await addToWatchlist(String(body.domain ?? ""));
    return "error" in r ? json({ error: r.error }, 400) : json({ mode: "live", ...r });
  }
  if (body.action === "purge_removed") { // empties the Removed tab for good (companies removed before removing became permanent)
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: nothing was changed." });
    const { data } = await sb.from("cp_accounts").select("id").not("removed_at", "is", null);
    const ids = (data ?? []).map((r) => r.id);
    if (ids.length) await sb.rpc("cp_purge_accounts", { ids });
    return json({ mode: "live", purged: ids.length });
  }
  if (body.action === "remove_low") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: nothing was changed. Unlock to remove companies." });
    // Only companies nobody has touched: below the bar, still open, not in HubSpot, no people stored.
    const v = await accountsView(true);
    const ids = v.accounts.filter((a) => a.low && !a.removed && a.outreach_status === "open" && !a.hubspot && !a.contacts.length && !a.lost_at).map((a) => a.id);
    if (body.dry !== false) return json({ mode: "plan", count: ids.length, names: v.accounts.filter((a) => ids.includes(a.id)).slice(0, 8).map((a) => a.name) });
    if (ids.length) await sb.rpc("cp_purge_accounts", { ids });
    await log("info", "accounts_removed_bulk", { detail: { count: ids.length } });
    return json({ mode: "live", removed: ids.length });
  }
  if (body.action === "clean_signals") {
    if (!admin) return json({ mode: "dry_run", message: "Owner only." }, 403);
    const dry = body.dry !== false; // a dry run unless the owner says otherwise
    const report = await cleanSignals({ dry, ai: body.ai === true });
    const rescored = dry ? null : (await enrichCompanies(true)).rescored; // scores follow the cleaned signals (no credits)
    return json({ mode: "live", ...report, rescored });
  }
  if (body.action === "pl_refresh" && typeof body.account_id === "string") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: the owner can check an account's news (uses 1 of the monthly PredictLeads calls)." });
    return json({ mode: "live", ...(await refreshFromPredictLeads(body.account_id, "manual")) });
  }
  if (body.action === "health") {
    if (!admin) return json({ mode: "dry_run", message: "Owner only." }, 403);
    return json({ mode: "live", ...(await healthView()) });
  }
  if (body.action === "health_check") {
    if (!admin) return json({ mode: "dry_run", message: "Owner only." }, 403);
    return json({ mode: "live", checks: await checkConnections() });
  }
  if (body.action === "run_discovery") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: the owner can run discovery." });
    const out = await runDiscovery({ dry: body.dry === true, firmo: body.firmo !== false, web: body.web === true ? true : body.web === false ? false : undefined });
    if (body.dry !== true) await markDiscoveryVersion();
    return json({ mode: "live", ...out });
  }
  if (body.action === "draft" && typeof body.account_id === "string") return await draft(body.account_id, admin);
  if (body.action === "enrich_company" && typeof body.account_id === "string") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: the owner can look up company size and stage (0.2 search credit)." });
    return json({ mode: "live", ...(await enrichCompanies(false, [body.account_id])) });
  }
  if (body.action === "find_people_bulk") {
    if (!admin) return json({ mode: "dry_run", message: "Owner only." }, 403);
    const plan = await planBulkFind(Number(body.limit) || 5);
    if (body.dry !== false) return json({ mode: "live", dry: true, ...plan });
    const run = await runBulkFind(plan.plan);
    return json({ mode: "live", dry: false, ...run, spent: run.done.reduce((a, d) => a + d.credits, 0) });
  }
  if (body.action === "guard_people") {
    if (!admin) return json({ mode: "dry_run", message: "Owner only." }, 403);
    return json({ mode: "live", ...(await guardPeople({ limit: 200 })) });
  }
  if (body.action === "refresh_facts") {
    if (!admin) return json({ mode: "dry_run", message: "Owner only." }, 403);
    return json({ mode: "live", ...(await refreshFacts(Number(body.limit) || 10, body.dry !== false)) });
  }
  if (body.action === "enrich_companies") {
    if (!admin) return json({ mode: "dry_run", message: "Owner only." }, 403);
    return json({ mode: "live", ...(await enrichCompanies(body.rescore === true)) });
  }
  if (body.action === "today") return json({ ...(await buildToday(admin)), attention: admin ? await activeFlags(5) : { items: [], total: 0 }, admin });
  if (body.action === "board") {
    const b = await buildBoard(admin);
    return json({ ...b, personas: icp.personas.map((p) => p.title), attention: admin ? await activeFlags(5) : { items: [], total: 0 }, admin });
  }
  if (body.action === "todo_set" && typeof body.person_id === "string") { // pin a person to the board, set them aside, or clear it
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to change your to-do." });
    const state = body.state === "pinned" || body.state === "dismissed" ? body.state : null;
    await sb.from("cp_people").update({ todo_state: state, todo_at: state ? new Date().toISOString() : null, ...(state === "pinned" ? { kept_at: new Date().toISOString() } : {}) }).eq("id", body.person_id);
    return json({ mode: "live", ok: true });
  }
  if (body.action === "signals_feed") return json(await signalsFeed(admin, typeof body.days === "number" ? Math.min(90, Math.max(1, body.days)) : 30));
  if (body.action === "notes_list" && typeof body.person_id === "string") return json({ admin, notes: admin ? await listNotes(body.person_id) : [] });
  if (body.action === "note_add" && typeof body.person_id === "string" && typeof body.text === "string") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to add notes." });
    const text = body.text.trim();
    if (!text) return json({ error: "Write something first" }, 400);
    await addNote(body.person_id, "note", text);
    return json({ mode: "live", notes: await listNotes(body.person_id) });
  }
  if (body.action === "person_persona" && typeof body.person_id === "string") { // set the buyer type by hand, or mark someone as not a buyer
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to change this." });
    const want = typeof body.persona === "string" ? body.persona : null;
    const persona = want ? icp.personas.find((p) => p.title === want) : null;
    if (want && !persona) return json({ error: "That buyer type does not exist" }, 400);
    await sb.from("cp_people").update(persona ? { persona: persona.title, relevance: Math.min(100, Math.round((persona as { weight?: number }).weight ?? 70)), persona_manual: true } : want === "" ? { persona: null, relevance: 0, persona_manual: true } : { persona_manual: false }).eq("id", body.person_id);
    if (!persona && want !== "") await rerankPeople(); // back to the automatic rule
    await addNote(body.person_id, "buyer", persona ? `Buyer type set to ${persona.title}` : want === "" ? "Marked as not a buyer" : "Back to the automatic buyer match");
    return json({ mode: "live", ok: true });
  }
  if (body.action === "person_suppress" && typeof body.person_id === "string") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to do this." });
    const r = await suppressPerson(body.person_id, typeof body.reason === "string" ? body.reason : undefined);
    return r.ok ? json({ mode: "live", label: r.label }) : json({ error: "Person not found" }, 404);
  }
  if (body.action === "person_export" && typeof body.person_id === "string") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to download." });
    const d = await exportPerson(body.person_id);
    return d ? json({ mode: "live", data: d }) : json({ error: "Person not found" }, 404);
  }
  if (body.action === "suppressed_list") {
    if (!admin) return json({ admin, items: [] });
    const { data } = await sb.from("cp_suppressed").select("id,label,reason,created_at").order("created_at", { ascending: false }).limit(200);
    return json({ admin, items: data ?? [] });
  }
  if (body.action === "suppressed_remove" && typeof body.id === "string") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to do this." });
    await sb.from("cp_suppressed").delete().eq("id", body.id);
    return json({ mode: "live", ok: true });
  }
  if (body.action === "reveal_top") { // reveal the best free-list people in one go, with the cost shown first
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to reveal." });
    const limit = Math.max(1, Math.min(10, Number(body.limit) || 5));
    const rows = (await peopleRows(true)).filter((p) => p.preview && ["hot", "warm"].includes(p.lead.label) && p.company_fit !== "outside").sort((a, b) => b.priority - a.priority).slice(0, limit);
    const bal = await hunterBalance();
    const left = Math.max(0, Math.floor(HUNTER_MONTHLY_CAP - (await monthlyUsed()))); // the monthly limit you set, not the whole plan
    if (body.dry !== false) return json({ mode: "plan", people: rows.map((p) => ({ id: p.id, name: p.name, title: p.title, company: p.company })), credits: rows.length, credits_left: bal?.remaining ?? null, monthly_limit: HUNTER_MONTHLY_CAP, allowed: Math.min(rows.length, left) });
    const done: string[] = [];
    for (const p of rows.slice(0, left)) { const r = await revealPerson(p.id); if (!r.ok) { if (r.code === 429) break; continue; } done.push(p.id); }
    return json({ mode: "live", revealed: done.length });
  }
  if (body.action === "notifications") return admin ? json({ admin, ...(await listNotifications(40)) }) : json({ admin, items: [], unread: 0 });
  if (body.action === "notifications_read") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode." });
    await markRead(Array.isArray(body.ids) ? body.ids.map(String) : undefined);
    return json({ mode: "live", ok: true });
  }
  if (body.action === "flag_action" && typeof body.key === "string") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to snooze or dismiss." });
    const act = body.do === "dismiss" ? "dismiss" : "snooze";
    const ok = await flagAction(body.key, act, [1, 3, 7].includes(Number(body.days)) ? Number(body.days) : 3);
    return ok ? json({ mode: "live", ok: true }) : json({ error: "Could not update the flag" }, 500);
  }
  if (body.action === "outcome" && typeof body.account_id === "string") {
    const kind = String(body.kind) as OutcomeKind;
    if (!["contacted", "replied", "meeting", "snooze", "not_now", "reopen"].includes(kind)) return json({ error: "Unknown outcome" }, 400);
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: nothing was changed. Unlock to record actions." });
    const r = await applyOutcome(body.account_id, kind, { days: Number(body.days), note: typeof body.note === "string" ? body.note : undefined });
    return "error" in r ? json({ error: r.error }, 400) : json({ mode: "live", ...r.update, crm: r.crm });
  }
  if (body.action === "icp") return json(await playbook());
  return json({ error: "Unknown action" }, 400);
});
