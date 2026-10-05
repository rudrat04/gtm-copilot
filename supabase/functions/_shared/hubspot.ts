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

// ---- Custom company properties (created once; falls back to a note if the key lacks scope) ----

const CP_PROPS = [
  { name: "cp_icp_fit", label: "ICP fit score", type: "number", fieldType: "number" },
  { name: "cp_priority_score", label: "Signal priority score", type: "number", fieldType: "number" },
  { name: "cp_why_now", label: "Why now", type: "string", fieldType: "textarea" },
  { name: "cp_researched_at", label: "Researched at", type: "datetime", fieldType: "date" },
];

let propsReady: boolean | null = null;

export async function ensureProperties(): Promise<boolean> {
  if (propsReady !== null) return propsReady;
  const g = await hs("/crm/v3/properties/companies/groups", {
    method: "POST",
    body: JSON.stringify({ name: "account_copilot", label: "Account Copilot" }),
  }, [409, 403, 401]);
  if (!g.ok && g.status !== 409) {
    await log("warn", "hubspot_properties_unavailable", {
      message: "Could not create custom properties; dossier fields go into a note instead",
      detail: { status: g.status, hint: "Add the crm.schemas.companies.write scope to the HubSpot key" },
    });
    return (propsReady = false);
  }
  for (const p of CP_PROPS) {
    const r = await hs("/crm/v3/properties/companies", {
      method: "POST",
      body: JSON.stringify({ ...p, groupName: "account_copilot" }),
    }, [409]);
    if (!r.ok && r.status !== 409) return (propsReady = false);
  }
  return (propsReady = true);
}

// ---- Dossier JSON -> HubSpot. No AI is involved here. ----

export type Dossier = {
  summary?: string;
  icp_fit?: { score?: number; reasons?: string[] };
  why_now?: string;
  pains?: string[];
  talk_tracks?: { angle: string; opener: string }[];
  likely_buyers?: { persona: string; why: string }[];
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

export type CompanyInput = {
  name: string;
  domain: string;
  whyNow: string;
  icpFit?: number | null;
  priority?: number | null;
  dossier: Dossier | null;
  signals: SignalRow[];
};

export async function pushCompany(i: CompanyInput) {
  const found = await hs("/crm/v3/objects/companies/search", {
    method: "POST",
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: i.domain }] }], limit: 1 }),
  });
  if (!found.ok) throw new Error(`HubSpot search ${found.status}`);

  const withProps = await ensureProperties();
  const properties: Record<string, string> = { name: i.name, domain: i.domain };
  if (i.dossier?.summary) properties.description = i.dossier.summary;
  if (withProps) {
    if (i.icpFit != null) properties.cp_icp_fit = String(i.icpFit);
    if (i.priority != null) properties.cp_priority_score = String(i.priority);
    if (i.whyNow) properties.cp_why_now = i.whyNow;
    properties.cp_researched_at = new Date().toISOString();
  } else if (!i.dossier && i.whyNow) {
    properties.description = `Why now: ${i.whyNow}`;
  }

  let id: string = found.body.results?.[0]?.id;
  let created = false;
  if (id) {
    const u = await hs(`/crm/v3/objects/companies/${id}`, { method: "PATCH", body: JSON.stringify({ properties }) });
    if (!u.ok) throw new Error(`HubSpot update ${u.status}`);
  } else {
    const c = await hs("/crm/v3/objects/companies", {
      method: "POST",
      body: JSON.stringify({ properties: { ...properties, lifecyclestage: "lead" } }),
    });
    if (!c.ok) throw new Error(`HubSpot create ${c.status}: ${JSON.stringify(c.body).slice(0, 160)}`);
    id = c.body.id;
    created = true;
  }

  const noted = await addNote(dossierNoteHtml(i.dossier, i.signals, i.whyNow), id, 190);
  if (!noted) await log("warn", "hubspot_note_skipped", { account: i.domain, message: "Company saved but the note could not be attached" });
  await log("info", "hubspot_company_pushed", { account: i.domain, detail: { companyId: id, created, noted, custom_properties: withProps } });
  return { companyId: id, created, noted, customProperties: withProps };
}

export type ContactInput = {
  firstName: string;
  lastName: string;
  title: string;
  email: string;
  draftHtml?: string;
};

export async function pushContact(c: ContactInput, companyId: string, domain: string) {
  const found = await hs("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: c.email }] }], limit: 1 }),
  });
  if (!found.ok) throw new Error(`HubSpot contact search ${found.status}`);

  const properties = { firstname: c.firstName, lastname: c.lastName, jobtitle: c.title, email: c.email };
  let id: string = found.body.results?.[0]?.id;
  let created = false;
  if (id) {
    await hs(`/crm/v3/objects/contacts/${id}`, { method: "PATCH", body: JSON.stringify({ properties }) });
  } else {
    const r = await hs("/crm/v3/objects/contacts", {
      method: "POST",
      body: JSON.stringify({ properties: { ...properties, lifecyclestage: "lead", hs_lead_status: "NEW" } }),
    });
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
