import { json } from "../_shared/db.ts";
import { jobAllowed } from "../_shared/auth.ts";
import { serve } from "../_shared/log.ts";
import { syncFromHubSpot } from "../_shared/crmback.ts";

// Every 30 minutes (cron): reads HubSpot back. Completed to-dos, deal stages and closed-lost deals update the
// app. It only reads HubSpot, so a run is harmless.
serve("crm-sync", async (req) => {
  if (!(await jobAllowed(req))) return json({ error: "Not allowed" }, 401);
  const r = await syncFromHubSpot();
  const res = json(r);
  if (!r.tasks_done && !r.deals_changed && !r.imported) res.headers.set("x-noop", "1"); // quiet runs are not logged
  return res;
});
