import { sb } from "./db.ts";
import { log } from "./log.ts";
import { refreshAccountFields } from "./hsfields.ts";
import { type CompanyScores, type Dossier, pushCompany, pushContact, tierLabel } from "./hubspot.ts";
import { scoreAccount, tierOf } from "./score.ts";
import { addNote } from "./personnotes.ts";
import icp from "./icp.json" with { type: "json" };

// Putting a company and its revealed people into HubSpot. Used by the "Add to HubSpot" buttons and, when the owner marks someone
// contacted, replied or meeting-booked, automatically (see lifecycle.ts). Only people whose email was revealed are ever sent; a person
// who opted out or bounced in HubSpot never is.

export const personaValue = (title: string | null) => icp.personas.find((p) => p.title === title)?.hubspot ?? null;

/** Everything the HubSpot push needs, read from storage. Scores are recomputed so signal decay applies. */
export async function companyContext(accountId: string) {
  const { data: a } = await sb.from("cp_accounts").select("*").eq("id", accountId).maybeSingle();
  if (!a) return null;
  const [{ data: d }, { data: sigs }] = await Promise.all([
    sb.from("cp_dossiers").select("content").eq("account_id", accountId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("cp_signals").select("kind,title,url,detail,detected_at").eq("account_id", accountId).order("detected_at", { ascending: false }),
  ]);
  const dossier = (d?.content ?? null) as Dossier | null;
  const signals = (sigs ?? []).map((s) => ({ ...s, detail: { ...(s.detail ?? {}), detected_at: s.detected_at } }));
  const sc = scoreAccount(signals, a);
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

export const headerScores = (s: CompanyScores) => ({
  fit: s.fit, priority: s.priority, signal: s.signal, intent: s.intent, tier: s.tier, tier_label: tierLabel(s.tier),
});

export type PushResult =
  | { ok: true; company: Awaited<ReturnType<typeof pushCompany>>; contacts: { name: string; contactId: string }[]; used_dossier: boolean; skipped: number }
  | { ok: false; error: string; code: number };

/** Creates or updates the company, then the revealed people, links them, adds the note and fills the columns. */
export async function pushAccount(accountId: string, personIds?: string[], opts: { allowUnrevealed?: boolean } = {}): Promise<PushResult> {
  const ctx = await companyContext(accountId);
  if (!ctx) return { ok: false, error: "Account not found", code: 404 };
  const a = ctx.account;

  let q = sb.from("cp_people").select("*").eq("account_id", accountId);
  if (!opts.allowUnrevealed) q = q.eq("email_revealed", true).eq("preview", false); // only revealed people, unless the owner chose to add someone before revealing
  if (personIds?.length) q = q.in("id", personIds);
  const { data: all } = await q;
  const people = (all ?? []).filter((p) => p.hs_status !== "opted_out" && p.hs_status !== "bounced"); // never add someone who opted out or bounced
  const skipped = (all ?? []).length - people.length;
  if (!people.length) return { ok: false, error: skipped ? "Everyone selected opted out or bounced in HubSpot" : "Reveal at least one person first, or choose add without revealing", code: 409 };

  const { data: draft } = await sb.from("cp_outreach_drafts").select("*").eq("account_id", accountId)
    .in("status", ["pending", "approved"]).order("created_at", { ascending: false }).limit(1).maybeSingle();

  try {
    const company = await pushCompany({ name: a.name, domain: a.domain, scores: ctx.scores, dossier: ctx.dossier, signals: ctx.signals });
    const contacts: { name: string; contactId: string }[] = [];
    for (const p of people) {
      const html = draft
        ? `<p><b>Draft (not sent):</b></p><p><b>${draft.subject}</b><br>${draft.body.replace(/\{\{first_name\}\}/g, p.first_name).replace(/\n/g, "<br>")}</p>`
        : undefined;
      if (p.hubspot_contact_id && !p.email_revealed) continue; // already added before being revealed: it is completed when they are revealed
      const known = p.email_revealed && !p.preview && p.email; // the email goes to HubSpot only once it is revealed
      const c = await pushContact(
        { firstName: p.first_name, lastName: p.last_name ?? "", title: p.title, companyName: a.name, email: known ? p.email : null, persona: personaValue(p.persona), personaScore: p.relevance, draftHtml: known ? html : `<p><b>Not revealed yet in F1rstword.</b> The name is shortened and there is no email. It is completed here when the person is revealed.</p>${html ?? ""}` },
        company.companyId,
        a.domain,
      );
      await sb.from("cp_people").update({ hubspot_contact_id: c.contactId }).eq("id", p.id);
      await addNote(p.id, "pushed", known ? "Added to HubSpot with the email" : "Added to HubSpot before being revealed (completed when revealed)");
      contacts.push({ name: `${p.first_name} ${p.last_name}`.trim(), ...c });
    }
    await sb.from("cp_accounts").update({ status: "pushed", hubspot_company_id: company.companyId, priority_score: ctx.scores.priority }).eq("id", accountId);
    if (draft) await sb.from("cp_outreach_drafts").update({ status: "approved" }).eq("id", draft.id);
    await refreshAccountFields(accountId); // signals, status, facts and owner columns; failures are logged, never block the push
    await log("info", "push_complete", { account: a.domain, detail: { contacts: contacts.length, used_dossier: ctx.hasDossier } });
    return { ok: true, company, contacts, used_dossier: ctx.hasDossier, skipped };
  } catch (e) {
    await log("error", "push_failed", { account: a.domain, message: (e as Error).message });
    return { ok: false, error: (e as Error).message, code: 502 };
  }
}

/**
 * The automatic rule: when the owner starts working a company (marks contacted, replied or meeting booked) and it is not in HubSpot yet,
 * the company and its best revealed people (at most 2, buyer matches only) are added first, so the status sync has somewhere to write.
 * Nothing is added for a company the owner only looked at. Never throws: HubSpot trouble must not block the action.
 */
export async function autoPushOnContact(accountId: string): Promise<"pushed" | "skipped"> {
  try {
    if (!Deno.env.get("HUBSPOT_TOKEN") || (icp.watch as { autoPush?: boolean }).autoPush === false) return "skipped";
    const { data: a } = await sb.from("cp_accounts").select("id,hubspot_company_id,known_as,removed_at").eq("id", accountId).maybeSingle();
    if (!a || a.hubspot_company_id || a.removed_at || a.known_as === "customer") return "skipped";
    const { data: ppl } = await sb.from("cp_people").select("id,hs_status").eq("account_id", accountId).eq("email_revealed", true).eq("preview", false).gte("relevance", 50)
      .order("relevance", { ascending: false }).limit(6);
    const ids = (ppl ?? []).filter((p) => p.hs_status !== "opted_out" && p.hs_status !== "bounced").slice(0, 2).map((p) => p.id);
    if (!ids.length) return "skipped";
    const r = await pushAccount(accountId, ids);
    await log("info", "auto_push", { detail: { ok: r.ok, people: ids.length } });
    return r.ok ? "pushed" : "skipped";
  } catch (e) {
    await log("warn", "auto_push_failed", { message: (e as Error).message });
    return "skipped";
  }
}
