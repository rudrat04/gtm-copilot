import { sb } from "./db.ts";
import { log } from "./log.ts";

function same(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the request carries the owner key. Constant-time comparison. */
export async function isAdmin(req: Request): Promise<boolean> {
  const given = req.headers.get("x-admin-key") ?? "";
  const ok = same(given, Deno.env.get("ADMIN_KEY") ?? "");
  if (!ok && given) await log("warn", "admin_key_rejected", { message: "An x-admin-key header was sent but did not match" });
  return ok;
}

/** True when the request comes from one of our scheduled jobs (the secret lives only in the database). */
export async function isCron(req: Request): Promise<boolean> {
  const given = req.headers.get("x-cron-secret") ?? "";
  if (!given) return false;
  const { data } = await sb.from("cp_state").select("value").eq("key", "cron_secret").maybeSingle();
  const ok = same(given, data?.value ?? "");
  if (!ok) await log("warn", "cron_secret_rejected", { message: "A job request carried a wrong secret" });
  return ok;
}

/** Endpoints meant only for the scheduler (or the owner testing them). */
export async function jobAllowed(req: Request): Promise<boolean> {
  return (await isAdmin(req)) || (await isCron(req));
}

/** Allow at most `limit` hits per window for a bucket. Returns false when the limit is already used up. */
export async function rateOk(bucket: string, windowSeconds: number, limit: number): Promise<boolean> {
  const start = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000).toISOString();
  const { data } = await sb.from("cp_rate").select("n").eq("bucket", bucket).eq("window_start", start).maybeSingle();
  if ((data?.n ?? 0) >= limit) return false;
  await sb.from("cp_rate").upsert({ bucket, window_start: start, n: (data?.n ?? 0) + 1 });
  return true;
}

/** A stable, anonymous id for the caller, so the raw IP address is never stored. */
export async function callerId(req: Request): Promise<string> {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|account-copilot`));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
