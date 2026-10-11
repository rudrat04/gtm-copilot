// Creates the F1rstword custom columns in HubSpot (companies and contacts). Safe to re-run: existing ones are skipped.
// Needs HUBSPOT_TOKEN in .env with the crm.schema.companies.write and crm.schema.contacts.write scopes.
//   node scripts/hubspot-columns.mjs          create what is missing
//   node scripts/hubspot-columns.mjs --dry    only list what would be created
import { readFileSync } from "node:fs";

const env = Object.fromEntries(readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const TOKEN = env.HUBSPOT_TOKEN;
if (!TOKEN) { console.error("HUBSPOT_TOKEN is not set in .env"); process.exit(1); }
const dry = process.argv.includes("--dry");
const GROUP = "gtm_intelligence";

const opts = (pairs) => pairs.map(([value, label], i) => ({ value, label, displayOrder: i }));
const select = (name, label, pairs, description) => ({ name, label, type: "enumeration", fieldType: "select", options: opts(pairs), description });
const num = (name, label, description) => ({ name, label, type: "number", fieldType: "number", description });
const text = (name, label, description) => ({ name, label, type: "string", fieldType: "text", description });
const date = (name, label, description) => ({ name, label, type: "date", fieldType: "date", description });

const companies = [
  select("gtm_heat", "Heat", [["hot", "Hot"], ["warm", "Warm"], ["watching", "Watching"]], "F1rstword: how warm the account is right now."),
  select("gtm_fit", "Fit", [["matches", "Fits"], ["close", "Partly fits"], ["unknown", "Fit unknown"], ["outside", "Outside range"]], "F1rstword: does the company match the target profile (size, stage, region)."),
  select("gtm_outreach_status", "Outreach status", [["open", "Open"], ["contacted", "Contacted"], ["replied", "Replied"], ["meeting", "Meeting"], ["snoozed", "Snoozed"], ["not_now", "Not now"]], "F1rstword: where outreach stands."),
  num("gtm_touches", "Touches", "F1rstword: how many times we have reached out."),
  date("gtm_last_contacted_at", "Last contacted", "F1rstword: last outreach action."),
  date("gtm_next_followup_at", "Next follow-up", "F1rstword: when the next follow-up is due."),
  text("gtm_funding_stage", "Funding stage", "F1rstword: latest funding round type."),
  date("gtm_last_round_date", "Last round date", "F1rstword: date of the latest funding round."),
  text("gtm_employee_band", "Employee band", "F1rstword: company size range."),
  select("gtm_last_meeting_outcome", "Last meeting outcome", [["went_well", "Went well"], ["follow_up", "Needs a follow-up"], ["no_show", "No-show"], ["not_fit", "Not a fit"]], "F1rstword: how the last meeting went."),
  date("gtm_last_meeting_at", "Last meeting date", "F1rstword: date of the latest meeting."),
  date("gtm_won_at", "Won date", "F1rstword: when the deal was won."),
];
const contacts = [
  select("gtm_email_status", "Email status", [["valid", "Valid"], ["accept_all", "Accept-all"], ["unknown", "Unknown"]], "F1rstword: how sure we are the address works."),
  num("gtm_email_confidence", "Email confidence", "F1rstword: provider confidence for the address, 0 to 100."),
  select("gtm_lead_label", "Lead label", [["hot", "Hot lead"], ["warm", "Warm lead"], ["review", "Needs a look"], ["not_fit", "Not a fit"]], "F1rstword: how an inbound lead was routed."),
  select("gtm_lead_intent", "Lead intent", [["demo", "Demo"], ["pricing", "Pricing"], ["question", "Question"]], "F1rstword: what an inbound lead asked for."),
  text("gtm_utm_source", "UTM source", "F1rstword: where the inbound lead came from."),
  text("gtm_utm_medium", "UTM medium", "F1rstword: marketing medium of the inbound lead."),
  text("gtm_utm_campaign", "UTM campaign", "F1rstword: campaign of the inbound lead."),
  text("gtm_landing_page", "Landing page", "F1rstword: page the inbound lead landed on."),
  num("gtm_reply_minutes", "Reply time (minutes)", "F1rstword: minutes from the alert to the first response."),
];

async function call(path, init = {}) {
  const r = await fetch(`https://api.hubapi.com${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

let created = 0, existed = 0, failed = 0;
for (const [object, list] of [["companies", companies], ["contacts", contacts]]) {
  for (const p of list) {
    const have = await call(`/crm/v3/properties/${object}/${p.name}`);
    if (have.status === 200) { existed++; console.log(`  exists   ${object}.${p.name}`); continue; }
    if (dry) { console.log(`  would create ${object}.${p.name} (${p.label})`); continue; }
    const r = await call(`/crm/v3/properties/${object}`, { method: "POST", body: JSON.stringify({ ...p, groupName: GROUP }) });
    if (r.status === 201) { created++; console.log(`  created  ${object}.${p.name}`); } else { failed++; console.log(`  FAILED   ${object}.${p.name} (${r.status}) ${String(r.body.message ?? "").slice(0, 120)}`); }
  }
}
console.log(`\ncreated ${created}, already there ${existed}, failed ${failed}`);
process.exit(failed ? 1 : 0);
