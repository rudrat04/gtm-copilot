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
- **Keep this file current.** When a module is finished, a decision changes, or a key, command or ID changes, update "Current state", "Next steps" and any affected section in the same commit. Keep it short: a briefing note, not a log.

## Stack and IDs
- **Supabase** project `gtm-copilot`, ref `tecgblsoylrshcqneevf` (Mumbai, free). Tables are prefixed `cp_`. Edge Functions, `pg_cron`, `pg_net`.
- **HubSpot** portal "Firstword" (247578382, app-na2). Free plan. API via a Service Key in `.env`.
- **Hunter.io** free plan (50 credits a month) for people search and emails.
- **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) for all AI, with a $1/day cap in the database. About $0.006 per dossier. Total spend so far is well under $1.
- Apollo free plan: People API Search is blocked on the free plan, so Apollo is not used. It can be added later as one adapter.
- Clay free has no usable API, so it is not used.
- **Google** (Calendar read, Gmail send-to-self): OAuth app `account-copilot` in Google Cloud, published "In production" (unverified, owner only; no 7-day token expiry). Signed-in account: triveditrudra4@gmail.com. Credentials and refresh token live in `.env` (`GOOGLE_*`); re-run `node scripts/google-auth.mjs` if sign-in ever expires.
- **Domain**: the page is served at https://copilot.f1rstword.com (GitHub Pages custom domain; CNAME in the f1rstword.com DNS, managed at NS1/Netlify DNS, registrar GoDaddy). `docs/privacy.html` exists for the Google consent screen.

## Structure
```
docs/index.html            The whole UI (static, GitHub Pages). Tabs: Research, Queue, ICP & Signals
supabase/functions/
  research-account/        Domain in, dossier out (cached 24h)
  signal-scan/             Weekly scan: signals, score, AI draft for accounts scoring 30+
  queue/                   Queue list, reject, ICP playbook data, schedule info
  people/                  find, enrich, preview, push, rerank, status
  meeting-brief/           Polls Calendar every minute; emails a private brief to the owner
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
6. **Meeting Brief**: `meeting-brief` polls Google Calendar (cursor in `cp_state`); for a new future event with an outside attendee it reuses the cached dossier (researches a new company once), checks HubSpot (read-only), builds a plain template brief (no AI beyond the dossier) and emails it to the owner. Briefs are **never written into the calendar event** because guests can read the description. Personal-email attendees get a short note. Failed briefs retry up to 3 times.
7. **Public vs owner**: public visitors see "First L." names, masked emails, and dry runs. The owner key (`ADMIN_KEY` in `.env`, sent as the `x-admin-key` header, entered via "unlock" on the page) reveals emails and writes to HubSpot.

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
- Module 1 (Research), Module 2 (Signal Radar with people, enrich, push), Module 3 (Meeting Brief), logging, weekly schedule and the ICP & Signals tab are built, tested live and pushed. The brief was tested end to end with a calendar event inviting rudra@f1rstword.com.
- Test data in HubSpot: companies Clay and Attio, and one real contact (Drew Peterson, VP Sales at Attio). Delete if not wanted.
- Hunter credits: about 48 of 50 left this month (resets monthly).

## Next steps (agreed order)
Philosophy: outreach stays manual and human; the system finds the right prospect at the right time (speed to lead). The prospect-facing draft email stays AI-written and is only a suggestion. Internal items use templates plus one AI line, "Why contact today" (cached per account, only regenerated when signals change).
1. **Account lifecycle**: statuses (contacted, replied, meeting, snoozed, not now), next follow-up date, one-click buttons on cards, and outcome logging.
2. **Today engine and "Today" tab**: capped daily list (5-8): new and hot, follow-ups due (day 3/7/14, max 3 touches), meetings today, worth reviving. Rules only, no AI except the "Why today" line.
3. **Daily light check and "Hot now"**: cheap daily look at Tier 1/2 accounts; signals first seen in the last 48h become Hot.
4. **HubSpot tasks and morning email digest** (to the owner only, via the Google sign-in). Check the HubSpot key can create tasks first. Formats are agreed: morning email, task title/body, instant hot alert (see conversation history if needed: sections NEW AND HOT, FOLLOW-UPS DUE, MEETINGS).
5. **Inbound speed to lead** (form submit enriched and routed in about a minute), **outcome feedback page**, **Revival** (closed-lost deals plus fresh signals).
Also optional: team-page fallback for people search, Apollo adapter when the plan allows.

## Known gaps
- Each push adds a new dossier note to the company (history builds up).
- Brief questions come from dossier talk tracks; the prompt forbids "you mentioned"-style claims, but old cached dossiers may still contain them (refresh the dossier to regenerate).
- Companies with very generic names can still pull in some unrelated news despite the relevance check.
- Phone numbers are not available (needs a paid provider).
- Hunter's seniority labels are unreliable, so ranking uses our own title rules in `_shared/people.ts`.
- Old unused HubSpot property group `gtm_intelligence` came from an earlier project and is now reused.
- An unrelated old repo (`gtm-automation-project-1`) may still send failure emails from a scheduled workflow. It is not part of this project.
