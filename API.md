# API notes

Everything is a `POST` with a JSON body to `https://tecgblsoylrshcqneevf.supabase.co/functions/v1/<function>`. Browsers send the project's publishable key as `apikey`; it is public by design.

## Who can call what

| Caller | How | Can do |
|---|---|---|
| **Public** | `apikey` header only | Read (names as "First L.", emails masked), try research and the inbound form, dry runs of write actions |
| **Owner** | plus `x-admin-key: <ADMIN_KEY>` | Everything: reveal emails, write to HubSpot, record outcomes, save Setup, run discovery |
| **Scheduler** | `x-cron-secret: <secret from cp_state>` (or the owner key) | The jobs: `signal-scan`, `discover`, `daily-digest`, `meeting-brief`, `crm-sync` |
| **One-tap link** | signed `#debrief=<meeting>&o=<outcome>&s=<hmac>` | Records one debrief outcome for one meeting, nothing else |

A write attempted without the owner key returns `{"mode":"dry_run","message":"..."}` and changes nothing. Errors return `{"error":"...", "run_id":"..."}`; the `run_id` finds the run in `cp_logs`.

## Inbound lead webhook (for a client's own form)

```bash
curl -X POST https://tecgblsoylrshcqneevf.supabase.co/functions/v1/inbound \
  -H "Content-Type: application/json" -H "apikey: <publishable key>" \
  -d '{
    "name": "Alex Doe",
    "email": "alex@acme.com",
    "company": "Acme",
    "role": "Head of Sales",
    "intent": "demo",
    "message": "We would like to see how it works.",
    "source": "pricing page"
  }'
```

| Field | Notes |
|---|---|
| `name`, `email` | Required. A valid email is checked. |
| `company`, `role`, `message` | Optional. At most 3 links in a message, or it is treated as spam. |
| `intent` | `demo`, `pricing` or `question` (default `question`). A demo or pricing request from a business email is routed as a hot lead. |
| `source` | Free text, shown in the Inbound tab. |
| `utm_source`, `utm_medium`, `utm_campaign` | Optional. Short words (60 characters at most). Shown to the owner as "Came from ...", in the alert email and in the HubSpot to-do. |
| `referrer`, `page` | Optional. Send `document.referrer` and `location.pathname`. Only the referrer's host and the page path are kept; query strings and tokens are dropped. |
| `website` | Honeypot. Leave empty; a filled value is silently ignored. |

Response (about 10 to 12 seconds, because the company is checked first):

```json
{ "ok": true, "id": "…", "label": "hot", "label_text": "Hot lead", "duplicate": false,
  "timeline": [ { "step": "Received", "detail": "asked for a demo", "ms": 98 }, … ] }
```

Limits: 5 submissions per person per hour, 40 an hour and 100 a day overall (HTTP 429 past that). The same email twice in a day is one lead (`duplicate: true`). Not-fit leads (outside the profile, or disposable addresses) alert nobody.

## Functions and actions

| Function | Actions (`"action": …`) |
|---|---|
| `inbound` | none (submit a lead), `list`, `respond` (owner: `contacted`, `replied`, `closed`) |
| `research-account` | `{"domain": "linear.app"}`, public, rate limited |
| `queue` | `today`, `accounts`, `draft`, `outcome` (owner), `setup`, `profile_save` (owner), `run_discovery` (owner), `enrich_company` / `enrich_companies` (owner), `meetings`, `debrief` (owner or signed link), `icp` |
| `people` | `find`, `enrich`, `preview`, `push` (owner), `rerank`, `status` |
| `meeting-brief`, `daily-digest`, `signal-scan`, `discover`, `crm-sync` | Scheduled jobs. The owner can run them by hand; `daily-digest` and `discover` accept `{"dry": true}`; `meeting-brief` accepts `{"events": [...]}` to replay calendar events. |

## Run the checks

```bash
cd supabase/functions
deno lint
for f in */index.ts; do deno check --no-lock "$f"; done
deno test --no-lock --allow-env --allow-read tests/    # unit tests, no network or database
cd ../.. && node scripts/check-page.mjs && bash scripts/secret-scan.sh
bash scripts/smoke.sh                                  # live checks against the project (needs the owner key in .env)
```

The same first five run on every push in GitHub Actions (`.github/workflows/ci.yml`). The smoke test runs against live data, so it stays a manual step.
