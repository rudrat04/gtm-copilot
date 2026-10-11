import { sb } from "./db.ts";
import { log } from "./log.ts";
import { applyCompanyExtras, applyContactExtras, type Extras } from "./hubspot.ts";
import icp from "./icp.json" with { type: "json" };

// Fills the extra HubSpot columns from data we already hold. Two kinds of field:
//  - "always": ours to keep current (signals, status, summary, sync times). Overwritten on every refresh.
//  - "blankOnly": facts a person may also edit in HubSpot (employees, city...). Only written when HubSpot has nothing there.
// The owner is also only set when blank, so it never takes a record from someone else.

type SigRow = { kind: string; title: string; url: string | null; detail: Record<string, unknown> | null; detected_at: string };
type Acct = {
  id: string; name: string; domain: string; employees: number | null; country: string | null; hq_city: string | null; founded_year: number | null;
  raised_usd: number | null; source: string | null; outreach_status: string; lost_at: string | null; won_at: string | null; why_now: string | null;
  firmo_at: string | null; last_scanned_at: string | null;
};

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
const iso = (v: string | null | undefined) => { const t = v ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : new Date(t).toISOString(); };

/** Our lifecycle expressed in HubSpot's account/contact status values (new, prospecting, qualified, engaged, nurture, customer, closed_lost). */
export function hsStatus(a: { outreach_status: string; lost_at: string | null; won_at: string | null }): string {
  if (a.won_at) return "customer";
  if (a.lost_at && ["not_now", "open"].includes(a.outreach_status)) return "closed_lost";
  switch (a.outreach_status) {
    case "contacted": return "prospecting";
    case "replied": return "engaged";
    case "meeting": return "qualified";
    case "snoozed": case "not_now": return "nurture";
    default: return "new";
  }
}

/** Our source labels onto the options HubSpot knows (apollo, clay, website, demo_form, event, linkedin_campaign, hubspot, csv, api). */
export function hsSource(source: string | null): string {
  return source === "inbound" ? "demo_form" : source === "hubspot" ? "hubspot" : "api";
}

export const countryName = (code: string | null): string | null => {
  if (!code) return null;
  if (code.length !== 2) return code;
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code; } catch { return code; }
};

/** Newest real signal (a news item or a newly posted role), the open sales roles count, and the newest news headline. */
export function signalFacts(rows: SigRow[]) {
  const isSummary = (s: SigRow) => s.kind === "hiring" && !!s.detail && "salesOpenings" in s.detail;
  const when = (s: SigRow) => { const p = s.kind === "news" && s.detail?.published ? Date.parse(String(s.detail.published)) : NaN; return Number.isNaN(p) ? Date.parse(s.detected_at) : p; };
  const real = rows.filter((s) => s.kind === "news" || (s.kind === "hiring" && !isSummary(s))).sort((a, b) => when(b) - when(a));
  const latest = real[0] ?? null;
  const summary = rows.filter(isSummary).sort((a, b) => Date.parse(b.detected_at) - Date.parse(a.detected_at))[0];
  const news = real.find((s) => s.kind === "news") ?? null;
  const funding = (t: string) => /\b(raises?|raised|funding|series [a-e]|seed|round)\b/i.test(t);
  return {
    latest,
    latestAt: latest ? new Date(when(latest)).toISOString() : null,
    latestType: latest ? (latest.kind === "hiring" ? "SALES_HIRING" : funding(latest.title) ? "FUNDING" : null) : null,
    openRoles: summary && typeof summary.detail?.salesOpenings === "number" ? summary.detail.salesOpenings as number : null,
    news,
  };
}

const compact = (o: Record<string, string | null | undefined>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "")) as Record<string, string>;

export async function companyExtras(a: Acct): Promise<Extras> {
  const [{ data: sigs }, { data: dossier }] = await Promise.all([
    sb.from("cp_signals").select("kind,title,url,detail,detected_at").eq("account_id", a.id).order("detected_at", { ascending: false }).limit(60),
    sb.from("cp_dossiers").select("content").eq("account_id", a.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const f = signalFacts((sigs ?? []) as SigRow[]);
  const status = hsStatus(a);
  const summary = (dossier?.content as { summary?: string } | null)?.summary;
  const now = new Date().toISOString();
  return {
    always: compact({
      gtm_latest_signal_name: f.latest ? clip(f.latest.title, 250) : null,
      gtm_latest_signal_type: f.latestType,
      gtm_latest_signal_at: f.latestAt,
      gtm_hiring_open_roles: f.openRoles != null ? String(f.openRoles) : null,
      gtm_recent_news: f.news ? clip(f.news.title, 250) : null,
      gtm_ai_summary: summary ? clip(summary, 500) : null,
      gtm_outreach_angle: a.why_now ? clip(a.why_now, 250) : null,
      gtm_account_source: hsSource(a.source),
      gtm_account_status: status,
      gtm_account_stage: status,
      gtm_scoring_status: "SCORED",
      gtm_enriched_at: iso(a.firmo_at),
      gtm_last_evaluated_at: iso(a.last_scanned_at),
      gtm_last_synced_at: now,
    }),
    blankOnly: compact({
      numberofemployees: a.employees != null ? String(a.employees) : null,
      city: a.hq_city,
      country: countryName(a.country),
      founded_year: a.founded_year != null ? String(a.founded_year) : null,
      total_money_raised: a.raised_usd != null ? String(a.raised_usd) : null,
      website: a.domain ? `https://${a.domain}` : null,
      type: "PROSPECT",
    }),
    owner: icp.owner.hubspotOwnerId,
  };
}

export function contactExtras(p: { provider: string; linkedin_url: string | null; department: string | null }, a: Acct): Extras {
  const status = hsStatus(a);
  return {
    always: compact({
      gtm_contact_source: p.provider === "inbound" ? "demo_form" : "api",
      gtm_contact_status: status,
      gtm_contact_stage: status,
      gtm_recommended_outreach_angle: a.why_now ? clip(a.why_now, 250) : null,
      gtm_last_synced_at: new Date().toISOString(),
    }),
    blankOnly: compact({
      hs_linkedin_url: p.linkedin_url,
      job_function: p.department ? p.department.charAt(0).toUpperCase() + p.department.slice(1) : null,
    }),
    owner: icp.owner.hubspotOwnerId,
  };
}

const ACCT_COLS = "id,name,domain,employees,country,hq_city,founded_year,raised_usd,source,outreach_status,lost_at,won_at,why_now,firmo_at,last_scanned_at,hubspot_company_id";

/** Refreshes the extra columns on one account's HubSpot company and its pushed contacts. Never throws: HubSpot trouble is logged. */
export async function refreshAccountFields(accountId: string): Promise<{ company: boolean; contacts: number }> {
  const out = { company: false, contacts: 0 };
  try {
    const { data: a } = await sb.from("cp_accounts").select(ACCT_COLS).eq("id", accountId).maybeSingle();
    if (!a?.hubspot_company_id) return out;
    out.company = await applyCompanyExtras(a.hubspot_company_id, await companyExtras(a as Acct), a.domain);
    const { data: people } = await sb.from("cp_people").select("provider,linkedin_url,department,hubspot_contact_id").eq("account_id", accountId).not("hubspot_contact_id", "is", null);
    for (const p of people ?? []) if (await applyContactExtras(p.hubspot_contact_id!, contactExtras(p, a as Acct), a.domain)) out.contacts++;
  } catch (e) {
    await log("warn", "hubspot_fields_failed", { message: (e as Error).message, detail: { account: accountId } });
  }
  return out;
}

/** Owner action: refresh every pushed account (a batch at a time). `dry` only counts. */
export async function refreshAllFields(opts: { dry?: boolean; limit?: number } = {}) {
  const { data: rows } = await sb.from("cp_accounts").select("id,domain").not("hubspot_company_id", "is", null).order("last_touch_at", { ascending: false, nullsFirst: false }).limit(opts.limit ?? 40);
  const ids = (rows ?? []).map((r) => r.id);
  const { count: contacts } = await sb.from("cp_people").select("id", { count: "exact", head: true }).in("account_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]).not("hubspot_contact_id", "is", null);
  if (opts.dry) return { dry: true, companies: ids.length, contacts: contacts ?? 0 };
  let companies = 0, people = 0;
  for (const id of ids) { const r = await refreshAccountFields(id); if (r.company) companies++; people += r.contacts; }
  await log("info", "hubspot_fields_refreshed", { detail: { companies, contacts: people } });
  return { dry: false, companies, contacts: people };
}
