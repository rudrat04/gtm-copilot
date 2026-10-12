import { sb } from "./db.ts";
import { collectSignals, saveSiteFacts, storedHiringSignals } from "./signals.ts";
import { scoreAccount } from "./score.ts";
import { queueThreshold } from "./fitgate.ts";
import { storedPlSignals } from "./predictleads.ts";
import { reasonLine } from "./today.ts";
import { log } from "./log.ts";

// Reads one company's public sources, stores the new signals, and refreshes its score. Used by the weekly scan and,
// right after discovery adds a company, so a new company arrives with signals and a score instead of waiting for Monday.

export type ScanAccount = { id: string; name: string; domain: string; status: string; segment: string | null; employees: number | null; stage: string | null; country: string | null; firmo_at: string | null };

export async function scanOne(a: ScanAccount) {
  const { signals, hiringUnknown, motion, jobTools } = await collectSignals(a.name, a.domain, a.segment ?? "");
  await saveSiteFacts(a.id, { motion, jobTools }); // sales style and tools seen on the site and in job posts

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

  const { score } = scoreAccount([...signals, ...(await storedPlSignals(a.id)), ...(hiringUnknown ? await storedHiringSignals(a.id) : [])], a); // PredictLeads events stored earlier still count
  const update: Record<string, unknown> = {
    priority_score: score,
    last_scanned_at: new Date().toISOString(),
  };

  // Accounts that clear the threshold enter the Queue with a plain-English reason. Drafts are written
  // on demand (the "Draft email" button), so no AI is spent on emails nobody asked for.
  const open = a.status === "new" || a.status === "queued";
  if (open && score >= queueThreshold()) {
    update.why_now = reasonLine(signals as never);
    update.status = "queued";
  }

  const { error: upErr } = await sb.from("cp_accounts").update(update).eq("id", a.id);
  if (upErr) await log("error", "account_update_failed", { account: a.domain, message: upErr.message });
  await log("info", "account_scanned", {
    account: a.domain,
    detail: { score, signals: signals.length, queued: update.status === "queued" },
  });
  return { domain: a.domain, score, queued: update.status === "queued" };
}
