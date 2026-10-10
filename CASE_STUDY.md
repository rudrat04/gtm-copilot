# Case study: Account Copilot

*A GTM system that finds, qualifies and briefs, so reps spend their time on people.*

## The problem
Sales reps lose hours every week on work that isn't selling: researching companies, deciding who fits, hunting for a contact, updating the CRM, remembering follow-ups, and preparing for calls. Leads that raise their hand wait while the rep catches up, and speed to lead is the metric that decides who wins them.

## The approach
Build the whole loop, with a strict rule: **outreach stays human, everything around it is automated and explainable.**

| Stage | What the system does | Human does |
|---|---|---|
| Find | Watches 46 target companies, discovers new ones each week from public hiring posts, researches any domain, and catches inbound form leads | Nothing |
| Qualify | Checks fit (size, stage, region) and buying signals (hiring, funding, buzz); labels each company Hot, Warm or Watching | Sets the target profile once |
| Act | Shows who to contact today and why, finds and enriches the right person, preps a private brief, alerts within seconds on a hot lead | Writes and sends the message, has the conversation |
| Close the loop | Asks "how did it go?" in one tap, writes a recap and a follow-up draft, updates HubSpot (lead status, deal, notes, to-dos), reads HubSpot back | Taps one button, adds two lines |

## What was built
- A static page with six tabs (Today, Accounts, Inbound, Meetings, Research, Setup), nine serverless functions, seven scheduled jobs, one Postgres database, and a two-way HubSpot sync. About 4,500 lines of TypeScript.
- A 39-check security and behaviour test, structured logs for every run, and a cost cap for AI and for the people-search credits.

## Results (measured on the live system)
| Measure | Result |
|---|---|
| Inbound form to alert email and HubSpot to-do | about 10 to 12 seconds |
| Company dossier | about 10 seconds, about 0.55 cent |
| AI per inbound lead | under 0.1 cent |
| Meeting recap and follow-up draft | about 0.17 cent |
| New companies found in the first discovery run | 9 added from 15 checked, 6 turned down with a reason |
| Total AI spend for the whole build, with every test | about $0.20 |
| People-search credits used | 14 of 50 in a month |

Everything runs on free or near-free tiers (Supabase, HubSpot Free, Hunter free, Google, GitHub Pages) plus Claude Haiku. A $0.25 daily AI cap and a monthly search-credit cap are enforced in the database.

## Decisions worth explaining
1. **Manual outreach.** The tool never contacts a prospect. It decides *who* and *when*, and drafts a suggestion. That keeps it safe, trusted and easy to adopt.
2. **Fit and signal, not one score.** A single 0-100 number mixed "right company" with "good timing" and nobody trusted it. Reps now see Fit (Fits, Partly fits, Unknown, Outside range) and a label (Hot, Warm, Watching). The number still sorts lists behind the scenes.
3. **Rules over AI.** Scores, labels and routing are fixed rules, so every decision can be explained. AI writes only short text: a dossier, a one-line reason, a recap, a draft.
4. **Cheap by design.** One small AI call filters out namesake noise; the rest uses public data. Credits are spent only on a deliberate click or a capped automatic step.
5. **HubSpot stays the record.** It writes statuses, deals and notes, but only touches deals it created, and reads back what the rep does there. A rep who lives in HubSpot never has to learn a second tool.
6. **One setup, any market.** Industries, size, stage, regions, job titles and signals are editable in a tab, so the same system serves a different client in minutes.

## Honest limits
- Company headcount from the free data source is an estimate.
- Phone numbers need a paid data provider.
- Discovery depends on one public source for now (a hiring thread); funding news and more sources are the next step.
- The Hacker News source skews toward developer tools.

## What I'd extend for your stack
- **Territories:** several search profiles by industry and region, with accounts assigned to reps and alerts routed to the right owner.
- **Insights:** which signals actually lead to replies and meetings, so weights are tuned from results.
- **More sources and CRMs:** funding feeds, intent data, Salesforce instead of HubSpot, Slack alerts instead of email.
- **Your process:** the Setup profile, the follow-up cadence and the debrief questions are configuration, not code.
