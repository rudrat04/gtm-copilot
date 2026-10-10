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
- **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) for all AI, with a $0.25/day cap in the database. About $0.006 per dossier. Total spend so far is well under $1.
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
  discover/                Weekly: finds new companies (HN Who is hiring), qualifies, adds them
  meeting-brief/           Polls Calendar every minute; emails a private brief to the owner
  _shared/                 db, log, auth, claude, signals, relevance, score, draft, people, hubspot, icp.json
supabase/migrations/       Schema, logging, people, weekly schedule
supabase/seed.sql          46 fixture companies
backups/                   Local HubSpot backup (gitignored)
```
`supabase/functions/_shared/icp.json` is the single place to re-point the ICP (company profile, personas, signal weights, tiers, schedule, AI budget).

## How it works
1. **Research**: collects site text, public job boards (Greenhouse/Lever/Ashby), news, Hacker News. One small AI call (`relevance.ts`) drops namesake noise. Haiku writes the dossier JSON, stored in `cp_dossiers`.
2. **Signal scan**: scores each account 0-100 with fixed weights (hiring 40, funding news 25, community 10, baseline fit 15). Older news counts less. Score 30+ enters the Queue with a plain-English `why_now` (template, no AI). Draft emails are written on demand (`queue` -> `draft`, owner only, about 1 cent, saved). Tiers: 70+ Tier 1, 45+ Tier 2.
3. **Find relevant people**: one Hunter domain search (1 credit), ranked by job title against the personas. Results are stored in `cp_people`.
4. **Enrich**: reveals the stored email. Phone is not available on free providers (the button is disabled).
5. **Push to HubSpot** (owner only): creates or updates the company and the enriched contacts, links them, and attaches a note built from the stored dossier JSON (no AI). Fills the existing `gtm_*` fields (fit, priority, signal, intent, why now, why fit, last scored; contact persona and persona score) plus the native ICP tier. Re-push updates scores only, never lifecycle stage or owner.
6. **Meeting Brief**: `meeting-brief` polls Google Calendar (cursor in `cp_state`); for a new future event with an outside attendee it reuses the cached dossier (researches a new company once), checks HubSpot (read-only), builds a plain template brief (no AI beyond the dossier) and emails it to the owner. Briefs are **never written into the calendar event** because guests can read the description. Personal-email attendees get a short note. Failed briefs retry up to 3 times.
7. **Lifecycle and Today**: accounts have `outreach_status` (open, contacted, replied, meeting, snoozed, not_now), `touches`, `contacted_at` (first contact), `next_followup_at` (day 3/7/14 after first contact, then stop) and `snoozed_until`. Actions go through `queue` -> `outcome` (`_shared/lifecycle.ts`) and are logged in `cp_outcomes`. `queue` -> `today` (`_shared/today.ts`) builds the capped Today list by rules; the one AI line ("Why today") is cached in `cp_why_today` per signal set and only generated in owner mode. The Today tab is the landing tab.
8. **Daily rhythm**: cron `signal-watch` (01:00 UTC) calls `signal-scan` with `{"mode":"light"}` (`_shared/watch.ts`): re-reads sources for queued accounts, stores only new signals, refreshes scores, sends up to 3 instant hot-alert emails/day (`cp_alerts` dedupes). Cron `daily-digest` (02:30 UTC) emails the Today list to the owner and creates HubSpot to-dos (`_shared/templates.ts`, `createTask` in `hubspot.ts`): a daily summary task plus per-prospect tasks only for accounts already in HubSpot (`cp_tasks` dedupes). Both throttle to once per 20h unless called with the owner key. They only email the owner.
9. **Company facts**: `_shared/firmo.ts` fetches Hunter company data once per company (0.2 credit; owner-only bulk action `queue` -> `enrich_companies`, or when the owner researches a new domain) into `cp_accounts` (employees, employee_band, stage, raised_usd, last_round_date, founded_year, hq_city, country, firmo_at). `fitBreakdown` turns it into the 25-point fit slice of the priority score (size 10, stage 10, region 5; unknown = neutral baseline 15). `queue` -> `enrich_companies` with `rescore: true` recomputes all priorities.
10. **Prospect-based Today/alerts**: Today items carry `contacts` (`_shared/contacts.ts`): best person first, then best of another persona, relevance >= 50 only. `autoFindContacts` runs a Hunter people search for strong, in-profile accounts with no people yet, max `icp.contacts.autoPerDay` (2) a day; used by `daily-digest` and the hot alerts. Freshness uses a news item's publish date, ignores Hacker News and open-role COUNT changes (those rows are shown as "Currently: ..."), and Today skips accounts clearly outside the size range. `daily-digest` accepts `{"dry":true}` with the owner key to preview the email without sending or spending credits.
11. **Auto-discovery** (`_shared/discover.ts`, function `discover`, cron `discover` Mondays 05:00 UTC, an hour before the scan): reads the latest two HN "Who is hiring" threads, keeps posts that name sales/RevOps roles and a company site, skips known domains, then one Haiku call per candidate (about $0.001) decides if it is a B2B software company. Passing ones get 0.2 Hunter credit of company facts (max 4 a run; the owner can pass `{"firmo":false}` or `{"dry":true}`) and are dropped if clearly outside size/stage; the rest are inserted into `cp_accounts` with `source = 'discovered'`. Every decision and reason is in `cp_discovered` (shown on the ICP & Signals tab). While the post is under `discovery.maxAgeDays` old it counts as a hiring signal (12 pts, `collectSignals`). Config: `icp.json` -> `discovery`.
12. **Public vs owner**: public visitors see "First L." names, masked emails, and dry runs. The owner key (`ADMIN_KEY` in `.env`, sent as the `x-admin-key` header, entered via "unlock" on the page) reveals emails and writes to HubSpot.

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

## Security and quality rules (keep these true)
- Owner = `x-admin-key` header (`ADMIN_KEY`). The page sends it only after the owner clicks unlock. CORS must keep allowing `x-admin-key` (`_shared/db.ts`), or owner mode silently breaks in browsers.
- Scheduled endpoints use `jobAllowed` (`_shared/auth.ts`): owner key OR `x-cron-secret`, checked against `cp_state.cron_secret`. The cron jobs read the secret from that row inside their SQL, so it is never in the repo. If you recreate a cron job, include the header (see `supabase/migrations/20261012000001_security_hardening.sql`).
- Public fresh research is rate limited via `rateOk` (`cp_rate` table). Public views must never show full names or emails (`contactsFor`, `people` view).
- Hunter calls use the `X-API-KEY` header, not a URL parameter. `log()` redacts secrets; do not log request URLs or bodies with credentials.
- Before finishing any change run: `bash scripts/smoke.sh` (25 checks), `deno lint .`, and `deno check` on each function (use `npx deno`). All must be clean. The deploy bundler does NOT type-check.
- Emails are multipart (plain text + HTML) via `sendMail(to, subject, text, html)`; HTML blocks live in `_shared/emailhtml.ts`, templates in `_shared/templates.ts` and `_shared/brief.ts`. Preview with `scripts/preview-emails.ts`. They only ever go to the owner.

## UI rules (docs/index.html, one static file)
- **Today is people-only** for new signals: an account with no contact (relevance 50+) is not shown as a card; it goes to `needs` (footer line, links to Queue "Needs a contact" filter). Follow-ups and meetings always show. `buildToday(admin, {autoFind})` runs the capped Hunter lookup (digest only). Signal ages are coloured: green <14 days, amber 14-30, red older. Follow-up cards show the due line instead of the "Why today" box.
- One primary action per card, chosen from what we know: no contact -> "Find relevant people"; contact known -> "Mark contacted"; parked -> "Reopen". Everything else is in the "More" menu. Never show a button for something the card already shows.
- Signals are a short list (3 shown, "Show N more"), not badges. Company facts on one line. Feedback is a toast, not inline text. Today leads with the person; Queue leads with the company.
- Keep the content security policy meta tag; escape all dynamic text with `esc()`; headings inside panels use `<p class="label">`.
- Test owner mode in a browser without exposing the key: copy the page to a temp folder, drop the CSP tag, and load the key from a temp `key.json` (see the git history of this change). Delete the temp folder afterwards.

## Debugging and cost control
Every function run logs to `cp_logs` with a `run_id`; failed requests return that id. Useful queries are in the README ("Debugging and cost control"): `select * from cp_recent_problems;`, `select * from cp_log_summary;`, AI spend from `cp_ai_usage`, Hunter usage from `cp_provider_usage`.

The `signal-scan` cron runs **weekly: Mondays 06:00-06:55 UTC** (every 5 minutes in that hour, 6 companies per run). It costs about $0.05 a week. To pause or resume: `select cron.alter_job((select jobid from cron.job where jobname = 'signal-scan'), active := false);` (true to resume).

## Current state (as of 10 Oct 2026)
- Module 1 (Research), Module 2 (Signal Radar with people, enrich, push), Module 3 (Meeting Brief), logging, weekly schedule and the ICP & Signals tab are built, tested live and pushed. The brief was tested end to end with a calendar event inviting rudra@f1rstword.com.
- Test data in HubSpot: companies Clay and Attio, and one real contact (Drew Peterson, VP Sales at Attio). Delete if not wanted.
- Hunter credits: about 48 of 50 left this month (resets monthly).

## Next steps (agreed order, revised 13 Oct 2026)
Vision: the system finds companies and prospects, hands the rep a ready pipeline, and enables them (brief, recap, drafts) so reps spend time on people. Order now: 1) auto-discovery (DONE, first version: HN hiring only), 2) rename Queue to Accounts as a compact table plus board, 3) Meeting debrief + HubSpot status sync (lead status, deals, tasks, read-back) with a Meetings tab, 4) inbound speed to lead, 5) Insights tab, 6) Revival, lookalikes, competitor cards. More discovery sources (funding news, Launch HN) are possible.

Older list:
Philosophy: outreach stays manual and human; the system finds the right prospect at the right time (speed to lead). The prospect-facing draft email stays AI-written and is only a suggestion. Internal items use templates plus the one cached AI line.
1. DONE: lifecycle, Today list and tab, daily light check and hot alerts, morning email, HubSpot to-dos, clean-up pass (README rewritten, dossier no longer asks for likely_buyers, drafts on demand, AI cap lowered, statuses tightened).
2. DONE: firmographics (Hunter) feeding the ICP fit, and prospect-first Today/alerts/digest.
3. **Sync outcomes to HubSpot** (contacted, replied, meeting as notes or lifecycle changes) and detect completed HubSpot tasks; also optionally detect replies from HubSpot activity.
4. **Inbound speed to lead**: a form submit is enriched, scored and routed to the owner (email plus HubSpot task) in about a minute.
5. **Outcome feedback page**: which signals convert, from `cp_outcomes`; tune weights from real results.
6. **Revival**: closed-lost deals plus fresh signals as another Today source.
Also optional: team-page fallback for people search, Apollo adapter when the plan allows.

## Known gaps
- (Resolved) Size and stage ARE now enforced via Hunter company data; remaining caveat: Hunter's headcount can be off (it said 30 for Clay), so treat it as an estimate. The old note follows: **The ICP size and stage were not enforced.** icp.json states 20-200 employees and Seed to Series B, but fit is judged by the AI from website text only; there is no headcount or funding data source on the free plans. Ideas: a manual column on the fixture list, or a free enrichment source.
- Priority uses a fixed baseline fit; the dossier's ICP fit is not fed back into it.
- Each push adds a new dossier note to the company (history builds up).
- Namesake companies (Orb, Linear, Default) can still leak wrong news despite the relevance check; it was tightened once, watch for more.
- Brief questions come from dossier talk tracks; the prompt forbids "you mentioned"-style claims, but old cached dossiers may still contain them (refresh the dossier to regenerate).
- Companies with very generic names can still pull in some unrelated news despite the relevance check.
- Phone numbers are not available (needs a paid provider).
- Hunter's seniority labels are unreliable, so ranking uses our own title rules in `_shared/people.ts`.
- Old unused HubSpot property group `gtm_intelligence` came from an earlier project and is now reused.
- An unrelated old repo (`gtm-automation-project-1`) may still send failure emails from a scheduled workflow. It is not part of this project.
