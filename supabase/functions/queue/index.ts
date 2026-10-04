import { cors, json, sb } from "../_shared/db.ts";
import { pushAccount } from "../_shared/hubspot.ts";

function isAdmin(req: Request): boolean {
  const key = Deno.env.get("ADMIN_KEY");
  const given = req.headers.get("x-admin-key") ?? "";
  if (!key || given.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

async function list() {
  const { data: accounts } = await sb.from("cp_accounts")
    .select("id,name,domain,segment,priority_score,why_now,status,hubspot_company_id,last_scanned_at")
    .in("status", ["queued", "approved", "pushed"])
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

async function act(action: "approve" | "reject", accountId: string, admin: boolean) {
  const { data: a } = await sb.from("cp_accounts").select("*").eq("id", accountId).maybeSingle();
  if (!a) return json({ error: "Account not found" }, 404);
  if (a.status !== "queued") return json({ error: `Account is already ${a.status}` }, 409);

  const { data: draft } = await sb.from("cp_outreach_drafts").select("*")
    .eq("account_id", a.id).eq("status", "pending").limit(1).maybeSingle();

  if (action === "reject") {
    if (!admin) return json({ mode: "dry_run", message: "Demo mode: nothing was changed. Unlock to persist decisions." });
    await sb.from("cp_accounts").update({ status: "rejected" }).eq("id", a.id);
    if (draft) await sb.from("cp_outreach_drafts").update({ status: "rejected" }).eq("id", draft.id);
    return json({ mode: "live", status: "rejected" });
  }

  if (!draft) return json({ error: "No draft to approve" }, 409);

  // Public visitors see exactly what would be sent, but nothing is written to the CRM.
  if (!admin) {
    return json({
      mode: "dry_run",
      message: "Demo mode: this would create the company in HubSpot and attach the draft as a note.",
      would_create: { name: a.name, domain: a.domain, why_now: a.why_now, persona: draft.persona },
    });
  }

  try {
    const r = await pushAccount({
      name: a.name,
      domain: a.domain,
      whyNow: a.why_now ?? "",
      persona: draft.persona ?? "",
      subject: draft.subject,
      draftBody: draft.body,
    });
    await sb.from("cp_accounts").update({ status: "pushed", hubspot_company_id: r.companyId }).eq("id", a.id);
    await sb.from("cp_outreach_drafts").update({ status: "approved" }).eq("id", draft.id);
    return json({ mode: "live", status: "pushed", ...r });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = await req.json().catch(() => ({}));
  const admin = isAdmin(req);

  if (body.action === "list") return json({ ...(await list()), admin });
  if (body.action === "check") return json({ admin });
  if ((body.action === "approve" || body.action === "reject") && typeof body.account_id === "string") {
    return await act(body.action, body.account_id, admin);
  }
  return json({ error: "Unknown action" }, 400);
});
