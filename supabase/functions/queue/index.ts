import { json, sb } from "../_shared/db.ts";
import { isAdmin } from "../_shared/auth.ts";
import { log, serve } from "../_shared/log.ts";
import { applyOutcome, type OutcomeKind } from "../_shared/lifecycle.ts";
import { buildToday, reasonLine } from "../_shared/today.ts";
import { writeDraft } from "../_shared/draft.ts";
import { fetchFirmo, firmoLine, fitBreakdown, fitPoints, saveFirmo } from "../_shared/firmo.ts";
import { priorityScore } from "../_shared/score.ts";
import { fetchSite } from "../_shared/signals.ts";
import { BudgetError } from "../_shared/claude.ts";
import { tierOf } from "../_shared/score.ts";
import icp from "../_shared/icp.json" with { type: "json" };

const DAY = 86_400_000;

// Queue views: what still needs a first touch, what is in progress, and what is parked.
const VIEWS: Record<string, string[]> = {
  todo: ["open"],
  progress: ["contacted", "replied", "meeting"],
  parked: ["snoozed", "not_now"],
};

/** Next Monday 06:00 UTC strictly after now (the weekly scan window opens then). */
function nextScan(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0));
  const add = (8 - d.getUTCDay()) % 7; // days until Monday (1)
  d.setUTCDate(d.getUTCDate() + (add === 0 ? 0 : add));
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString();
}

async function scanInfo() {
  const [{ data: sched }, { data: last }] = await Promise.all([
    sb.rpc("cp_scan_schedule"),
    sb.from("cp_accounts").select("last_scanned_at").not("last_scanned_at", "is", null)
      .order("last_scanned_at", { ascending: false }).limit(1),
  ]);
  return {
    label: icp.schedule.label,
    active: Array.isArray(sched) ? !!sched[0]?.active : false,
    last_scan: last?.[0]?.last_scanned_at ?? null,
    next_scan: nextScan(),
  };
}

async function list(view = "todo") {
  const { data: accounts } = await sb.from("cp_accounts")
    .select("id,name,domain,segment,priority_score,icp_score,why_now,status,hubspot_company_id,last_scanned_at,outreach_status,touches,contacted_at,next_followup_at,snoozed_until,employees,employee_band,stage,raised_usd,hq_city,country,firmo_at")
    .in("status", ["queued", "pushed"])
    .in("outreach_status", VIEWS[view] ?? VIEWS.todo)
    .order("priority_score", { ascending: false })
    .limit(30);
  const ids = (accounts ?? []).map((a) => a.id);
  const scan = await scanInfo();
  if (!ids.length) return { accounts: [], scanned: 0, scan };

  const [{ data: signals }, { data: drafts }, { data: dossiers }, { count }] = await Promise.all([
    sb.from("cp_signals").select("account_id,kind,title,url,detail,detected_at").in("account_id", ids)
      .order("detected_at", { ascending: false }),
    sb.from("cp_outreach_drafts").select("account_id,persona,subject,body,status").in("account_id", ids)
      .order("created_at", { ascending: false }),
    sb.from("cp_dossiers").select("account_id").in("account_id", ids),
    sb.from("cp_accounts").select("id", { count: "exact", head: true }).not("last_scanned_at", "is", null),
  ]);
  const withDossier = new Set((dossiers ?? []).map((d) => d.account_id));

  return {
    scanned: count ?? 0,
    scan,
    accounts: (accounts ?? []).map((a) => ({
      ...a,
      has_dossier: withDossier.has(a.id),
      firmo: firmoLine(a),
      tier: tierOf(a.priority_score),
      signals: (signals ?? []).filter((s) => s.account_id === a.id).slice(0, 6).map((s) => ({
        kind: s.kind,
        title: s.title,
        url: s.url,
        first_seen: s.detected_at,
        published: (s.detail as { published?: string } | null)?.published ?? null,
        is_new: Date.now() - new Date(s.detected_at).getTime() < 7 * DAY,
      })),
      draft: (drafts ?? []).find((d) => d.account_id === a.id) ?? null,
    })),
  };
}

/** The ICP playbook for the sales team, straight from the live config plus a few counts. */
async function playbook() {
  const { data: accts } = await sb.from("cp_accounts").select("priority_score,status,last_scanned_at,employees,stage,country,firmo_at");
  const rows = accts ?? [];
  const tiers = { tier_1: 0, tier_2: 0, tier_3: 0 };
  for (const r of rows) if (r.priority_score != null) tiers[tierOf(r.priority_score)]++;
  return {
    seller: icp.seller,
    company: icp.company,
    personas: icp.personas.map((p) => ({ title: p.title, note: "onlyIfEmployeesBelow" in p ? `Only when the company has under ${p.onlyIfEmployeesBelow} people` : null })),
    signals: icp.signals.catalog,
    tiers: icp.tiers,
    queue_threshold: 30,
    schedule: icp.schedule.label,
    follow_up: { days: icp.followUp.days, note: icp.followUp.note },
    today: { cap: icp.today.cap, hot_hours: icp.today.hotHours },
    stats: {
      companies: rows.length,
      scanned: rows.filter((r) => r.last_scanned_at).length,
      queued: rows.filter((r) => r.status === "queued").length,
      enriched: rows.filter((r) => r.employees != null).length,
      matching: rows.filter((r) => fitBreakdown(r).matches).length,
      ...tiers,
    },
  };
}

/** Owner only. Looks up company facts once per company (about 0.2 Hunter credit each), then re-scores them. */
async function enrichCompanies(rescoreAll = false) {
  const { data: todo } = await sb.from("cp_accounts").select("id,domain").is("firmo_at", null)
    .order("priority_score", { ascending: false, nullsFirst: false }).limit(60);
  const out = { looked_up: 0, no_data: 0, failed: 0, rescored: 0 };
  const accounts = rescoreAll ? [] : (todo ?? []);

  for (let i = 0; i < accounts.length; i += 5) {
    await Promise.allSettled(accounts.slice(i, i + 5).map(async (a) => {
      try {
        const f = await fetchFirmo(a.domain);
        if (!f) {
          out.no_data++;
          await sb.from("cp_accounts").update({ firmo_at: new Date().toISOString() }).eq("id", a.id); // do not retry endlessly
          return;
        }
        await saveFirmo(a.id, f);
        out.looked_up++;
      } catch (e) {
        out.failed++;
        await log("error", "firmo_failed", { account: a.domain, message: (e as Error).message });
      }
    }));
  }

  // New fit points change the priority score, so recompute it from the stored signals.
  const ids = rescoreAll ? ((await sb.from("cp_accounts").select("id")).data ?? []).map((a) => a.id) : accounts.map((a) => a.id);
  if (ids.length) {
    const [{ data: rows }, { data: sigs }] = await Promise.all([
      sb.from("cp_accounts").select("id,status,employees,stage,country,firmo_at").in("id", ids),
      sb.from("cp_signals").select("account_id,kind,title,detail,detected_at").in("account_id", ids),
    ]);
    for (const r of rows ?? []) {
      const mine = (sigs ?? []).filter((s) => s.account_id === r.id).map((s) => ({ ...s, url: null, detail: { ...(s.detail ?? {}), detected_at: s.detected_at } }));
      const score = priorityScore(mine as never, fitPoints(r)).score;
      const upd: Record<string, unknown> = { priority_score: score };
      if (r.status === "new" && score >= 30) { upd.status = "queued"; upd.why_now = reasonLine(mine as never); }
      await sb.from("cp_accounts").update(upd).eq("id", r.id);
      out.rescored++;
    }
  }
  await log("info", "companies_enriched", { detail: out });
  return out;
}

/** Writes the outreach draft only when someone asks for it. The owner generates; everyone can read a saved one. */
async function draft(accountId: string, admin: boolean) {
  const { data: a } = await sb.from("cp_accounts").select("id,name,domain").eq("id", accountId).maybeSingle();
  if (!a) return json({ error: "Account not found" }, 404);

  const { data: saved } = await sb.from("cp_outreach_drafts").select("persona,subject,body").eq("account_id", a.id)
    .in("status", ["pending", "approved"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (saved) return json({ mode: "saved", draft: saved });
  if (!admin) return json({ mode: "dry_run", message: "Demo mode: the owner can generate a draft (about 1 cent)." });

  try {
    const [{ data: sigs }, site] = await Promise.all([
      sb.from("cp_signals").select("kind,title,url,detail").eq("account_id", a.id).order("detected_at", { ascending: false }).limit(12),
      fetchSite(a.domain),
    ]);
    const d = await writeDraft(a.name, a.domain, site, (sigs ?? []) as never);
    await sb.from("cp_outreach_drafts").insert({ account_id: a.id, persona: d.persona, subject: d.subject, body: d.body });
    await log("info", "draft_written", { account: a.domain });
    return json({ mode: "live", draft: { persona: d.persona, subject: d.subject, body: d.body } });
  } catch (e) {
    if (e instanceof BudgetError) return json({ error: "Daily AI budget reached. Try again tomorrow." }, 429);
    await log("error", "draft_failed", { account: a.domain, message: (e as Error).message });
    return json({ error: "Could not write the draft. Try again." }, 502);
  }
}

serve("queue", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = (await req.json().catch(() => null)) ?? {};
  const admin = await isAdmin(req);

  if (body.action === "list") return json({ ...(await list(String(body.view ?? "todo"))), admin });
  if (body.action === "draft" && typeof body.account_id === "string") return await draft(body.account_id, admin);
  if (body.action === "enrich_companies") {
    if (!admin) return json({ mode: "dry_run", message: "Owner only." }, 403);
    return json({ mode: "live", ...(await enrichCompanies(body.rescore === true)) });
  }
  if (body.action === "today") return json({ ...(await buildToday(admin)), admin });
  if (body.action === "outcome" && typeof body.account_id === "string") {
    const kind = String(body.kind) as OutcomeKind;
    if (!["contacted", "replied", "meeting", "snooze", "not_now", "reopen"].includes(kind)) return json({ error: "Unknown outcome" }, 400);
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: nothing was changed. Unlock to record actions." });
    const r = await applyOutcome(body.account_id, kind, { days: Number(body.days), note: typeof body.note === "string" ? body.note : undefined });
    return "error" in r ? json({ error: r.error }, 400) : json({ mode: "live", ...r.update });
  }
  if (body.action === "icp") return json(await playbook());
  return json({ error: "Unknown action" }, 400);
});
