import { json, normalizeDomain, sb } from "../_shared/db.ts";
import { isAdmin } from "../_shared/auth.ts";
import { log, serve } from "../_shared/log.ts";
import { hunterBalance, provider, rank } from "../_shared/people.ts";
import {
  type CompanyScores,
  companyFields,
  type Dossier,
  pushCompany,
  pushContact,
  tierLabel,
} from "../_shared/hubspot.ts";
import { priorityScore, tierOf } from "../_shared/score.ts";
import icp from "../_shared/icp.json" with { type: "json" };

type Row = {
  id: string; first_name: string; last_name: string; title: string; seniority: string;
  department: string | null; persona: string | null; relevance: number; email: string | null;
  email_status: string | null; email_confidence: number | null; email_revealed: boolean;
  phone_revealed: boolean; hubspot_contact_id: string | null; account_id: string;
};

const maskEmail = (e: string | null) => (e ? `${e.slice(0, 2)}***@${e.split("@")[1]}` : null);
const abbreviate = (r: Row) => `${r.first_name} ${(r.last_name || "").charAt(0)}.`.trim();

/** Public visitors see first name + last initial and a masked email. The owner sees full names. */
function view(r: Row, admin: boolean) {
  return {
    id: r.id,
    name: admin ? `${r.first_name} ${r.last_name}`.trim() : abbreviate(r),
    title: r.title,
    seniority: r.seniority,
    department: r.department,
    persona: r.persona,
    persona_score: Math.min(100, r.relevance),
    email_status: r.email_status,
    email_confidence: r.email_confidence,
    email: admin && r.email_revealed ? r.email : maskEmail(r.email),
    email_revealed: admin && r.email_revealed,
    pushed: !!r.hubspot_contact_id,
  };
}

async function accountByDomain(domain: string) {
  const { data } = await sb.from("cp_accounts").select("*").eq("domain", domain).maybeSingle();
  return data;
}

async function list(accountId: string, admin: boolean) {
  const { data } = await sb.from("cp_people").select("*").eq("account_id", accountId)
    .order("relevance", { ascending: false }).order("email_confidence", { ascending: false });
  return (data ?? []).map((r) => view(r as Row, admin));
}

/** Everything the HubSpot push needs, read from storage. Scores are recomputed so signal decay applies. */
async function companyContext(accountId: string) {
  const { data: a } = await sb.from("cp_accounts").select("*").eq("id", accountId).maybeSingle();
  if (!a) return null;
  const [{ data: d }, { data: sigs }] = await Promise.all([
    sb.from("cp_dossiers").select("content").eq("account_id", accountId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("cp_signals").select("kind,title,url,detail,detected_at").eq("account_id", accountId).order("detected_at", { ascending: false }),
  ]);
  const dossier = (d?.content ?? null) as Dossier | null;
  const signals = (sigs ?? []).map((s) => ({ ...s, detail: { ...(s.detail ?? {}), detected_at: s.detected_at } }));
  const sc = priorityScore(signals);
  const scores: CompanyScores = {
    fit: dossier?.icp_fit?.score ?? a.icp_score ?? null,
    priority: sc.score,
    signal: sc.signalScore,
    intent: sc.intentScore,
    tier: tierOf(sc.score),
    whyNow: a.why_now ?? dossier?.why_now ?? "",
    whyFit: (dossier?.icp_fit?.reasons ?? []).join(" "),
    scoredAt: a.last_scanned_at,
  };
  return { account: a, dossier, signals, scores, hasDossier: !!dossier };
}

const headerScores = (s: CompanyScores) => ({
  fit: s.fit, priority: s.priority, signal: s.signal, intent: s.intent, tier: s.tier, tier_label: tierLabel(s.tier),
});

async function find(domainInput: string, admin: boolean, refresh: boolean) {
  const domain = normalizeDomain(domainInput);
  if (!domain) return json({ error: "Invalid domain" }, 400);
  const account = await accountByDomain(domain);
  if (!account) return json({ error: "Research this company first" }, 404);
  const ctx = await companyContext(account.id);
  const company = ctx ? headerScores(ctx.scores) : null;

  const existing = await list(account.id, admin);
  if (existing.length && !refresh) {
    await log("info", "people_cache_hit", { account: domain, detail: { count: existing.length } });
    return json({ account_id: account.id, people: existing, cached: true, admin, company });
  }
  if (!admin) {
    return json({
      account_id: account.id, people: [], locked: true, company,
      message: "Demo mode: live people search uses limited credits. Unlock to search.",
    });
  }

  let found;
  try {
    found = await provider().search(domain);
  } catch (e) {
    await log("error", "find_people_failed", { account: domain, message: (e as Error).message });
    return json({ error: (e as Error).message }, 502);
  }

  const rows = found.people.map((p) => {
    const r = rank(p.title);
    return {
      account_id: account.id,
      provider: provider().name,
      first_name: p.firstName,
      last_name: p.lastName,
      title: p.title,
      seniority: r.seniority,
      department: p.department ?? null,
      persona: r.persona,
      relevance: r.relevance,
      linkedin_url: p.linkedinUrl ?? null,
      email: p.email?.toLowerCase() ?? null,
      email_status: p.emailStatus ?? null,
      email_confidence: p.emailConfidence ?? null,
    };
  });
  if (rows.length) {
    const { error } = await sb.from("cp_people").upsert(rows, { onConflict: "account_id,email", ignoreDuplicates: true });
    if (error) await log("error", "people_store_failed", { account: domain, message: error.message });
  }
  const people = await list(account.id, admin);
  return json({ account_id: account.id, people, cached: false, admin, credits_spent: found.credits, company });
}

async function enrich(personId: string, what: string, admin: boolean) {
  const { data: p } = await sb.from("cp_people").select("*").eq("id", personId).maybeSingle();
  if (!p) return json({ error: "Person not found" }, 404);

  if (what !== "email") {
    return json({ error: "Phone numbers need a paid data provider and aren't available yet." }, 400);
  }
  if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to reveal the email." });
  if (!p.email) return json({ error: "No email found for this person" }, 404);

  await sb.from("cp_people").update({ email_revealed: true, enriched_at: new Date().toISOString() }).eq("id", personId);
  await log("info", "person_enriched", { account: p.email.split("@")[1], detail: { what, status: p.email_status } });
  return json({ mode: "live", person: view({ ...p, email_revealed: true } as Row, true) });
}

const personaValue = (title: string | null) => icp.personas.find((p) => p.title === title)?.hubspot ?? null;
const personaLabel = (v: string | null) =>
  ({ sales_leader: "Sales leader", revops: "Revenue operations", Founder: "Founder" } as Record<string, string>)[v ?? ""] ?? "No persona";

/** Shows exactly what a push would write, so nothing is a surprise. Safe for public visitors. */
async function preview(accountId: string, admin: boolean) {
  const ctx = await companyContext(accountId);
  if (!ctx) return json({ error: "Account not found" }, 404);
  const { data: people } = await sb.from("cp_people").select("*").eq("account_id", accountId).eq("email_revealed", true);

  const fields = companyFields(ctx.scores).map((f) => ({
    label: f.label,
    value: f.key === "hs_ideal_customer_profile" ? tierLabel(f.value) : f.key === "gtm_industry" ? "B2B SaaS" : f.value,
  }));
  return json({
    company: { name: ctx.account.name, domain: ctx.account.domain, fields },
    contacts: (people ?? []).map((p) => ({
      name: admin ? `${p.first_name} ${p.last_name}`.trim() : abbreviate(p as Row),
      title: p.title,
      fields: [
        { label: "Scored persona", value: personaLabel(personaValue(p.persona)) },
        { label: "Persona score", value: String(Math.min(100, p.relevance)) },
      ],
    })),
    note: ctx.hasDossier ? "Full dossier note" : "Signals note (no dossier yet)",
  });
}

async function push(accountId: string, personIds: string[] | undefined, admin: boolean) {
  if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to push to HubSpot." });

  const ctx = await companyContext(accountId);
  if (!ctx) return json({ error: "Account not found" }, 404);
  const a = ctx.account;

  let q = sb.from("cp_people").select("*").eq("account_id", accountId).eq("email_revealed", true);
  if (personIds?.length) q = q.in("id", personIds);
  const { data: people } = await q;
  if (!people?.length) return json({ error: "Enrich at least one person before pushing" }, 409);

  const { data: draft } = await sb.from("cp_outreach_drafts").select("*").eq("account_id", accountId)
    .in("status", ["pending", "approved"]).order("created_at", { ascending: false }).limit(1).maybeSingle();

  try {
    const company = await pushCompany({
      name: a.name, domain: a.domain, scores: ctx.scores, dossier: ctx.dossier, signals: ctx.signals,
    });

    const contacts = [];
    for (const p of people) {
      const html = draft
        ? `<p><b>Draft (not sent):</b></p><p><b>${draft.subject}</b><br>${draft.body.replace(/\{\{first_name\}\}/g, p.first_name).replace(/\n/g, "<br>")}</p>`
        : undefined;
      const c = await pushContact(
        {
          firstName: p.first_name, lastName: p.last_name ?? "", title: p.title, email: p.email!,
          persona: personaValue(p.persona), personaScore: p.relevance, draftHtml: html,
        },
        company.companyId,
        a.domain,
      );
      await sb.from("cp_people").update({ hubspot_contact_id: c.contactId }).eq("id", p.id);
      contacts.push({ name: `${p.first_name} ${p.last_name}`.trim(), ...c });
    }

    await sb.from("cp_accounts").update({ status: "pushed", hubspot_company_id: company.companyId, priority_score: ctx.scores.priority }).eq("id", accountId);
    if (draft) await sb.from("cp_outreach_drafts").update({ status: "approved" }).eq("id", draft.id);
    await log("info", "push_complete", { account: a.domain, detail: { contacts: contacts.length, used_dossier: ctx.hasDossier } });
    return json({ mode: "live", company, contacts, used_dossier: ctx.hasDossier });
  } catch (e) {
    await log("error", "push_failed", { account: a.domain, message: (e as Error).message });
    return json({ error: (e as Error).message }, 502);
  }
}

serve("people", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = (await req.json().catch(() => null)) ?? {};
  const admin = await isAdmin(req);

  switch (body.action) {
    case "find":
      return await find(String(body.domain ?? ""), admin, body.refresh === true && admin);
    case "enrich":
      return await enrich(String(body.person_id ?? ""), String(body.what ?? "email"), admin);
    case "preview":
      return await preview(String(body.account_id ?? ""), admin);
    case "push":
      return await push(String(body.account_id ?? ""), Array.isArray(body.person_ids) ? body.person_ids : undefined, admin);
    case "rerank": {
      // Recompute persona/relevance from stored titles after an ICP change. Costs no credits.
      if (!admin) return json({ error: "Owner only" }, 403);
      const { data } = await sb.from("cp_people").select("id,title");
      for (const p of data ?? []) {
        const r = rank(p.title ?? "");
        await sb.from("cp_people").update({ persona: r.persona, relevance: r.relevance, seniority: r.seniority }).eq("id", p.id);
      }
      return json({ reranked: data?.length ?? 0 });
    }
    case "status":
      return json({ admin, credits: admin ? await hunterBalance() : null });
    default:
      return json({ error: "Unknown action" }, 400);
  }
});
