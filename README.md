# Account Copilot

A small, demo-able GTM system for B2B SaaS teams: find the right accounts, understand them in seconds, approve outreach, and walk into every meeting prepared. One Supabase database, one tiny UI, HubSpot as the CRM. Nothing is ever sent automatically.

## Modules

1. **Account Research**: type a company domain, get a sales-ready dossier (what they do, hiring, news, pains, talk tracks, likely buyers).
2. **Signal Radar**: a nightly scan of an ICP list, ranked by "why now". Approve an account and it lands in HubSpot with an email draft.
3. **Meeting Brief**: when a meeting with an external attendee is booked in Google Calendar, a brief is written into the event within about a minute.
4. **Revival** (stretch): lost deals plus fresh signals, with a re-engagement draft.

## Stack

Supabase (Postgres, Edge Functions, pg_cron), HubSpot Free, Apollo Free (cached, optional), Google Calendar and Gmail, Claude Haiku 4.5 with a hard daily spend cap. A fixture mode lets every module run with no credits spent.

## ICP (configurable in `supabase/functions/_shared/icp.json`)

B2B SaaS and tech companies, 20-200 employees, Seed to Series B, US/UK/EU, hiring sales roles. Personas: Head of Sales/VP Sales, Head of RevOps, Founder/CEO at companies under about 30 people.

## Status

Modules 1 (Account Research) and 2 (Signal Radar) are live: `docs/index.html` calls the `research-account`, `signal-scan` and `queue` Edge Functions. Module 3 (Meeting Brief) is next.

## Debugging and cost control

Every function run writes structured rows to `cp_logs` (function, level, event, company domain, message, details, duration). Each run has one `run_id`, and failed requests return it, so you can replay exactly what happened. Logs are kept for 30 days. No secrets or email addresses are logged.

```sql
-- What went wrong recently?
select * from cp_recent_problems limit 50;

-- Replay one run end to end (use the run_id from an error response)
select created_at, level, event, account, message, detail from cp_logs where run_id = '<run_id>' order by id;

-- Everything about one company
select created_at, fn, level, event, detail from cp_logs where account = 'attio.com' order by id desc limit 50;

-- 24-hour health summary
select * from cp_log_summary;

-- AI spend by feature
select feature, count(*), round(sum(cost_usd)::numeric, 4) as usd from cp_ai_usage group by feature;
```

Common events: `fetch_failed` (a source was down or timed out), `relevance_fallback` (the AI relevance check failed, so unfiltered headlines were used), `json_parse_failed` (the model returned bad JSON), `hubspot_request_failed` / `hubspot_note_skipped`, `budget_reached` (daily AI cap hit), `unhandled_exception` (a bug, with stack trace).

The nightly scan is **paused** to avoid spending AI credits while building. Before a demo:

```sql
select cron.alter_job((select jobid from cron.job where jobname = 'signal-scan'), active := true);   -- resume
select cron.alter_job((select jobid from cron.job where jobname = 'signal-scan'), active := false);  -- pause
```

## People: find, enrich, push

On a dossier (or a Queue card), **Find relevant people** searches a contact database (Hunter free plan, 1 credit per company) for the ICP personas, ranks them by job title, and stores the results. **Enrich** reveals the email of a chosen person (no extra credit, and phone is shown as unavailable on the free provider). **Push to HubSpot** appears only after enriching and creates the company, the enriched contacts (associated to it), and a note built from the stored dossier JSON. No AI credits are used for the push.

- Data sources sit behind one interface (`supabase/functions/_shared/people.ts`), so adding Apollo or another provider means adding one adapter.
- Public visitors see names as "First L." with masked emails, and Enrich/Push run as dry runs. Only the owner key reveals emails or writes to HubSpot.
- Hunter usage is capped by `HUNTER_MONTHLY_CAP` (default 40 of 50) and every call is recorded in `cp_provider_usage`.
- Pushes fill the existing HubSpot fields: company Fit, Priority, Signal and Intent scores, ICP tier, Fit industry, Why now, Why fit and Last scored at; contact Scored persona and Persona score. Re-pushing updates scores only and never changes lifecycle stage or owner.
- A "What will go to HubSpot" preview shows these values before anything is written.

## Weekly scan and signal freshness

The scan runs every Monday 06:00-06:55 UTC (12 runs of 6 companies). Accounts count as stale after 6 days. Each Queue card shows when the company was last scanned and how old each signal is (published date for news, first-seen date otherwise), with a NEW badge for anything first seen in the last 7 days. Older evidence counts for less: news after 30 days counts half, after 60 days nothing.
