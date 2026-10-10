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
    `<h3>Account Copilot dossier</h3>`,
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
    { key: "gtm_industry", label: "Fit industry", value: "b2b_saas" },
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
  const optional = ["hs_ideal_customer_profile", "gtm_industry", "gtm_last_scored_at"];

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
