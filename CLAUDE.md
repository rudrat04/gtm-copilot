# Account Copilot: project notes for Claude

A portfolio project that starts conversations with B2B SaaS clients (freelance work and job hunting). One simple, demo-able system: research a company, rank accounts by buying signals, find and enrich the right people, push everything to HubSpot, and (next) brief the rep before meetings. Keep it simple. It is not a company product, so do not build an ecosystem.

Owner: Rudra (rudrat04 on GitHub). Public repo: https://github.com/rudrat04/gtm-copilot. Live page (GitHub Pages from `docs/`): https://rudrat04.github.io/gtm-copilot/

## Working rules (important)
- **Never print or paste secrets** (`.env`, tokens, the owner key). Read them inside shell commands only. `.env` is gitignored; `.env.example` lists the names.
- **Ask before** spending Hunter credits, deleting anything in HubSpot, or publishing new public content. Anthropic spend is capped, but still mention cost when it is more than a few cents.
- **No automatic sending.** Nothing emails anyone. Drafts live in the database and in HubSpot notes only.
- Python's `urllib` has an SSL problem on this Mac. Use `curl` for HTTP calls from the shell.
- Commits end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- The user prefers short, plain-English answers and wants to be asked before big decisions.

## Stack and IDs
- **Supabase** project `gtm-copilot`, ref `tecgblsoylrshcqneevf` (Mumbai, free). Tables are prefixed `cp_`. Edge Functions, `pg_cron`, `pg_net`.
- **HubSpot** portal "Firstword" (247578382, app-na2). Free plan. API via a Service Key in `.env`.
- **Hunter.io** free plan (50 credits a month) for people search and emails.
- **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) for all AI, with a $1/day cap in the database. About $0.006 per dossier. Total spend so far is well under $1.
- Apollo free plan: People API Search is blocked on the free plan, so Apollo is not used. It can be added later as one adapter.
- Clay free has no usable API, so it is not used.

## Structure
```
docs/index.html            The whole UI (static, GitHub Pages). Tabs: Research, Queue, ICP & Signals
supabase/functions/
  research-account/        Domain in, dossier out (cached 24h)
  signal-scan/             Weekly scan: signals, score, AI draft for accounts scoring 30+
  queue/                   Queue list, reject, ICP playbook data, schedule info
  people/                  find, enrich, preview, push, rerank, status
  _shared/                 db, log, auth, claude, signals, relevance, score, draft, people, hubspot, icp.json
supabase/migrations/       Schema, logging, people, weekly schedule
supabase/seed.sql          46 fixture companies
data/fixtures/companies.json
backups/                   Local HubSpot backup (gitignored)
```
`supabase/functions/_shared/icp.json` is the single place to re-point the ICP (company profile, personas, signal weights, tiers, schedule, AI budget).

## How it works
1. **Research**: collects site text, public job boards (Greenhouse/Lever/Ashby), news, Hacker News. One small AI call (`relevance.ts`) drops namesake noise. Haiku writes the dossier JSON, stored in `cp_dossiers`.
2. **Signal scan**: scores each account 0-100 with fixed weights (hiring 40, funding news 25, community 10, baseline fit 15). Older news counts less. Score 30+ enters the Queue with an AI draft. Tiers: 70+ Tier 1, 45+ Tier 2.
3. **Find relevant people**: one Hunter domain search (1 credit), ranked by job title against the personas. Results are stored in `cp_people`.
4. **Enrich**: reveals the stored email. Phone is not available on free providers (the button is disabled).
5. **Push to HubSpot** (owner only): creates or updates the company and the enriched contacts, links them, and attaches a note built from the stored dossier JSON (no AI). Fills the existing `gtm_*` fields (fit, priority, signal, intent, why now, why fit, last scored; contact persona and persona score) plus the native ICP tier. Re-push updates scores only, never lifecycle stage or owner.
6. **Public vs owner**: public visitors see "First L." names, masked emails, and dry runs. The owner key (`ADMIN_KEY` in `.env`, sent as the `x-admin-key` header, entered via "unlock" on the page) reveals emails and writes to HubSpot.

## Commands
```bash
# Deploy a function (uses the Supabase CLI via npx; login already done)
npx --yes supabase functions deploy <name> --use-api --project-ref tecgblsoylrshcqneevf
# Push .env values to Supabase secrets
npx --yes supabase secrets set --env-file .env
# Local preview of the page
python3 -m http.server 8080 --directory docs
```
Database changes go through migrations in `supabase/migrations/` and are applied to the project (Supabase MCP `apply_migration`, or the CLI).

## Debugging and cost control
Every function run logs to `cp_logs` with a `run_id`; failed requests return that id. Useful queries are in the README ("Debugging and cost control"): `select * from cp_recent_problems;`, `select * from cp_log_summary;`, AI spend from `cp_ai_usage`, Hunter usage from `cp_provider_usage`.

The `signal-scan` cron runs **weekly: Mondays 06:00-06:55 UTC** (every 5 minutes in that hour, 6 companies per run). It costs about $0.05 a week. To pause or resume: `select cron.alter_job((select jobid from cron.job where jobname = 'signal-scan'), active := false);` (true to resume).

## Current state (as of 10 Oct 2026)
- Module 1 (Research), Module 2 (Signal Radar with people, enrich, push), logging, weekly schedule and the ICP & Signals tab are built, tested live and pushed.
- Test data in HubSpot: companies Clay and Attio, and one real contact (Drew Peterson, VP Sales at Attio). Delete if not wanted.
- Hunter credits: about 48 of 50 left this month (resets monthly).

## Next steps
1. **Module 3, Meeting Brief**: when a meeting with an external attendee is booked in Google Calendar, write a brief into the event description within about a minute (poll Calendar with pg_cron, reuse the dossier and HubSpot history, optional email). Needs a one-time Google OAuth setup (Calendar read/write, Gmail optional). The demo "prospect" attendee is rudra@f1rstword.com. Free-mail attendees need a name or HubSpot fallback.
2. Optional: Revival module (closed-lost deals plus fresh signals), team-page fallback for people search, Gmail drafts, Apollo adapter when the plan allows.

## Known gaps
- Each push adds a new dossier note to the company (history builds up).
- Companies with very generic names can still pull in some unrelated news despite the relevance check.
- Phone numbers are not available (needs a paid provider).
- Hunter's seniority labels are unreliable, so ranking uses our own title rules in `_shared/people.ts`.
- Old unused HubSpot property group `gtm_intelligence` came from an earlier project and is now reused.
- An unrelated old repo (`gtm-automation-project-1`) may still send failure emails from a scheduled workflow. It is not part of this project.
