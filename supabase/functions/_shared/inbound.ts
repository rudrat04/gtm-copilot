import { sb } from "./db.ts";
import { log } from "./log.ts";
import { askClaude } from "./claude.ts";
import { collectSignals } from "./signals.ts";
import { fetchFirmo, firmoLine, fitPoints, saveFirmo } from "./firmo.ts";
import { fitState, heatOf, priorityScore, tierOf } from "./score.ts";
import { reasonLine } from "./today.ts";
import { createTask, pushCompany, pushContact } from "./hubspot.ts";
import { ownerEmail, sendMail } from "./google.ts";
import { button, esc, h2, layout, link, muted, quote } from "./emailhtml.ts";
import icp from "./icp.json" with { type: "json" };

// Inbound speed to lead. A form submit becomes: company identified, fit and signals checked, a label
// (hot / warm / review / not a fit), an email to the owner and a HubSpot to-do, in about a minute. Nothing
// is ever sent to the person who filled in the form.

const PAGE = "https://copilot.f1rstword.com/";
const FREEMAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com", "gmx.com", "zoho.com", "yandex.com", "mail.com"]);
const DISPOSABLE = new Set(["mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "yopmail.com", "trashmail.com", "sharklasers.com", "getnada.com"]);
const DAY = 86_400_000;

export type Intent = "demo" | "pricing" | "question";
export type LeadInput = { name: string; email: string; company?: string; role?: string; message?: string; intent: Intent; source: string };
export type Step = { step: string; detail: string; ms: number };
export type Label = "hot" | "warm" | "review" | "not_fit";

const LABEL_TEXT: Record<Label, string> = { hot: "Hot lead", warm: "Warm lead", review: "Needs a look", not_fit: "Not a fit" };
const INTENT_TEXT: Record<Intent, string> = { demo: "asked for a demo", pricing: "asked about pricing", question: "sent a question" };
const shortName = (n: string) => { const p = n.trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0]; };
const titleCase = (s: string) => s.replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function validate(raw: Record<string, unknown>): { ok: true; lead: LeadInput } | { ok: false; error: string } {
  const name = String(raw.name ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  const email = String(raw.email ?? "").trim().toLowerCase().slice(0, 120);
  if (name.length < 2) return { ok: false, error: "Please enter your name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, error: "Please enter a valid email address." };
  const message = String(raw.message ?? "").trim().slice(0, 1000);
  if ((message.match(/https?:\/\//g) ?? []).length > 2) return { ok: false, error: "That message looks like spam." };
  const intent = (["demo", "pricing", "question"] as const).find((i) => i === raw.intent) ?? "question";
  return { ok: true, lead: { name, email, company: String(raw.company ?? "").trim().slice(0, 80) || undefined, role: String(raw.role ?? "").trim().slice(0, 80) || undefined, message: message || undefined, intent, source: String(raw.source ?? "website").slice(0, 40) } };
}

/** Rules, no AI: how urgent is this person? */
export function labelFor(i: { business: boolean; disposable: boolean; intent: Intent; fit: string; heat: string }): Label {
  if (i.disposable || i.fit === "outside") return "not_fit";
  if (!i.business) return "review"; // a person with a personal address: worth a look, but nothing to look up
  if (i.intent === "demo" || i.intent === "pricing") return "hot";
  if (i.fit === "matches" && i.heat === "hot") return "hot";
  if (i.fit === "matches" || i.fit === "close") return "warm";
  return "review";
}

async function whyLine(l: LeadInput, ctx: { company: string; facts: string; fit: string; heat: string; signals: string[] }): Promise<string> {
  const fallback = `${l.name} ${INTENT_TEXT[l.intent]}${ctx.company ? ` at ${ctx.company}` : ""}.${ctx.signals[0] ? ` ${ctx.signals[0]}.` : ""}`.slice(0, 220);
  try {
    const raw = await askClaude({
      feature: "inbound-why",
      maxTokens: 120,
      system: `You write ONE sentence (max 28 words) telling a sales rep at ${icp.seller.name} why to answer this new inbound lead right now. ${icp.seller.pitch} Use only the facts given. No hype, no invented numbers, no greeting. Plain text, one sentence, finish it.`,
      user: `Lead: ${l.name}${l.role ? `, ${l.role}` : ""}; ${INTENT_TEXT[l.intent]}.\nMessage: ${l.message ?? "none"}\nCompany: ${ctx.company || "unknown (personal email)"}\nCompany facts: ${ctx.facts || "unknown"}\nFit: ${ctx.fit}. Heat: ${ctx.heat}.\nSignals: ${ctx.signals.join("; ") || "none"}`,
    });
    return raw.trim().replace(/^["']|["']$/g, "").slice(0, 240) || fallback;
  } catch {
    return fallback;
  }
}

export async function processLead(l: LeadInput): Promise<{ id: string; label: Label; timeline: Step[]; duplicate?: boolean }> {
  const t0 = Date.now();
  const timeline: Step[] = [];
  const mark = (step: string, detail: string) => timeline.push({ step, detail, ms: Date.now() - t0 });

  // The same person twice in a day is one lead.
  const { data: prior } = await sb.from("cp_leads").select("id,label,timeline").eq("email", l.email).gt("created_at", new Date(Date.now() - DAY).toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (prior) return { id: prior.id, label: (prior.label ?? "review") as Label, timeline: (prior.timeline as Step[]) ?? [], duplicate: true };

  const domain = l.email.split("@")[1];
  const business = !FREEMAIL.has(domain) && !DISPOSABLE.has(domain);
  const disposable = DISPOSABLE.has(domain);
  const { data: row } = await sb.from("cp_leads").insert({ name: l.name, email: l.email, domain: business ? domain : null, company: l.company ?? null, role: l.role ?? null, message: l.message ?? null, intent: l.intent, source: l.source }).select("id").single();
  const id = row!.id as string;
  mark("Received", `${INTENT_TEXT[l.intent]}`);

  let accountId: string | null = null, companyName = l.company ?? "", facts = "", fit = "unknown", heat = "watching", signalLines: string[] = [];
  let scores = { priority: null as number | null, tier: "tier_3", whyNow: "" };
  if (business) {
    // Find or create the company, look up its size and stage, and read its public signals.
    let { data: acct } = await sb.from("cp_accounts").select("*").eq("domain", domain).maybeSingle();
    if (!acct) {
      const ins = await sb.from("cp_accounts").insert({ domain, name: l.company || titleCase(domain.split(".")[0]), source: "inbound", status: "new" }).select("*").single();
      acct = ins.data;
    }
    if (acct) {
      accountId = acct.id; companyName = acct.name;
      if (!acct.firmo_at) {
        const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
        const { count } = await sb.from("cp_provider_usage").select("id", { count: "exact", head: true }).eq("provider", "hunter").eq("action", "company_enrich").gte("created_at", dayStart.toISOString());
        if ((count ?? 0) < icp.inbound.firmoPerDay) {
          const f = await fetchFirmo(domain).catch(() => null);
          if (f) { await saveFirmo(acct.id, f); acct = (await sb.from("cp_accounts").select("*").eq("id", acct.id).single()).data ?? acct; }
        }
      }
      facts = firmoLine(acct);
      mark("Company identified", `${companyName}${facts ? ` · ${facts}` : ""}`);

      const { signals } = await collectSignals(acct.name, domain, acct.segment ?? "");
      if (signals.length) {
        await sb.from("cp_signals").upsert(signals.map((s) => ({ account_id: acct!.id, kind: s.kind, title: s.title.slice(0, 300), url: s.url, detail: s.detail ?? {} })), { onConflict: "account_id,kind,title", ignoreDuplicates: true });
      }
      const sc = priorityScore(signals, fitPoints(acct));
      const upd: Record<string, unknown> = { priority_score: sc.score, last_scanned_at: new Date().toISOString() };
      if (acct.status === "new" && sc.score >= 30) { upd.status = "queued"; upd.why_now = reasonLine(signals as never); }
      await sb.from("cp_accounts").update(upd).eq("id", acct.id);
      fit = fitState(acct);
      heat = heatOf(signals.map((s) => ({ kind: s.kind, title: s.title, detail: s.detail as Record<string, unknown> | undefined, detected_at: new Date().toISOString() })), fitState(acct));
      signalLines = signals.filter((s) => s.kind !== "hn" && !/open roles/.test(s.title)).slice(0, 2).map((s) => s.title.replace(/^Hiring:\s*/i, "Hiring ").slice(0, 90));
      scores = { priority: sc.score, tier: tierOf(sc.score), whyNow: reasonLine(signals as never) };
      mark("Fit and signals checked", `${fit === "matches" ? "Fits" : fit === "close" ? "Partly fits" : fit === "outside" ? "Outside range" : "Fit unknown"}${signalLines[0] ? ` · ${signalLines[0]}` : " · no fresh signal"}`);
    }
  } else {
    mark("Company identified", disposable ? "Disposable email address" : "Personal email address, so no company to look up");
  }

  const label = labelFor({ business, disposable, intent: l.intent, fit, heat });
  const why = label === "not_fit" ? "" : await whyLine(l, { company: companyName, facts, fit, heat, signals: signalLines });

  let contactId: string | null = null, taskId: string | null = null;
  // A cap protects the CRM from a flood of fake submissions: past it, the owner is still alerted, but nothing is written to HubSpot.
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const { count: pushedToday } = await sb.from("cp_leads").select("id", { count: "exact", head: true }).not("hubspot_task_id", "is", null).gte("created_at", dayStart.toISOString());
  const crmOpen = (pushedToday ?? 0) < icp.inbound.hubspotPerDay;
  if (!crmOpen) await log("warn", "inbound_hubspot_cap", { detail: { pushedToday } });
  if (label !== "not_fit" && crmOpen) {
    // The lead's contact (and company) go into HubSpot, with a to-do to answer within the target time.
    try {
      let companyId: string | null = null;
      if (business && accountId) {
        const c = await pushCompany({ name: companyName, domain, scores: { fit: null, priority: scores.priority, signal: null, intent: null, tier: scores.tier, whyNow: scores.whyNow, whyFit: "", scoredAt: new Date().toISOString() }, dossier: null, signals: [] });
        companyId = c.companyId;
        await sb.from("cp_accounts").update({ hubspot_company_id: companyId, status: "pushed" }).eq("id", accountId);
      }
      const [first, ...rest] = l.name.split(" ");
      if (companyId) {
        const ct = await pushContact({ firstName: first, lastName: rest.join(" "), title: l.role ?? "", email: l.email, persona: null, personaScore: 90 }, companyId, domain);
        contactId = ct.contactId;
      }
      taskId = await createTask({
        subject: `Reply to ${l.name}${companyName ? ` (${companyName})` : ""}: ${INTENT_TEXT[l.intent]}`.slice(0, 240),
        html: `<p><b>${esc(LABEL_TEXT[label])}.</b> ${esc(why)}</p>${l.message ? `<p>“${esc(l.message)}”</p>` : ""}<p>Reply within ${icp.inbound.slaMinutes} minutes. ${esc(l.email)}</p>`,
        dueIso: new Date(Date.now() + icp.inbound.slaMinutes * 60_000).toISOString(), priority: label === "hot" ? "HIGH" : "MEDIUM", ownerId: icp.owner.hubspotOwnerId, companyId, contactId,
      });
    } catch (e) {
      await log("warn", "inbound_hubspot_failed", { message: (e as Error).message });
    }
    if (accountId) {
      await sb.from("cp_people").upsert({ account_id: accountId, provider: "inbound", first_name: l.name.split(" ")[0], last_name: l.name.split(" ").slice(1).join(" "), title: l.role ?? "Inbound lead", persona: null, relevance: 90, email: l.email, email_status: "unknown", email_revealed: true, hubspot_contact_id: contactId }, { onConflict: "account_id,email" });
    }
  }
  if (label === "not_fit") mark("Routed", "Marked as not a fit, so nobody is interrupted");
  else mark("Routed to the rep", `${LABEL_TEXT[label]}${taskId ? " · email sent and HubSpot to-do created" : " · email sent"}`);

  let alerted = false;
  if (label !== "not_fit") {
    try {
      await alertOwner(l, { label, why, companyName, facts, fit, signalLines, accountId });
      alerted = true;
    } catch (e) {
      await log("error", "inbound_alert_failed", { message: (e as Error).message });
    }
  }
  await sb.from("cp_leads").update({
    account_id: accountId, company: companyName || null, label, fit, heat, why: why || null, facts: facts || null, top_signals: signalLines, hubspot_contact_id: contactId, hubspot_task_id: taskId,
    alerted_at: alerted ? new Date().toISOString() : null, timeline,
  }).eq("id", id);
  await log("info", "inbound_processed", { account: domain, detail: { label, fit, heat, ms: Date.now() - t0, hubspot: !!taskId, alerted } });
  return { id, label, timeline };
}

async function alertOwner(l: LeadInput, c: { label: Label; why: string; companyName: string; facts: string; fit: string; signalLines: string[]; accountId: string | null }) {
  const fitText = c.fit === "matches" ? "Fits your profile" : c.fit === "close" ? "Partly fits your profile" : c.fit === "unknown" ? "Fit unknown" : "";
  const subject = `${c.label === "hot" ? "Hot lead" : "New lead"}: ${shortName(l.name)}${c.companyName ? ` at ${c.companyName}` : ""} · ${INTENT_TEXT[l.intent]}`;
  const text = [
    `${LABEL_TEXT[c.label].toUpperCase()}: ${l.name}${l.role ? `, ${l.role}` : ""}${c.companyName ? ` at ${c.companyName}` : ""}`,
    `${l.email}`, `They ${INTENT_TEXT[l.intent]}.`,
    l.message ? `\n"${l.message}"` : "",
    `\nWhy now: ${c.why}`,
    c.facts || fitText ? `\n${[fitText, c.facts].filter(Boolean).join(" · ")}` : "",
    c.signalLines.length ? c.signalLines.map((s) => `  - ${s}`).join("\n") : "",
    `\nAnswer within ${icp.inbound.slaMinutes} minutes: mailto:${l.email}`,
    `Open Inbound: ${PAGE}`,
    `\n— Account Copilot · nothing is sent to ${l.name}`,
  ].filter((x) => x !== "").join("\n");
  const html = layout(
    `<div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#dc2626">${esc(LABEL_TEXT[c.label])}</div>
     <div style="font-size:20px;font-weight:700;margin-top:4px">${esc(l.name)}${l.role ? `, ${esc(l.role)}` : ""}</div>
     ${muted(`${c.companyName ? `${esc(c.companyName)} · ` : ""}${link(`mailto:${l.email}`, l.email)} · ${esc(INTENT_TEXT[l.intent])}`, 14)}
     ${l.message ? quote("They wrote:", l.message) : ""}
     ${quote("Why now.", c.why)}
     ${h2("The company")}${muted(esc([fitText, c.facts].filter(Boolean).join(" · ") || "Nothing known yet"), 14)}
     ${c.signalLines.length ? `<ul style="margin:6px 0;padding-left:20px">${c.signalLines.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
     ${button(`mailto:${l.email}`, `Reply to ${l.name.split(" ")[0]}`)} ${muted(`Target: within ${icp.inbound.slaMinutes} minutes.`)}`,
    `Account Copilot · ${link(PAGE, "Open the Inbound tab")} · nothing is sent to ${esc(l.name)}`,
  );
  await sendMail(ownerEmail(), subject, text, html);
}

/** One reminder per lead that nobody has answered within the target time. Runs from the every-minute job. */
export async function nudgeOverdueLeads(): Promise<number> {
  const cutoff = new Date(Date.now() - icp.inbound.slaMinutes * 60_000).toISOString();
  const { data } = await sb.from("cp_leads").select("id,name,company,intent,email,alerted_at")
    .eq("status", "new").is("sla_nudged_at", null).in("label", ["hot", "warm", "review"]).not("alerted_at", "is", null)
    .lt("alerted_at", cutoff).gt("created_at", new Date(Date.now() - DAY).toISOString()).limit(5);
  let n = 0;
  for (const l of data ?? []) {
    try {
      const mins = Math.round((Date.now() - Date.parse(l.alerted_at!)) / 60_000);
      await sendMail(ownerEmail(), `Still waiting: ${shortName(l.name)}${l.company ? ` at ${l.company}` : ""} (${mins} min)`,
        `${l.name} ${INTENT_TEXT[l.intent as Intent]} ${mins} minutes ago and has not had an answer.\nReply: mailto:${l.email}\nOpen Inbound: ${PAGE}`,
        layout(`<div style="font-size:18px;font-weight:700">${esc(l.name)} has been waiting ${mins} minutes</div>${muted(esc(`${INTENT_TEXT[l.intent as Intent]}${l.company ? ` · ${l.company}` : ""}`), 14)}${button(`mailto:${l.email}`, `Reply to ${l.name.split(" ")[0]}`)}`, `Account Copilot · ${link(PAGE, "Open the Inbound tab")}`));
      await sb.from("cp_leads").update({ sla_nudged_at: new Date().toISOString() }).eq("id", l.id);
      n++;
    } catch (e) {
      await log("warn", "inbound_nudge_failed", { message: (e as Error).message });
    }
  }
  return n;
}

export { LABEL_TEXT };
