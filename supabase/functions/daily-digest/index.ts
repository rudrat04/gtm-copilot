import { json, sb } from "../_shared/db.ts";
import { isAdmin, isCron } from "../_shared/auth.ts";
import { log, serve } from "../_shared/log.ts";
import { googleConfigured, ownerEmail, sendMail } from "../_shared/google.ts";
import { buildToday, hash } from "../_shared/today.ts";
import { digestEmail, summaryTask, taskFor } from "../_shared/templates.ts";
import { activeFlags, runWatch } from "../_shared/flags.ts";
import { changesSince, emptyChanges, hasChanges } from "../_shared/changes.ts";
import { createTask } from "../_shared/hubspot.ts";
import icp from "../_shared/icp.json" with { type: "json" };

// Runs every morning (cron). Emails the owner the Today list and creates the matching HubSpot to-dos.
// Outreach itself stays manual: nothing here contacts a prospect.

async function state(key: string) {
  const { data } = await sb.from("cp_state").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

import { mailOn } from "../_shared/switches.ts";
import { dayOn } from "../_shared/schedule.ts";

serve("daily-digest", async (req) => {
  const admin = await isAdmin(req);
  if (!admin && !(await isCron(req))) return json({ error: "Not allowed" }, 401);
  const opts = (await req.json().catch(() => null)) ?? {};
  const idle = (extra: Record<string, unknown> = {}) => {
    const r = json({ sent: false, ...extra });
    r.headers.set("x-noop", "1");
    return r;
  };

  const last = await state("digest_last");
  if (!admin && last && Date.now() - Date.parse(last) < 20 * 3_600_000) return idle({ skipped: "ran recently" });
  if (!googleConfigured()) return idle({ error: "Google is not connected" });
  if (!mailOn("daily") && !(admin && opts.dry === true)) { // switched off in Setup: no email, no automatic searches, no HubSpot summary to-do
    if (mailOn("flags")) await runWatch("daily").catch(() => {}); // the problem checks still run if they are on
    return idle({ skipped: "daily email is off" });
  }

  if (!admin && !dayOn("daily")) { // a weekday you switched off in Setup: no email, no automatic searches, no HubSpot summary to-do
    if (mailOn("flags")) await runWatch("daily").catch(() => {});
    return idle({ skipped: "not a day for the daily email" });
  }

  // The list leads with people: a strong account with none gets one automatic search (limited per day).
  const preview = admin && opts.dry === true; // a preview spends no credits and sends nothing
  const today = await buildToday(true, { autoFind: !preview }); // owner view: full names, and writes any missing "Why today" lines

  // The full pipeline watch runs just before the email, so the email carries what needs attention.
  if (!preview && mailOn("flags")) await runWatch("daily").catch(async (e) => { await log("error", "watch_failed", { message: (e as Error).message }); });
  const attention = icp.watch.digestFlags === false || !mailOn("flags") ? { items: [], total: 0 } : await activeFlags(6); // the owner can leave the "needs attention" section out of the email

  if (!preview) await sb.from("cp_state").upsert({ key: "digest_last", value: new Date().toISOString(), updated_at: new Date().toISOString() });
  // What changed since the last email (at most 36 hours back), and who is waiting for a contact.
  const since = new Date(Math.max(last ? Date.parse(last) : 0, Date.now() - 36 * 3_600_000)).toISOString();
  const changes = await changesSince(since, today.needs).catch(async (e) => { await log("warn", "changes_failed", { message: (e as Error).message }); return emptyChanges(); });
  if (!today.items.length && !attention.total && !hasChanges(changes)) {
    await log("info", "digest_skipped_empty", {});
    return json({ sent: false, reason: "Nothing on today's list" });
  }

  // HubSpot ids for linking and for creating tasks only on records that exist.
  const accountIds = [...new Set(today.items.map((i) => i.account?.id).filter(Boolean) as string[])];
  const [{ data: accts }, { data: people }] = await Promise.all([
    accountIds.length ? sb.from("cp_accounts").select("id,hubspot_company_id").in("id", accountIds) : Promise.resolve({ data: [] }),
    accountIds.length ? sb.from("cp_people").select("account_id,first_name,last_name,hubspot_contact_id,relevance").in("account_id", accountIds).not("hubspot_contact_id", "is", null).order("relevance", { ascending: false }) : Promise.resolve({ data: [] }),
  ]);
  const links = new Map<string, string>((accts ?? []).filter((a) => a.hubspot_company_id).map((a) => [a.id, a.hubspot_company_id!]));
  const contactFor = new Map<string, { id: string; name: string }>();
  for (const p of people ?? []) if (!contactFor.has(p.account_id)) contactFor.set(p.account_id, { id: p.hubspot_contact_id!, name: `${p.first_name} ${p.last_name}`.trim() });

  // 1) The email.
  const mail = digestEmail(today.items, today.hidden, links, attention, changes);
  if (admin && opts.dry === true) return json({ dry: true, subject: mail.subject, body: mail.body, html: mail.html }); // preview only: nothing is sent or created
  let emailed = false;
  try {
    await sendMail(ownerEmail(), mail.subject, mail.body, mail.html);
    emailed = true;
    if (changes.watch.length) await sb.from("cp_watch_events").update({ emailed_at: new Date().toISOString() }).in("id", changes.watch.map((w) => w.id)); // listed in the email, so they are not sent again
  } catch (e) {
    await log("error", "digest_email_failed", { message: (e as Error).message });
  }

  // 2) HubSpot to-dos: one summary task a day, plus one per prospect that already lives in HubSpot.
  const tasks = { created: 0, skipped: 0, failed: 0 };
  if (Deno.env.get("HUBSPOT_TOKEN")) {
    const day = new Date().toISOString().slice(0, 10);
    const due = `${day}T12:00:00Z`;
    const planned: { key: string; accountId: string | null; subject: string; html: string; priority: "HIGH" | "MEDIUM"; companyId?: string | null; contactId?: string | null }[] = [];

    const sum = summaryTask(today.items, today.hidden);
    planned.push({ key: `sum:${day}`, accountId: null, subject: sum.subject, html: sum.html, priority: "MEDIUM" });

    for (const it of today.items) {
      if (!it.account || it.type === "meeting") continue;
      const companyId = links.get(it.account.id);
      if (!companyId) continue; // not in HubSpot yet: covered by the summary task and the email
      const c = contactFor.get(it.account.id);
      const key = it.type === "follow_up" ? `fu:${it.account.id}:${(it.due ?? day).slice(0, 10)}`
        : it.type === "revive" ? `rv:${it.account.id}:${day}`
        : `hot:${it.account.id}:${hash(it.signals.map((s) => s.title).join("|"))}`;
      const t = taskFor(it, c?.name);
      planned.push({
        key, accountId: it.account.id, subject: t.subject, html: t.html,
        priority: it.account.tier === "tier_1" || it.type === "follow_up" ? "HIGH" : "MEDIUM", companyId, contactId: c?.id,
      });
    }

    const { data: done } = await sb.from("cp_tasks").select("key").in("key", planned.map((p) => p.key));
    const have = new Set((done ?? []).map((d) => d.key));
    for (const p of planned) {
      if (have.has(p.key)) { tasks.skipped++; continue; }
      try {
        const id = await createTask({ subject: p.subject, html: p.html, dueIso: due, priority: p.priority, ownerId: icp.owner.hubspotOwnerId, companyId: p.companyId, contactId: p.contactId });
        await sb.from("cp_tasks").insert({ key: p.key, account_id: p.accountId, hubspot_task_id: id });
        tasks.created++;
      } catch (e) {
        tasks.failed++;
        await log("error", "digest_task_failed", { message: (e as Error).message, detail: { key: p.key } });
      }
    }
  }

  await log("info", "digest_done", { detail: { items: today.items.length, emailed, tasks } });
  return json({ items: today.items.length, emailed, tasks });
});
