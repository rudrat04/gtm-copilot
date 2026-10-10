# Account Copilot

A small, demo-able GTM system for B2B SaaS teams. It finds the right accounts at the right time from public buying signals, researches them in seconds, finds and enriches the right people, and pushes everything to HubSpot. **Outreach stays manual: nothing is ever sent to a prospect.** Live demo: https://copilot.f1rstword.com

## What it does

| Tab / flow | What happens |
|---|---|
| **Today** | A capped daily list (8) that leads with **the person to contact** (name, title, email) and shows the company as context: meetings, follow-ups due (day 3/7/14), hot new signals, accounts worth a second look. Each item has a one-line "Why today". |
| **Research** | Type any company domain, get a dossier in about 10 seconds (what they do, hiring, news, pains, talk tracks, risks, ICP fit). |
| **Queue** | Companies ranked 0-100 by buying signals with tiers, real size and funding (headcount, stage, money raised, HQ), signal ages, a draft-email button, and lifecycle buttons (contacted, replied, meeting, snooze, not now). |
| **People** | On any account: Find relevant people, Enrich the email, preview what will go to HubSpot, Push. No AI is used for the push. |
| **ICP & Signals** | The playbook for the sales team: target profile, personas, signals and weights, how to read the scores. |
| **Meeting briefs** | When a meeting with an outside guest is booked in Google Calendar, a private brief is emailed to the owner within about a minute. It is never written into the invite, because guests can read it. |
| **Daily rhythm** | Light check with instant hot alerts, a morning email, and HubSpot to-dos for the rep. |

## How a day runs (UTC; India time in brackets)

| When | Job | Result |
|---|---|---|
| every minute | `meeting-brief` | Briefs for newly booked meetings |
| 01:00 (06:30) | `signal-watch` | Re-reads sources for queued accounts, stores only new signals, up to 3 hot-alert emails a day |
| 02:30 (08:00) | `daily-digest` | Today list emailed to the owner, plus HubSpot to-dos (a daily summary and one per prospect already in HubSpot) |
| Mondays 06:00-06:55 (11:30) | `signal-scan` | Full scan of the ICP list, scores and queues accounts |
| daily 03:17 | `cp-logs-cleanup` | Deletes logs older than 30 days |

Everything emails the owner only. Public visitors can browse; changing anything or revealing emails needs the owner key.

## Stack and cost

Supabase (Postgres, Edge Functions, pg_cron), HubSpot Free, Hunter free plan (people search and emails), Google Calendar and Gmail (owner-only), Claude Haiku 4.5. AI is used only for the dossier (about $0.006), the relevance check (about $0.0004 per company), the one "Why today" sentence, and draft emails when you click for one. A $0.25 daily cap is enforced in the database. Total spend so far is well under $1; expect roughly $1-2 a month.

## Company facts and the ICP

Headcount, funding stage, funds raised and HQ come from Hunter's company data (about 0.2 credit per company, saved once). They make up the fit part of the priority score: size inside the target range, stage Seed to Series B, and region. Companies clearly outside the size range are left out of Today and of automatic contact lookups, but stay visible in the Queue.

## Who to contact

Today, hot alerts and the morning email lead with a person. Contacts come from the stored people search (best match first, then the best from a different persona; individual contributors are never suggested, and a founder only counts as the buyer at a small company). For strong, in-profile accounts with no contact yet, the daily jobs look one up automatically, at most 2 a day, to protect the 50 free monthly search credits.

## Configuration

One file, `supabase/functions/_shared/icp.json`, holds the seller pitch, target company profile, personas, signal weights, tiers, follow-up days, Today list size, alert limits, schedule text, owner details and the AI budget. Re-pointing the system at a client's market means editing this file. Message formats (morning email, alerts, HubSpot task text) are in `supabase/functions/_shared/templates.ts`.

## Run it yourself

1. Create a Supabase project, apply `supabase/migrations/` in order, and load `supabase/seed.sql`.
2. Copy `.env.example` to `.env` and fill it in (HubSpot service key, Anthropic key, Hunter key, owner key, Google OAuth client).
3. `node scripts/google-auth.mjs` signs in to Google once and saves the refresh token.
4. `npx supabase secrets set --env-file .env`, then deploy each function with `npx supabase functions deploy <name> --use-api --project-ref <ref>`.
5. Serve `docs/` with any static host (GitHub Pages works).

## Debugging

Every function run writes structured rows to `cp_logs` with a `run_id` that failed requests return.

```sql
select * from cp_recent_problems limit 50;                       -- what went wrong recently
select * from cp_log_summary;                                    -- 24-hour health
select created_at, level, event, message, detail from cp_logs where run_id = '<run_id>' order by id;
select feature, count(*), round(sum(cost_usd)::numeric, 4) usd from cp_ai_usage group by feature;
```

Pause or resume any job with `select cron.alter_job((select jobid from cron.job where jobname = '<name>'), active := false);` (true to resume).

## Security

- **Two doors, two keys.** Public visitors can read; changing anything or seeing full names and emails needs the owner key (`x-admin-key`). Scheduled jobs (`signal-scan`, `meeting-brief`, `daily-digest`) reject everyone except the scheduler, which sends a secret that lives only in the database (`cp_state`) and is read by the functions with the service role.
- **Public endpoints cannot burn credits.** Fresh research is rate limited (6 per person per hour, 40 a day overall); saved results are free. A $0.25 daily AI cap and a monthly Hunter cap apply on top.
- **Secrets stay out of logs and URLs.** The Hunter key travels in a header, never in a URL, and every log line is scrubbed for keys, tokens and long hex strings before it is stored. Raw IP addresses are never stored.
- **Database:** every table has row level security with no public policies, so only the server can read or write. Views use `security_invoker`.
- **Page:** a content security policy limits it to talking to this project's backend only; all dynamic text is escaped.
- Public views show names as "First L." with emails masked to the domain.

## Checks

```bash
bash scripts/smoke.sh                       # 24 security and behaviour checks against the live project, no credits used
cd supabase/functions && deno lint . && deno check <function>/index.ts
SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x deno run --allow-env --allow-write scripts/preview-emails.ts /tmp/emails   # render the three emails to HTML
```

## Principles

Outreach is human. The system only says who to contact, why now, and what to say. Every number is explainable: scores come from fixed weights, not a black box. Public visitors never see full names or emails.
