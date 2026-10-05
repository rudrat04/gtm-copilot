import { log } from "./log.ts";

const BASE = "https://api.hubapi.com";

async function hs(path: string, init: RequestInit = {}) {
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
  if (!res.ok) {
    await log("error", "hubspot_request_failed", {
      detail: { method: init.method ?? "GET", path: path.split("?")[0], status: res.status, body: text.slice(0, 300) },
    });
  }
  return { ok: res.ok, status: res.status, body };
}

export type PushInput = {
  name: string;
  domain: string;
  whyNow: string;
  persona: string;
  subject: string;
  draftBody: string;
};

/** Create (or reuse) the HubSpot company and attach the signal summary and draft as a note. */
export async function pushAccount(i: PushInput) {
  const existing = await hs("/crm/v3/objects/companies/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: i.domain }] }],
      limit: 1,
    }),
  });
  if (!existing.ok) throw new Error(`HubSpot search ${existing.status}`);

  let id: string = existing.body.results?.[0]?.id;
  let created = false;
  if (!id) {
    const c = await hs("/crm/v3/objects/companies", {
      method: "POST",
      body: JSON.stringify({
        properties: {
          name: i.name,
          domain: i.domain,
          lifecyclestage: "lead",
          description: `Why now: ${i.whyNow}`,
        },
      }),
    });
    if (!c.ok) throw new Error(`HubSpot create ${c.status}: ${JSON.stringify(c.body).slice(0, 160)}`);
    id = c.body.id;
    created = true;
  }

  // Note scope may be missing on some keys; the company record is still useful without it.
  let noted = false;
  const note = await hs("/crm/v3/objects/notes", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_note_body:
          `<p><b>Why now:</b> ${i.whyNow}</p><p><b>Suggested persona:</b> ${i.persona}</p>` +
          `<p><b>Draft (not sent):</b><br><b>${i.subject}</b><br>${i.draftBody.replace(/\n/g, "<br>")}</p>`,
      },
      associations: [{
        to: { id },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 190 }],
      }],
    }),
  });
  noted = note.ok;
  if (!noted) {
    await log("warn", "hubspot_note_skipped", { account: i.domain, message: "Company saved but the note could not be attached", detail: { status: note.status } });
  }
  await log("info", "hubspot_pushed", { account: i.domain, detail: { companyId: id, created, noted } });

  return { companyId: id, created, noted };
}
