import { log } from "./log.ts";

const BASE = "https://api.hubapi.com";

async function hs(path: string, init: RequestInit = {}, quiet: number[] = []) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${Deno.env.get("HUBSPOT_TOKEN")}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  // deno-lint-ignore no-explicit-any -- JSON payloads from external APIs
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch { /* non-JSON error page */ }
  if (!res.ok && !quiet.includes(res.status)) {
    await log("error", "hubspot_request_failed", {
      detail: { method: init.method ?? "GET", path: path.split("?")[0], status: res.status, body: text.slice(0, 300) },
    });
  }
  return { ok: res.ok, status: res.status, body };
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// ---- Dossier JSON -> HubSpot. No AI is involved here. ----

export type Dossier = {
  summary?: string;
  icp_fit?: { score?: number; reasons?: string[] };
  why_now?: string;
  pains?: string[];
  talk_tracks?: { angle: string; opener: string }[];
  risks?: string[];
};
export type SignalRow = { kind: string; title: string; url?: string | null };

const ul = (a?: string[]) => (a?.length ? `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "<p>None</p>");

export function dossierNoteHtml(d: Dossier | null, signals: SignalRow[], whyNow: string): string {
  if (!d) {
    return `<p><b>Why now:</b> ${esc(whyNow)}</p><h4>Signals</h4>${ul(signals.map((s) => `${s.kind}: ${s.title}`))}`;
  }
  return [
    `<h3>F1rstword dossier</h3>`,
    `<p>${esc(d.summary)}</p>`,
    `<p><b>ICP fit:</b> ${esc(d.icp_fit?.score ?? "n/a")} / 100</p>${ul(d.icp_fit?.reasons)}`,
    `<p><b>Why now:</b> ${esc(d.why_now ?? whyNow)}</p>`,
    `<h4>Likely pains</h4>${ul(d.pains)}`,
    `<h4>Talk tracks</h4>${ul((d.talk_tracks ?? []).map((t) => `${t.angle}: ${t.opener}`))}`,
    `<h4>Risks</h4>${ul(d.risks)}`,
    `<h4>Signals</h4>${ul(signals.slice(0, 10).map((s) => `${s.kind}: ${s.title}`))}`,
  ].join("");
}

async function addNote(html: string, toId: string, typeId: number): Promise<boolean> {
  const r = await hs("/crm/v3/objects/notes", {
    method: "POST",
    body: JSON.stringify({
      properties: { hs_timestamp: new Date().toISOString(), hs_note_body: html },
      associations: [{ to: { id: toId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }] }],
    }),
  }, [403, 401]);
  return r.ok;
}

// ---- Field mapping onto the existing HubSpot properties (gtm_* group + native ICP tier) ----

export type CompanyScores = {
  fit: number | null;       // from the dossier; blank until researched
  priority: number | null;
  signal: number | null;
  intent: number | null;
  tier: string;             // tier_1 | tier_2 | tier_3
  whyNow: string;
  whyFit: string;
  scoredAt: string | null;
};

export type CompanyInput = {
  name: string;
  domain: string;
  scores: CompanyScores;
  dossier: Dossier | null;
  signals: SignalRow[];
};

const TIER_LABEL: Record<string, string> = { tier_1: "Tier 1", tier_2: "Tier 2", tier_3: "Tier 3" };

/** Properties written to HubSpot, each with the label shown in the preview. */
export function companyFields(s: CompanyScores): { key: string; label: string; value: string }[] {
  const f: { key: string; label: string; value: string | number | null }[] = [
    { key: "gtm_fit_score", label: "Fit score", value: s.fit },
    { key: "gtm_priority_score", label: "Priority score", value: s.priority },
    { key: "gtm_signal_score", label: "Signal score", value: s.signal },
    { key: "gtm_intent_score", label: "Intent score", value: s.intent },
    { key: "hs_ideal_customer_profile", label: "ICP tier", value: s.tier },
    { key: "gtm_why_now", label: "Why now", value: s.whyNow || null },
    { key: "gtm_why_fit", label: "Why fit", value: s.whyFit || null },
    { key: "gtm_last_scored_at", label: "Last scored at", value: s.scoredAt },
  ];
  return f.filter((x) => x.value !== null && x.value !== "" && x.value !== undefined)
    .map((x) => ({ key: x.key, label: x.label, value: String(x.value) }));
}

export const tierLabel = (t: string) => TIER_LABEL[t] ?? t;

/** Try the full property set; if HubSpot rejects it (for example an option it does not know), retry without the optional keys. */
async function writeWithFallback(
  call: (props: Record<string, string>) => ReturnType<typeof hs>,
  props: Record<string, string>,
  optional: string[],
  account: string,
) {
  let r = await call(props);
  if (!r.ok && r.status === 400) {
    const stripped = Object.fromEntries(Object.entries(props).filter(([k]) => !optional.includes(k)));
    await log("warn", "hubspot_property_fallback", {
      account,
      message: "HubSpot rejected some properties; retrying without optional ones",
      detail: { optional, error: JSON.stringify(r.body).slice(0, 200) },
    });
    r = await call(stripped);
  }
  return r;
}

export async function pushCompany(i: CompanyInput) {
  const found = await hs("/crm/v3/objects/companies/search", {
    method: "POST",
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: i.domain }] }], limit: 1 }),
  });
  if (!found.ok) throw new Error(`HubSpot search ${found.status}`);

  const gtm = Object.fromEntries(companyFields(i.scores).map((f) => [f.key, f.value]));
  const optional = ["hs_ideal_customer_profile", "gtm_last_scored_at"];

  let id: string = found.body.results?.[0]?.id;
  let created = false;
  if (id) {
    // Existing company: refresh the scores only. Never touch lifecycle stage, owner or name.
    const u = await writeWithFallback(
      (props) => hs(`/crm/v3/objects/companies/${id}`, { method: "PATCH", body: JSON.stringify({ properties: props }) }),
      gtm, optional, i.domain,
    );
    if (!u.ok) throw new Error(`HubSpot update ${u.status}`);
  } else {
    const base: Record<string, string> = { name: i.name, domain: i.domain, lifecyclestage: "lead", ...gtm };
    if (i.dossier?.summary) base.description = i.dossier.summary;
    const c = await writeWithFallback(
      (props) => hs("/crm/v3/objects/companies", { method: "POST", body: JSON.stringify({ properties: props }) }),
      base, optional, i.domain,
    );
    if (!c.ok) throw new Error(`HubSpot create ${c.status}: ${JSON.stringify(c.body).slice(0, 160)}`);
    id = c.body.id;
    created = true;
  }

  const noted = await addNote(dossierNoteHtml(i.dossier, i.signals, i.scores.whyNow), id, 190);
  if (!noted) await log("warn", "hubspot_note_skipped", { account: i.domain, message: "Company saved but the note could not be attached" });
  await log("info", "hubspot_company_pushed", { account: i.domain, detail: { companyId: id, created, noted, fields: Object.keys(gtm) } });
  return { companyId: id, created, noted };
}

export type ContactInput = {
  firstName: string;
  lastName: string;
  title: string;
  email: string;
  persona: string | null;   // HubSpot option value: sales_leader | revops | Founder
  personaScore: number;
  draftHtml?: string;
};

export async function pushContact(c: ContactInput, companyId: string, domain: string) {
  const found = await hs("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: c.email }] }], limit: 1 }),
  });
  if (!found.ok) throw new Error(`HubSpot contact search ${found.status}`);

  const props: Record<string, string> = {
    firstname: c.firstName,
    lastname: c.lastName,
    jobtitle: c.title,
    email: c.email,
    gtm_persona_score: String(Math.min(100, c.personaScore)),
  };
  if (c.persona) props.gtm_persona = c.persona;

  let id: string = found.body.results?.[0]?.id;
  let created = false;
  if (id) {
    // Existing contact: update title and persona fields only.
    const { email: _e, ...rest } = props;
    await writeWithFallback((p) => hs(`/crm/v3/objects/contacts/${id}`, { method: "PATCH", body: JSON.stringify({ properties: p }) }), rest, ["gtm_persona"], domain);
  } else {
    const r = await writeWithFallback(
      (p) => hs("/crm/v3/objects/contacts", { method: "POST", body: JSON.stringify({ properties: p }) }),
      { ...props, lifecyclestage: "lead", hs_lead_status: "NEW" }, ["gtm_persona"], domain,
    );
    if (!r.ok) throw new Error(`HubSpot contact create ${r.status}`);
    id = r.body.id;
    created = true;
  }

  const link = await hs(`/crm/v4/objects/contacts/${id}/associations/default/companies/${companyId}`, { method: "PUT" });
  if (!link.ok) await log("warn", "hubspot_association_failed", { account: domain, detail: { status: link.status } });
  if (c.draftHtml) await addNote(c.draftHtml, id, 202);

  await log("info", "hubspot_contact_pushed", { account: domain, detail: { contactId: id, created, associated: link.ok } });
  return { contactId: id, created, associated: link.ok };
}

/** What HubSpot already knows about a meeting attendee and their company. Read-only. */
export async function lookupForBrief(email: string, domain: string | null) {
  const out: { company?: string; contact?: string; lastContacted?: string; deals?: number } = {};

  const c = await hs("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["firstname", "lastname", "jobtitle", "lifecyclestage", "hs_lead_status", "notes_last_contacted", "num_associated_deals"],
      limit: 1,
    }),
  }, [403, 401]);
  const contact = c.body.results?.[0]?.properties;
  if (contact) {
    out.contact = `Contact: ${[contact.firstname, contact.lastname].filter(Boolean).join(" ")} · ${contact.jobtitle ?? "no title"} · stage ${contact.lifecyclestage ?? "n/a"}${contact.hs_lead_status ? ` · ${contact.hs_lead_status}` : ""}`;
    if (contact.notes_last_contacted) out.lastContacted = contact.notes_last_contacted.slice(0, 10);
    out.deals = Number(contact.num_associated_deals ?? 0);
  }

  if (domain) {
    const co = await hs("/crm/v3/objects/companies/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: domain }] }],
        properties: ["name", "lifecyclestage", "notes_last_contacted", "num_associated_deals", "hs_ideal_customer_profile"],
        limit: 1,
      }),
    }, [403, 401]);
    const p = co.body.results?.[0]?.properties;
    if (p) {
      out.company = `Company: in HubSpot · stage ${p.lifecyclestage ?? "n/a"}${p.hs_ideal_customer_profile ? ` · ${p.hs_ideal_customer_profile.replace("_", " ")}` : ""}`;
      if (!out.lastContacted && p.notes_last_contacted) out.lastContacted = p.notes_last_contacted.slice(0, 10);
      out.deals = Math.max(out.deals ?? 0, Number(p.num_associated_deals ?? 0));
    }
  }
  return out;
}

export type CompanyRead = { id: string; owner: string | null; syncedAt: string | null };

/** Companies still in HubSpot, with owner and last sync time. An id that is missing from the result was deleted or archived. */
export async function readCompanies(ids: string[]): Promise<Map<string, CompanyRead>> {
  const out = new Map<string, CompanyRead>();
  for (let i = 0; i < ids.length; i += 100) {
    const r = await hs("/crm/v3/objects/companies/batch/read", { method: "POST", body: JSON.stringify({ properties: ["hubspot_owner_id", "gtm_last_synced_at"], inputs: ids.slice(i, i + 100).map((id) => ({ id })) }) }, [207]);
    for (const c of r.body.results ?? []) out.set(c.id, { id: c.id, owner: c.properties?.hubspot_owner_id || null, syncedAt: c.properties?.gtm_last_synced_at || null });
  }
  return out;
}

export type TaskInput = {
  subject: string;
  html: string;
  dueIso: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  ownerId: string;
  companyId?: string | null;
  contactId?: string | null;
};

/** Creates a to-do for the rep, optionally linked to a company and a contact. */
export async function createTask(t: TaskInput): Promise<string> {
  const associations = [] as { to: { id: string }; types: { associationCategory: string; associationTypeId: number }[] }[];
  if (t.companyId) associations.push({ to: { id: t.companyId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 192 }] });
  if (t.contactId) associations.push({ to: { id: t.contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 204 }] });
  const r = await hs("/crm/v3/objects/tasks", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        hs_task_subject: t.subject.slice(0, 250),
        hs_task_body: t.html,
        hs_timestamp: t.dueIso,
        hs_task_status: "NOT_STARTED",
        hs_task_priority: t.priority,
        hs_task_type: "TODO",
        hubspot_owner_id: t.ownerId,
      },
      associations,
    }),
  });
  if (!r.ok) throw new Error(`HubSpot task ${r.status}`);
  return r.body.id;
}

// ---- Status sync: lead status, notes, deals (only ever on records F1rstword created) ----

export type LeadStatus = "NEW" | "OPEN" | "IN_PROGRESS" | "OPEN_DEAL" | "UNQUALIFIED" | "ATTEMPTED_TO_CONTACT" | "CONNECTED" | "BAD_TIMING";
export type DealStage = "appointmentscheduled" | "qualifiedtobuy" | "closedlost";

export async function setLeadStatus(contactId: string, status: LeadStatus): Promise<boolean> {
  const r = await hs(`/crm/v3/objects/contacts/${contactId}`, { method: "PATCH", body: JSON.stringify({ properties: { hs_lead_status: status } }) });
  return r.ok;
}

/** A note on the company (and optionally the contact), as plain HTML. */
export async function logNote(html: string, ids: { companyId?: string | null; contactId?: string | null }): Promise<boolean> {
  let ok = true;
  if (ids.companyId) ok = (await addNote(html, ids.companyId, 190)) && ok;
  if (ids.contactId) ok = (await addNote(html, ids.contactId, 202)) && ok;
  return ok;
}

export async function createDeal(d: { name: string; stage: DealStage; companyId: string; contactId?: string | null; ownerId: string }): Promise<string> {
  const associations = [{ to: { id: d.companyId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 341 }] }] as { to: { id: string }; types: { associationCategory: string; associationTypeId: number }[] }[];
  if (d.contactId) associations.push({ to: { id: d.contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] });
  const r = await hs("/crm/v3/objects/deals", {
    method: "POST",
    body: JSON.stringify({ properties: { dealname: d.name.slice(0, 200), dealstage: d.stage, pipeline: "default", hubspot_owner_id: d.ownerId }, associations }),
  });
  if (!r.ok) throw new Error(`HubSpot deal ${r.status}`);
  return r.body.id;
}

export async function moveDeal(dealId: string, stage: DealStage): Promise<boolean> {
  const r = await hs(`/crm/v3/objects/deals/${dealId}`, { method: "PATCH", body: JSON.stringify({ properties: { dealstage: stage } }) });
  return r.ok;
}

// ---- Extra columns (see hsfields.ts) ----

export type Extras = { always: Record<string, string>; blankOnly: Record<string, string>; owner?: string };
const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === "";

/** One PATCH with everything; if HubSpot rejects it (an option it does not know), retry one property at a time so a single bad value never blocks the rest. */
async function patchProps(path: string, props: Record<string, string>, domain: string): Promise<boolean> {
  if (!Object.keys(props).length) return true;
  const r = await hs(path, { method: "PATCH", body: JSON.stringify({ properties: props }) }, [400]);
  if (r.ok) return true;
  if (r.status !== 400) return false;
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    const one = await hs(path, { method: "PATCH", body: JSON.stringify({ properties: { [k]: v } }) }, [400]);
    if (!one.ok) rejected.push(k);
  }
  if (rejected.length) await log("warn", "hubspot_extras_rejected", { account: domain, message: "HubSpot did not accept some columns", detail: { rejected } });
  return rejected.length < Object.keys(props).length;
}

async function applyExtras(kind: "companies" | "contacts", id: string, x: Extras, domain: string): Promise<boolean> {
  const keys = [...Object.keys(x.blankOnly), "hubspot_owner_id"];
  const cur = await hs(`/crm/v3/objects/${kind}/${id}?properties=${keys.join(",")}`, {}, [404]);
  if (!cur.ok) return false; // deleted in HubSpot, or unreachable
  const have = cur.body.properties ?? {};
  const props: Record<string, string> = { ...x.always };
  for (const [k, v] of Object.entries(x.blankOnly)) if (blank(have[k])) props[k] = v;
  if (x.owner && blank(have.hubspot_owner_id)) props.hubspot_owner_id = x.owner;
  return await patchProps(`/crm/v3/objects/${kind}/${id}`, props, domain);
}
export const applyCompanyExtras = (id: string, x: Extras, domain: string) => applyExtras("companies", id, x, domain);
export const applyContactExtras = (id: string, x: Extras, domain: string) => applyExtras("contacts", id, x, domain);

export type HsContact = { id: string; optedOut: boolean; bounced: boolean; lastContacted: string | null };

/** Which of these emails already exist as HubSpot contacts, and are they opted out or bouncing? Read-only. */
export async function lookupContactsByEmail(emails: string[]): Promise<Map<string, HsContact>> {
  const out = new Map<string, HsContact>();
  const list = [...new Set(emails.map((e) => e.toLowerCase()))];
  for (let i = 0; i < list.length; i += 90) {
    const r = await hs("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "IN", values: list.slice(i, i + 90) }] }],
        properties: ["email", "hs_email_optout", "hs_email_hard_bounce_reason_enum", "notes_last_contacted"], limit: 100,
      }),
    }, [400]);
    if (!r.ok) continue;
    for (const c of r.body.results ?? []) {
      const p = c.properties ?? {};
      if (!p.email) continue;
      out.set(String(p.email).toLowerCase(), {
        id: c.id, optedOut: String(p.hs_email_optout) === "true", bounced: !!p.hs_email_hard_bounce_reason_enum, lastContacted: p.notes_last_contacted || null,
      });
    }
  }
  return out;
}

/** Companies HubSpot marks as customers (lifecycle stage "customer"), so we never treat them as prospects. */
export async function readCustomerCompanies(limit = 100): Promise<{ id: string; domain: string | null }[]> {
  const r = await hs("/crm/v3/objects/companies/search", {
    method: "POST",
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "lifecyclestage", operator: "EQ", value: "customer" }] }], properties: ["domain"], limit }),
  });
  if (!r.ok) return [];
  return (r.body.results ?? []).map((c: { id: string; properties?: { domain?: string } }) => ({ id: c.id, domain: c.properties?.domain?.toLowerCase().replace(/^www\./, "") ?? null }));
}

/** Facts about the companies HubSpot knows as customers, for "what your customers look like". Read-only. */
export async function readCustomerFacts(limit = 100): Promise<{ domain: string | null; name: string | null; employees: number | null; industry: string | null; country: string | null }[]> {
  const r = await hs("/crm/v3/objects/companies/search", {
    method: "POST",
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "lifecyclestage", operator: "EQ", value: "customer" }] }], properties: ["domain", "name", "numberofemployees", "industry", "country"], limit }),
  });
  if (!r.ok) return [];
  // deno-lint-ignore no-explicit-any -- JSON payloads from external APIs
  return (r.body.results ?? []).map((c: any) => ({ domain: c.properties?.domain?.toLowerCase().replace(/^www\./, "") ?? null, name: c.properties?.name ?? null, employees: c.properties?.numberofemployees ? Number(c.properties.numberofemployees) : null, industry: c.properties?.industry ?? null, country: c.properties?.country ?? null }));
}

/** What HubSpot's own website tracking says about these contacts: their last visit and the last page. Empty if tracking is not installed. */
export async function readContactVisits(ids: string[]): Promise<Map<string, { lastVisit: string | null; lastUrl: string | null; pages: number }>> {
  const out = new Map<string, { lastVisit: string | null; lastUrl: string | null; pages: number }>();
  for (let i = 0; i < ids.length; i += 100) {
    const r = await hs("/crm/v3/objects/contacts/batch/read", { method: "POST", body: JSON.stringify({ properties: ["hs_analytics_last_visit_timestamp", "hs_analytics_last_url", "hs_analytics_num_page_views"], inputs: ids.slice(i, i + 100).map((id) => ({ id })) }) });
    if (!r.ok) continue;
    // deno-lint-ignore no-explicit-any -- JSON payloads from external APIs
    for (const c of r.body.results ?? [] as any[]) out.set(c.id, { lastVisit: c.properties?.hs_analytics_last_visit_timestamp ?? null, lastUrl: c.properties?.hs_analytics_last_url ?? null, pages: Number(c.properties?.hs_analytics_num_page_views ?? 0) });
  }
  return out;
}

/** The dropdown options of a HubSpot property, for the Setup page. */
export async function getPropertyOptions(object: "contacts" | "companies", name: string): Promise<{ value: string; label: string }[]> {
  const r = await hs(`/crm/v3/properties/${object}/${name}`, {}, [404]);
  return (r.ok ? r.body.options ?? [] : []).filter((o: { hidden?: boolean }) => !o.hidden).map((o: { value: string; label: string }) => ({ value: o.value, label: o.label }));
}

/**
 * The "Scored persona" value for a buyer type. An option that already matches (same value or label, or the keyword families
 * sales, revenue operations and founder) is reused; otherwise a new option is added to the HubSpot property. Null when HubSpot cannot be reached.
 */
export async function ensurePersonaOption(title: string, current: string | null): Promise<string | null> {
  const r = await hs("/crm/v3/properties/contacts/gtm_persona", {}, [404]);
  if (!r.ok) return current;
  // deno-lint-ignore no-explicit-any -- JSON from HubSpot
  const options: any[] = r.body.options ?? [];
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "persona";
  const t = title.toLowerCase();
  if (current && options.some((o) => o.value === current)) return current;
  const exact = options.find((o) => o.value === slug || String(o.label).toLowerCase() === t);
  if (exact) return exact.value;
  const family = /revops|revenue operations|sales operations/.test(t) ? "revops" : /founder|ceo|co-founder/.test(t) ? "Founder" : /sales|revenue|cro/.test(t) ? "sales_leader" : null;
  if (family && options.some((o) => o.value === family)) return family;
  const next = [...options.map((o, i) => ({ label: o.label, value: o.value, displayOrder: i, hidden: !!o.hidden })), { label: title.slice(0, 60), value: slug, displayOrder: options.length, hidden: false }];
  const u = await hs("/crm/v3/properties/contacts/gtm_persona", { method: "PATCH", body: JSON.stringify({ options: next }) }, [400, 403]);
  return u.ok ? slug : current;
}

/** Records why a deal we opened was lost. Only ever called for deals we created. */
export async function setDealLostReason(dealId: string, reason: string): Promise<boolean> {
  const r = await hs(`/crm/v3/objects/deals/${dealId}`, { method: "PATCH", body: JSON.stringify({ properties: { closed_lost_reason: reason.slice(0, 200) } }) }, [400]);
  return r.ok;
}

// ---- Reading HubSpot back ----

/** Status of our to-dos: id -> NOT_STARTED, IN_PROGRESS, COMPLETED... Deleted tasks are simply missing. */
export async function readTaskStatuses(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const r = await hs("/crm/v3/objects/tasks/batch/read", { method: "POST", body: JSON.stringify({ properties: ["hs_task_status"], inputs: ids.slice(i, i + 100).map((id) => ({ id })) }) }, [207]);
    for (const t of r.body.results ?? []) out.set(t.id, t.properties?.hs_task_status ?? "");
  }
  return out;
}

export type DealRead = { id: string; stage: string; lostReason: string | null; closedAt: string | null };

export async function readDeals(ids: string[]): Promise<Map<string, DealRead>> {
  const out = new Map<string, DealRead>();
  for (let i = 0; i < ids.length; i += 100) {
    const r = await hs("/crm/v3/objects/deals/batch/read", { method: "POST", body: JSON.stringify({ properties: ["dealstage", "closed_lost_reason", "closedate"], inputs: ids.slice(i, i + 100).map((id) => ({ id })) }) }, [207]);
    for (const d of r.body.results ?? []) out.set(d.id, { id: d.id, stage: d.properties?.dealstage ?? "", lostReason: d.properties?.closed_lost_reason || null, closedAt: d.properties?.closedate || null });
  }
  return out;
}

export type LostDeal = { dealId: string; name: string; reason: string | null; closedAt: string | null; companyId: string | null; companyName: string | null; domain: string | null };

/** Deals closed as lost (any pipeline), newest first, with their company. */
export async function searchLostDeals(limit = 50): Promise<LostDeal[]> {
  const r = await hs("/crm/v3/objects/deals/search", {
    method: "POST",
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "hs_is_closed_lost", operator: "EQ", value: "true" }] }], properties: ["dealname", "closed_lost_reason", "closedate"], sorts: [{ propertyName: "closedate", direction: "DESCENDING" }], limit }),
  });
  const deals = (r.body.results ?? []) as { id: string; properties: Record<string, string> }[];
  if (!deals.length) return [];
  const assoc = await hs("/crm/v4/associations/deals/companies/batch/read", { method: "POST", body: JSON.stringify({ inputs: deals.map((d) => ({ id: d.id })) }) }, [207]);
  const companyOf = new Map<string, string>();
  for (const a of assoc.body.results ?? []) if (a.to?.[0]) companyOf.set(a.from.id, String(a.to[0].toObjectId));
  const ids = [...new Set(companyOf.values())];
  const companies = new Map<string, { name: string | null; domain: string | null }>();
  if (ids.length) {
    const c = await hs("/crm/v3/objects/companies/batch/read", { method: "POST", body: JSON.stringify({ properties: ["name", "domain"], inputs: ids.map((id) => ({ id })) }) }, [207]);
    for (const x of c.body.results ?? []) companies.set(x.id, { name: x.properties?.name ?? null, domain: x.properties?.domain ?? null });
  }
  return deals.map((d) => {
    const cid = companyOf.get(d.id) ?? null;
    return { dealId: d.id, name: d.properties.dealname ?? "", reason: d.properties.closed_lost_reason || null, closedAt: d.properties.closedate || null, companyId: cid, companyName: cid ? companies.get(cid)?.name ?? null : null, domain: cid ? companies.get(cid)?.domain ?? null : null };
  });
}
