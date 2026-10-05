import { log } from "./log.ts";

/** True when the request carries the owner key. Constant-time comparison. */
export async function isAdmin(req: Request): Promise<boolean> {
  const key = Deno.env.get("ADMIN_KEY");
  const given = req.headers.get("x-admin-key") ?? "";
  let ok = false;
  if (key && given.length === key.length) {
    let diff = 0;
    for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i);
    ok = diff === 0;
  }
  if (!ok && given) {
    await log("warn", "admin_key_rejected", { message: "An x-admin-key header was sent but did not match" });
  }
  return ok;
}
