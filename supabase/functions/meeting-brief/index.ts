import { json, sb } from "../_shared/db.ts";
import { jobAllowed } from "../_shared/auth.ts";
import { log, serve } from "../_shared/log.ts";
import { type CalEvent, getEvent, googleConfigured, listChangedEvents, ownerEmail, sendMail } from "../_shared/google.ts";
import { lookupForBrief, tierLabel } from "../_shared/hubspot.ts";
import { buildBrief, buildBriefHtml } from "../_shared/brief.ts";
import { tierOf } from "../_shared/score.ts";
import { sendDueDebriefs } from "../_shared/debrief.ts";

// Polled by pg_cron every minute. It reads Calendar changes since the last poll, and for each new
// meeting with an outside attendee it emails a private brief to the owner. The brief is NOT written
// into the calendar event, because guests (the prospect) can read an event's description.

const PAGE_URL = "https://copilot.f1rstword.com/";
const MAX_ATTEMPTS = 3;
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com",
  "me.com", "proton.me", "protonmail.com", "aol.com", "gmx.com", "zoho.com",
]);

const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";
const nameFromEmail = (e: string) => e.split("@")[0].replace(/[._+-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function ago(iso?: string): string | undefined {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return undefined;
  const d = Math.floor((Date.now() - t) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

async function getState(key: string): Promise<string | null> {
  const { data } = await sb.from("cp_state").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
const setState = (key: string, value: string) =>
  sb.from("cp_state").upsert({ key, value, updated_at: new Date().toISOString() });

function externalAttendees(ev: CalEvent) {
  const owner = ownerEmail();
  const ownerDomain = domainOf(owner);
  const ownerIsFreemail = FREEMAIL.has(ownerDomain);
  return (ev.attendees ?? []).filter((a) => {
    if (a.self || a.resource || a.responseStatus === "declined") return false;
    const email = a.email.toLowerCase();
    if (email === owner) return false;
    // With a personal Gmail owner, every other person counts as outside. Otherwise compare domains.
    return ownerIsFreemail ? true : domainOf(email) !== ownerDomain;
  });
}

async function research(domain: string) {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/research-account`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    },
    body: JSON.stringify({ domain }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`research ${res.status}`);
  return await res.json();
}

async function handle(ev: CalEvent): Promise<"briefed" | "skipped" | "retry"> {
  if (ev.status === "cancelled") return "skipped";
  const startIso = ev.start?.dateTime ?? ev.start?.date;
  if (!startIso || Date.parse(startIso) < Date.now()) return "skipped";

  const ext = externalAttendees(ev);
  if (!ext.length) return "skipped";

  const { data: existing } = await sb.from("cp_meetings").select("id,status,attempts").eq("calendar_event_id", ev.id).maybeSingle();
  if (existing?.status === "briefed") return "skipped";
  const attempts = (existing?.attempts ?? 0) + 1;

  const primary = ext[0];
  const email = primary.email.toLowerCase();
  const domain = domainOf(email);
  const attendeeName = primary.displayName ?? nameFromEmail(email);
  const business = !FREEMAIL.has(domain);

  await sb.from("cp_meetings").upsert({
    calendar_event_id: ev.id,
    title: ev.summary ?? "(no title)",
    starts_at: new Date(startIso).toISOString(),
    ends_at: ev.end?.dateTime ? new Date(ev.end.dateTime).toISOString() : null,
    attendee_email: email,
    attendee_domain: domain,
    attendee_name: attendeeName,
    status: "seen",
    attempts,
  }, { onConflict: "calendar_event_id" });

  // deno-lint-ignore no-explicit-any -- JSON payloads from external APIs
  let researched: any = null;
  if (business) {
    try {
      researched = await research(domain);
    } catch (e) {
      await log("warn", "brief_research_failed", { account: domain, message: (e as Error).message, detail: { attempts } });
      if (attempts < MAX_ATTEMPTS) {
        await sb.from("cp_meetings").update({ status: "failed", error: (e as Error).message }).eq("calendar_event_id", ev.id);
        return "retry";
      }
    }
  }

  const hubspot = await lookupForBrief(email, business ? domain : null).catch(() => null);

  let title: string | null = null;
  const accountId: string | null = researched?.account?.id ?? null;
  if (accountId) {
    const { data: person } = await sb.from("cp_people").select("title").eq("account_id", accountId).eq("email", email).maybeSingle();
    title = person?.title ?? null;
  }
  const account = researched?.account;
  const tz = ev.start?.timeZone ?? "UTC";
  const when = new Date(startIso).toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz,
  }) + ` (${tz})`;

  const briefInput = {
    company: account?.name ?? (business ? domain : "Personal email address"),
    domain: business ? domain : null,
    meetingTitle: ev.summary ?? "(no title)",
    when,
    attendee: { name: attendeeName, title },
    others: ext.slice(1).map((a) => a.displayName ?? nameFromEmail(a.email)),
    fit: researched?.dossier?.icp_fit?.score ?? account?.icp_score ?? null,
    priority: account?.priority_score ?? null,
    tierLabel: account?.priority_score != null ? tierLabel(tierOf(account.priority_score)) : "",
    dossier: researched?.dossier ?? null,
    // deno-lint-ignore no-explicit-any -- JSON payloads from external APIs
    signals: (researched?.signals ?? []).slice(0, 5).map((s: any) => ({
      kind: s.kind, title: s.title, age: ago(s.detail?.published),
    })),
    hubspot,
    pageUrl: PAGE_URL,
    note: !business
      ? "This attendee uses a personal email, so there is no company to research."
      : !researched ? "Research was unavailable, so this brief has less detail than usual." : undefined,
  };
  const brief = buildBrief(briefInput);

  const owner = ownerEmail();
  await sendMail(owner, `Brief: ${account?.name ?? domain} · ${attendeeName} · ${when.split(" (")[0]}`, brief, buildBriefHtml(briefInput));
  await sb.from("cp_meetings").update({
    status: "briefed", brief, account_id: accountId, emailed_at: new Date().toISOString(), error: null,
  }).eq("calendar_event_id", ev.id);
  await log("info", "brief_sent", { account: domain, detail: { attendees: ext.length, researched: !!researched, hubspot: !!hubspot } });
  return "briefed";
}

serve("meeting-brief", async (req) => {
  if (!(await jobAllowed(req))) return json({ error: "Not allowed" }, 401);
  const idle = (extra: Record<string, unknown> = {}) => {
    const r = json({ processed: 0, idle: true, ...extra });
    r.headers.set("x-noop", "1");
    return r;
  };
  if (!googleConfigured()) return idle({ error: "Google is not connected" });

  const polledAt = new Date().toISOString();
  // Always hand Google a strict RFC 3339 timestamp, whatever is stored.
  const stored = await getState("calendar_cursor");
  const parsed = stored ? new Date(stored) : null;
  const cursor = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : new Date(Date.now() - 86_400_000).toISOString();

  let events: CalEvent[] = [];
  try {
    events = await listChangedEvents(cursor);
  } catch (e) {
    await log("error", "calendar_poll_failed", { message: (e as Error).message });
    return json({ error: "Calendar poll failed" }, 502);
  }

  // Retry meetings that failed earlier (for example a research timeout).
  const { data: failed } = await sb.from("cp_meetings").select("calendar_event_id")
    .eq("status", "failed").lt("attempts", MAX_ATTEMPTS).gt("starts_at", polledAt).limit(3);
  for (const f of failed ?? []) {
    const ev = await getEvent(f.calendar_event_id);
    if (ev && !events.some((e) => e.id === ev.id)) events.push(ev);
  }

  const results: string[] = [];
  for (const ev of events) {
    try {
      results.push(await handle(ev));
    } catch (e) {
      await log("error", "brief_failed", { message: (e as Error).message, detail: { event: ev.id } });
      await sb.from("cp_meetings").update({ status: "failed", error: (e as Error).message.slice(0, 200) }).eq("calendar_event_id", ev.id);
      results.push("failed");
    }
  }

  // Keep a one-minute overlap so an event updated during this poll is never missed.
  await setState("calendar_cursor", new Date(Date.parse(polledAt) - 60_000).toISOString());

  // After a meeting ends, ask the owner how it went (once per meeting).
  const debriefs = await sendDueDebriefs().catch(async (e) => {
    await log("error", "debrief_step_failed", { message: (e as Error).message });
    return 0;
  });

  const briefed = results.filter((r) => r === "briefed").length;
  if (!debriefs && !briefed && !results.includes("failed") && !results.includes("retry")) return idle({ checked: events.length });
  await log("info", "calendar_poll", { detail: { events: events.length, briefed, debriefs, results } });
  return json({ processed: events.length, briefed, debriefs });
});
