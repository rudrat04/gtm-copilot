import { json } from "../_shared/db.ts";
import { isAdmin, jobAllowed } from "../_shared/auth.ts";
import { serve } from "../_shared/log.ts";
import { runWatch } from "../_shared/flags.ts";
import icp from "../_shared/icp.json" with { type: "json" };
import { mailOn } from "../_shared/switches.ts";
import { sb } from "../_shared/db.ts";
import { istDay, todayCount } from "../_shared/schedule.ts";

/** Urgent checks follow the weekday schedule: today's number is how many checks may run today (the cron calls every 3 hours). */
async function urgentRunAllowed(): Promise<boolean> {
  const cap = todayCount("flags");
  if (cap <= 0) return false;
  const today = `${new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10)}|${istDay()}`;
  const { data } = await sb.from("cp_state").select("value").eq("key", "flags_urgent_runs").maybeSingle();
  const [d, n] = String(data?.value ?? "").split("#");
  const used = d === today ? Number(n) || 0 : 0;
  if (used >= cap) return false;
  await sb.from("cp_state").upsert({ key: "flags_urgent_runs", value: `${today}#${used + 1}`, updated_at: new Date().toISOString() });
  return true;
}

// Pipeline watch. Cron calls it every 3 hours with {"mode":"urgent"}; the daily digest runs the full pass itself.
// The owner can call it with {"mode":"daily","dry":true} to see what it would flag without storing anything.
serve("flags", async (req) => {
  if (!(await jobAllowed(req))) return json({ error: "Not allowed" }, 401);
  if (!mailOn("flags") && !(await req.clone().json().catch(() => ({}))).dry) return json({ skipped: "problem flags are off" });
  const body = (await req.json().catch(() => null)) ?? {};
  const mode = body.mode === "daily" ? "daily" : "urgent";
  const dry = body.dry === true && (await isAdmin(req));
  if (mode === "urgent" && !icp.watch.urgent && !dry) {
    const r = json({ skipped: "urgent checks are switched off" });
    r.headers.set("x-noop", "1");
    return r;
  }
  if (mode === "urgent" && !dry && !(await urgentRunAllowed())) { const q = json({ skipped: "no urgent check scheduled right now" }); q.headers.set("x-noop", "1"); return q; }
  const r = await runWatch(mode, { dry });
  const res = json(r);
  if (!dry && !("new" in r && (r.new || r.resolved))) res.headers.set("x-noop", "1"); // a quiet run is not logged
  return res;
});
