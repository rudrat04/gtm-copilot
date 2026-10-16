import { json } from "../_shared/db.ts";
import { isAdmin, jobAllowed } from "../_shared/auth.ts";
import { serve } from "../_shared/log.ts";
import icp from "../_shared/icp.json" with { type: "json" };
import { runDiscovery } from "../_shared/discover.ts";
import { capacityMode, icpChangedSinceDiscovery, markDiscoveryVersion, readyCount, todayCap } from "../_shared/capacity.ts";
import { log } from "../_shared/log.ts";

// Weekly (cron, Mondays 05:00 UTC, 10:30 IST): finds new companies from public sources and adds the ones that fit.
// New companies are then scored by the signal scan an hour later. The owner can pass {"dry":true} to preview or {"firmo":false} to skip company-fact lookups (no search credits).
serve("discover", async (req) => {
  if (!(await jobAllowed(req))) return json({ error: "Not allowed" }, 401);
  const body = (await req.json().catch(() => null)) ?? {};
  if ((icp.discovery as { enabled?: boolean }).enabled === false && body.force !== true) return json({ skipped: "Auto-discovery is switched off in Setup" });
  const owner = await isAdmin(req);
  // The weekly run follows how full the pipeline is. An owner-started run (body.force) always goes.
  let maxAi: number | undefined;
  if (body.force !== true && !(owner && body.dry === true)) {
    const cap = capacityMode({ ready: await readyCount(), cap: todayCap(), icpChanged: await icpChangedSinceDiscovery() });
    await log("info", "discovery_capacity", { detail: cap });
    if (cap.mode === "skip") return json({ skipped: cap.why });
    if (cap.mode === "boost") maxAi = Math.round(((icp.discovery as { maxAiPerRun: number }).maxAiPerRun) * 1.5);
  }
  const result = await runDiscovery({ dry: owner && body.dry === true, firmo: !(owner && body.firmo === false), web: owner && body.web === true ? true : owner && body.web === false ? false : undefined, maxAi, trigger: owner ? "manual" : "weekly" });
  if (!(owner && body.dry === true)) await markDiscoveryVersion();
  return json(result);
});
