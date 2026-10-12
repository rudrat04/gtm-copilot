import { json, normalizeDomain, sb } from "../_shared/db.ts";
import { isAdmin } from "../_shared/auth.ts";
import { log, serve } from "../_shared/log.ts";
import { hunterBalance, rerankPeople, searchAndStore } from "../_shared/people.ts";
import { peekPeople, revealPerson } from "../_shared/peoplepreview.ts";
import { companyContext, headerScores, personaValue, pushAccount } from "../_shared/pushaccount.ts";
import { companyFields, tierLabel } from "../_shared/hubspot.ts";

type Row = {
  id: string; first_name: string; last_name: string; title: string; seniority: string;
  department: string | null; persona: string | null; relevance: number; email: string | null;
  email_status: string | null; email_confidence: number | null; email_revealed: boolean;
  phone_revealed: boolean; hubspot_contact_id: string | null; account_id: string;
  hs_status?: "known" | "opted_out" | "bounced" | null; hs_note?: string | null; watched_at?: string | null;
  preview?: boolean; decision_maker?: boolean | null;
};

const maskEmail = (e: string | null) => (e ? `***@${e.split("@")[1]}` : null);
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
    watched: !!r.watched_at,
    hs_status: r.hs_status ?? null,
    hs_note: r.hs_note ?? null,
    preview: !!r.preview,
    decision_maker: r.decision_maker ?? null,
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
    found = await searchAndStore({ id: account.id, domain });
  } catch (e) {
    await log("error", "find_people_failed", { account: domain, message: (e as Error).message });
    return json({ error: (e as Error).message }, 502);
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
  if (p.preview) return json({ error: "Reveal this person first (1 credit)" }, 409);
  if (!p.email) return json({ error: "No email found for this person" }, 404);
  if (p.hs_status === "opted_out" || p.hs_status === "bounced") return json({ error: p.hs_note ?? "HubSpot says this person should not be emailed" }, 409);

  await sb.from("cp_people").update({ email_revealed: true, enriched_at: new Date().toISOString() }).eq("id", personId);
  await log("info", "person_enriched", { account: p.email.split("@")[1], detail: { what, status: p.email_status } });
  return json({ mode: "live", person: view({ ...p, email_revealed: true } as Row, true) });
}

const personaLabel = (v: string | null) =>
  ({ sales_leader: "Sales leader", revops: "Revenue operations", Founder: "Founder" } as Record<string, string>)[v ?? ""] ?? (v ? v.replace(/_/g, " ") : "No persona");

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
  const r = await pushAccount(accountId, personIds);
  if (!r.ok) return json({ error: r.error }, r.code);
  return json({ mode: "live", company: r.company, contacts: r.contacts, used_dossier: r.used_dossier, skipped: r.skipped });
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
      return json({ reranked: await rerankPeople() });
    }
    case "peek": { // free: who works there (shortened names, no emails)
      if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to look up people." });
      const { data: a } = await sb.from("cp_accounts").select("id,name,domain").eq("id", String(body.account_id ?? "")).maybeSingle();
      if (!a) return json({ error: "Company not found" }, 404);
      return json({ mode: "live", ...(await peekPeople([a])), people: await list(a.id, true) });
    }
    case "reveal": { // 1 credit
      if (!admin) return json({ mode: "dry_run", message: "Demo mode: unlock to reveal. It uses 1 search credit." });
      const r = await revealPerson(String(body.person_id ?? ""));
      if (!r.ok) return json({ error: r.error }, r.code ?? 400);
      const { data: p } = await sb.from("cp_people").select("*").eq("id", String(body.person_id)).maybeSingle();
      return json({ mode: "live", credits: r.credits, person: p ? view(p as Row, true) : null });
    }
    case "status":
      return json({ admin, credits: admin ? await hunterBalance() : null });
    default:
      return json({ error: "Unknown action" }, 400);
  }
});
