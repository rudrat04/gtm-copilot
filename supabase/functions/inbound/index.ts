import { json, sb } from "../_shared/db.ts";
import { callerId, isAdmin, rateOk } from "../_shared/auth.ts";
import { log, serve } from "../_shared/log.ts";
import { LABEL_TEXT, processLead, validate } from "../_shared/inbound.ts";
import { applyOutcome } from "../_shared/lifecycle.ts";
import icp from "../_shared/icp.json" with { type: "json" };

// Public endpoint. A form (or a client's own form, as a webhook) posts the lead; the owner gets an email and a
// HubSpot to-do within about a minute. Actions "list" and "respond" power the Inbound tab.
const shortName = (n: string) => { const p = n.trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0]; };
const mask = (e: string) => `***@${e.split("@")[1]}`;

serve("inbound", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = (await req.json().catch(() => null)) ?? {};
  const admin = await isAdmin(req);

  if (body.action === "list") {
    const { data } = await sb.from("cp_leads").select("*").order("created_at", { ascending: false }).limit(40);
    const month = Date.now() - 30 * 86_400_000;
    const all = data ?? [];
    const answered = all.filter((l) => l.first_response_at && Date.parse(l.created_at) > month);
    const secs = answered.map((l) => (Date.parse(l.first_response_at) - Date.parse(l.alerted_at ?? l.created_at)) / 1000).sort((a, b) => a - b);
    return json({
      admin, sla_minutes: icp.inbound.slaMinutes, labels: LABEL_TEXT,
      stats: { last_30d: all.filter((l) => Date.parse(l.created_at) > month).length, waiting: all.filter((l) => l.status === "new" && l.label && l.label !== "not_fit").length, median_response_seconds: secs.length ? Math.round(secs[Math.floor(secs.length / 2)]) : null },
      leads: all.filter((l) => admin || l.label !== "not_fit").map((l) => ({
        id: l.id, created_at: l.created_at, name: admin ? l.name : shortName(l.name), email: admin ? l.email : mask(l.email), company: l.company ?? (l.domain ? l.domain.split(".")[0] : null), role: admin ? l.role : null,
        message: admin ? l.message : null, intent: l.intent, source: l.source, label: l.label, fit: l.fit, heat: l.heat, why: admin ? l.why : null, facts: l.facts, signals: l.top_signals,
        status: l.status, in_hubspot: !!l.hubspot_task_id, account_id: l.account_id, alerted_at: l.alerted_at,
        response_seconds: l.first_response_at ? Math.round((Date.parse(l.first_response_at) - Date.parse(l.alerted_at ?? l.created_at)) / 1000) : null,
      })),
    });
  }

  if (body.action === "respond" && typeof body.lead_id === "string") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to record a response." });
    const kind = String(body.kind);
    if (!["contacted", "replied", "closed"].includes(kind)) return json({ error: "Unknown action" }, 400);
    const { data: l } = await sb.from("cp_leads").select("id,account_id,first_response_at").eq("id", body.lead_id).maybeSingle();
    if (!l) return json({ error: "Lead not found" }, 404);
    await sb.from("cp_leads").update({ status: kind, first_response_at: l.first_response_at ?? new Date().toISOString() }).eq("id", l.id);
    let crm: unknown = null;
    if (l.account_id && kind !== "closed") {
      const r = await applyOutcome(l.account_id, kind === "replied" ? "replied" : "contacted", { note: "Inbound lead" });
      if ("crm" in r) crm = r.crm;
    }
    return json({ mode: "live", status: kind, crm });
  }

  // ---- A new lead ----
  if (typeof body.website === "string" && body.website.trim()) return json({ ok: true, label: "review", timeline: [] }); // honeypot: pretend it worked
  if (!admin) {
    const who = await callerId(req);
    if (!(await rateOk(`inbound:${who}`, 3600, icp.inbound.perHour)) || !(await rateOk("inbound:all", 3600, icp.inbound.allPerHour)) || !(await rateOk("inbound:day", 86400, icp.inbound.allPerDay))) {
      await log("warn", "inbound_rate_limited", { detail: { who } });
      return json({ error: "Too many submissions right now. Please try again in a little while." }, 429);
    }
  }
  const v = validate(body);
  if (!v.ok) return json({ error: v.error }, 400);
  const r = await processLead(v.lead);
  return json({ ok: true, id: r.id, label: r.label, label_text: LABEL_TEXT[r.label], duplicate: !!r.duplicate, timeline: r.timeline });
});
