import { json, sb } from "../_shared/db.ts";
import { isAdmin } from "../_shared/auth.ts";
import { log, serve } from "../_shared/log.ts";
import { applyOutcome, type OutcomeKind } from "../_shared/lifecycle.ts";
import { buildToday } from "../_shared/today.ts";
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
    .select("id,name,domain,segment,priority_score,icp_score,why_now,status,hubspot_company_id,last_scanned_at,outreach_status,touches,contacted_at,next_followup_at,snoozed_until")
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
  const { data: accts } = await sb.from("cp_accounts").select("priority_score,status,last_scanned_at");
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
      ...tiers,
    },
  };
}

serve("queue", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = (await req.json().catch(() => null)) ?? {};
  const admin = await isAdmin(req);

  if (body.action === "list") return json({ ...(await list(String(body.view ?? "todo"))), admin });
  if (body.action === "today") return json({ ...(await buildToday(admin)), admin });
  if (body.action === "outcome" && typeof body.account_id === "string") {
    const kind = String(body.kind) as OutcomeKind;
    if (!["contacted", "replied", "meeting", "snooze", "not_now", "reopen"].includes(kind)) return json({ error: "Unknown outcome" }, 400);
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: nothing was changed. Unlock to record actions." });
    const r = await applyOutcome(body.account_id, kind, { days: Number(body.days), note: typeof body.note === "string" ? body.note : undefined });
    return "error" in r ? json({ error: r.error }, 400) : json({ mode: "live", ...r.update });
  }
  if (body.action === "icp") return json(await playbook());
  if (body.action === "check") return json({ admin });
  if (body.action === "reject" && typeof body.account_id === "string") {
    // Kept for older pages: "reject" now means "not now".
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: nothing was changed. Unlock to record actions." });
    const r = await applyOutcome(body.account_id, "not_now");
    return "error" in r ? json({ error: r.error }, 400) : json({ mode: "live", status: "not_now" });
  }
  return json({ error: "Unknown action" }, 400);
});
