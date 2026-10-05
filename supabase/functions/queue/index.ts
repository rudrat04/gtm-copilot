import { json, sb } from "../_shared/db.ts";
import { isAdmin } from "../_shared/auth.ts";
import { log, serve } from "../_shared/log.ts";

async function list() {
  const { data: accounts } = await sb.from("cp_accounts")
    .select("id,name,domain,segment,priority_score,why_now,status,hubspot_company_id,last_scanned_at")
    .in("status", ["queued", "pushed"])
    .order("priority_score", { ascending: false })
    .limit(30);
  const ids = (accounts ?? []).map((a) => a.id);
  if (!ids.length) return { accounts: [], scanned: 0 };

  const [{ data: signals }, { data: drafts }, { count }] = await Promise.all([
    sb.from("cp_signals").select("account_id,kind,title,url").in("account_id", ids)
      .order("detected_at", { ascending: false }),
    sb.from("cp_outreach_drafts").select("account_id,persona,subject,body,status").in("account_id", ids)
      .order("created_at", { ascending: false }),
    sb.from("cp_accounts").select("id", { count: "exact", head: true }).not("last_scanned_at", "is", null),
  ]);

  return {
    scanned: count ?? 0,
    accounts: (accounts ?? []).map((a) => ({
      ...a,
      signals: (signals ?? []).filter((s) => s.account_id === a.id).slice(0, 6),
      draft: (drafts ?? []).find((d) => d.account_id === a.id) ?? null,
    })),
  };
}

async function reject(accountId: string, admin: boolean) {
  const { data: a } = await sb.from("cp_accounts").select("id,domain,status").eq("id", accountId).maybeSingle();
  if (!a) return json({ error: "Account not found" }, 404);
  if (a.status !== "queued") return json({ error: `Account is already ${a.status}` }, 409);
  if (!admin) return json({ mode: "dry_run", message: "Demo mode: nothing was changed. Unlock to persist decisions." });

  await sb.from("cp_accounts").update({ status: "rejected" }).eq("id", a.id);
  await sb.from("cp_outreach_drafts").update({ status: "rejected" }).eq("account_id", a.id).eq("status", "pending");
  await log("info", "decision", { account: a.domain, detail: { action: "reject", mode: "live" } });
  return json({ mode: "live", status: "rejected" });
}

serve("queue", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = (await req.json().catch(() => null)) ?? {};
  const admin = await isAdmin(req);

  if (body.action === "list") return json({ ...(await list()), admin });
  if (body.action === "check") return json({ admin });
  if (body.action === "reject" && typeof body.account_id === "string") return await reject(body.account_id, admin);
  return json({ error: "Unknown action" }, 400);
});
