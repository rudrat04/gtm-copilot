import { json, sb } from "../_shared/db.ts";
import { BudgetError } from "../_shared/claude.ts";
import { collectSignals } from "../_shared/signals.ts";
import { priorityScore, QUEUE_THRESHOLD } from "../_shared/score.ts";
import { writeDraft } from "../_shared/draft.ts";
import { log, serve } from "../_shared/log.ts";
import icp from "../_shared/icp.json" with { type: "json" };

// Called by pg_cron every few minutes. It only touches accounts whose last scan is stale,
// so extra or public calls are harmless: once everything is fresh it does nothing.
const STALE_HOURS = icp.schedule.staleDays * 24;
const BATCH = 6;

type Account = { id: string; name: string; domain: string; status: string; segment: string | null };

async function scanOne(a: Account) {
  const { site, signals } = await collectSignals(a.name, a.domain, a.segment ?? "");

  if (signals.length) {
    await sb.from("cp_signals").upsert(
      signals.map((s) => ({
        account_id: a.id,
        kind: s.kind,
        title: s.title.slice(0, 300),
        url: s.url,
        detail: s.detail ?? {},
      })),
      { onConflict: "account_id,kind,title", ignoreDuplicates: true },
    );
  }

  const { score } = priorityScore(signals);
  const update: Record<string, unknown> = {
    priority_score: score,
    last_scanned_at: new Date().toISOString(),
  };

  // Only accounts that clear the threshold get an AI-written draft, and never twice.
  const open = a.status === "new" || a.status === "queued";
  if (open && score >= QUEUE_THRESHOLD) {
    try {
      const d = await writeDraft(a.name, a.domain, site, signals);
      await sb.from("cp_outreach_drafts").delete().eq("account_id", a.id).eq("status", "pending");
      await sb.from("cp_outreach_drafts").insert({
        account_id: a.id,
        persona: d.persona,
        subject: d.subject,
        body: d.body,
      });
      update.why_now = d.why_now;
      update.status = "queued";
    } catch (e) {
      if (e instanceof BudgetError) return { domain: a.domain, score, note: "budget" };
      await log("error", "draft_failed", { account: a.domain, message: (e as Error).message, detail: { score } });
      throw e;
    }
  }

  const { error: upErr } = await sb.from("cp_accounts").update(update).eq("id", a.id);
  if (upErr) await log("error", "account_update_failed", { account: a.domain, message: upErr.message });
  await log("info", "account_scanned", {
    account: a.domain,
    detail: { score, signals: signals.length, queued: update.status === "queued" },
  });
  return { domain: a.domain, score, queued: update.status === "queued" };
}

serve("signal-scan", async (req) => {

  const cutoff = new Date(Date.now() - STALE_HOURS * 3600_000).toISOString();
  const { data: stale, error } = await sb.from("cp_accounts")
    .select("id,name,domain,status,segment")
    .or(`last_scanned_at.is.null,last_scanned_at.lt.${cutoff}`)
    .order("last_scanned_at", { ascending: true, nullsFirst: true })
    .limit(BATCH);
  if (error) {
    await log("error", "stale_query_failed", { message: error.message });
    return json({ error: error.message }, 500);
  }
  // Idle run: nothing to do. Mark it so the 5-minute cron does not flood the logs.
  if (!stale?.length) {
    const idle = json({ scanned: [], idle: true });
    idle.headers.set("x-noop", "1");
    return idle;
  }

  const results = await Promise.allSettled((stale ?? []).map(scanOne));
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      void log("error", "account_scan_failed", { account: stale![i].domain, message: String(r.reason).slice(0, 300) });
    }
  });
  await log("info", "batch_done", {
    detail: {
      attempted: results.length,
      failed: results.filter((r) => r.status === "rejected").length,
    },
  });
  return json({
    scanned: results.map((r, i) =>
      r.status === "fulfilled" ? r.value : { domain: stale![i].domain, error: String(r.reason).slice(0, 120) }
    ),
    remaining_stale_hint: (stale?.length ?? 0) === BATCH,
  });
});
