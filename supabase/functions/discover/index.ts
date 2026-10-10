import { json } from "../_shared/db.ts";
import { isAdmin, jobAllowed } from "../_shared/auth.ts";
import { serve } from "../_shared/log.ts";
import { runDiscovery } from "../_shared/discover.ts";

// Weekly (cron, Mondays 05:00 UTC): finds new companies from public sources and adds the ones that fit.
// New companies are then scored by the signal scan an hour later. The owner can pass {"dry":true} to preview or {"firmo":false} to skip company-fact lookups (no search credits).
serve("discover", async (req) => {
  if (!(await jobAllowed(req))) return json({ error: "Not allowed" }, 401);
  const body = (await req.json().catch(() => null)) ?? {};
  const owner = await isAdmin(req);
  return json(await runDiscovery({ dry: owner && body.dry === true, firmo: !(owner && body.firmo === false) }));
});
