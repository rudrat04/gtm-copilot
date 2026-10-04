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
