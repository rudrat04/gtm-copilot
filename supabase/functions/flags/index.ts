import { json } from "../_shared/db.ts";
import { isAdmin, jobAllowed } from "../_shared/auth.ts";
import { serve } from "../_shared/log.ts";
import { runWatch } from "../_shared/flags.ts";
import icp from "../_shared/icp.json" with { type: "json" };

// Pipeline watch. Cron calls it every 3 hours with {"mode":"urgent"}; the daily digest runs the full pass itself.
// The owner can call it with {"mode":"daily","dry":true} to see what it would flag without storing anything.
serve("flags", async (req) => {
  if (!(await jobAllowed(req))) return json({ error: "Not allowed" }, 401);
  const body = (await req.json().catch(() => null)) ?? {};
  const mode = body.mode === "daily" ? "daily" : "urgent";
  const dry = body.dry === true && (await isAdmin(req));
  if (mode === "urgent" && !icp.watch.urgent && !dry) {
    const r = json({ skipped: "urgent checks are switched off" });
    r.headers.set("x-noop", "1");
    return r;
  }
  const r = await runWatch(mode, { dry });
  const res = json(r);
  if (!dry && !("new" in r && (r.new || r.resolved))) res.headers.set("x-noop", "1"); // a quiet run is not logged
  return res;
});
