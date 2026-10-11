// Unit tests for the rule-based parts of Account Copilot: scoring, fit, labels, parsing, validation, redaction.
// No network and no database are used. Run: deno test --allow-env --allow-read tests/
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";

// The shared modules create a database client when they load, so give them harmless values first.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");

const { normalizeDomain } = await import("../_shared/db.ts");
const { redact } = await import("../_shared/log.ts");
const { isNotFitReason, notFitLabel, NOT_FIT_REASONS } = await import("../_shared/notfit.ts");
const { exclusion, extraFacts, fitBreakdown, fitReasons, industryScore, industryWords, motionScore, toolsScore } = await import("../_shared/firmo.ts");
const { fitState, heatOf, isFundingSignal, priorityScore, roundTiming, scoreAccount, tierOf } = await import("../_shared/score.ts");
const { buildHiring, isListing, usesTool, jobInsights, rolesFromSnippet, salesMotion, toolsFromHiring } = await import("../_shared/signals.ts");
const { USEFUL_NEWS } = await import("../_shared/relevance.ts");
const { dedupeRounds, roundKey } = await import("../_shared/predictleads.ts");
const { classify, normalizeEvents, plAllowed, toSignal } = await import("../_shared/predictleads.ts");
const { briefNoteHtml, draftNoteHtml } = await import("../_shared/hsnotes.ts");
const { isLossReason, LOSS_LABEL, LOSS_REASONS } = await import("../_shared/lossreason.ts");
const { cleanContext, contextLine, labelFor, validate } = await import("../_shared/inbound.ts");
const { companyDomain, parsePost } = await import("../_shared/discover.ts");
const { personaTitles, rank } = await import("../_shared/people.ts");
const { guardStatus } = await import("../_shared/guard.ts");
const { pickTop } = await import("../_shared/bulkfind.ts");
const { apply, clean } = await import("../_shared/profile.ts");
const { default: icp } = await import("../_shared/icp.json", { with: { type: "json" } });
const { meetsFit, worthShowing } = await import("../_shared/fitgate.ts");
const { alertEmail } = await import("../_shared/templates.ts");

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const facts = (o: Record<string, unknown> = {}) => ({ employees: 100, stage: "Series A", country: "US", firmo_at: "2026-01-01", ...o });

Deno.test("normalizeDomain: strips scheme, www and paths, rejects non-domains", () => {
  assertEquals(normalizeDomain("https://www.Example.com/path?x=1"), "example.com");
  assertEquals(normalizeDomain("linear.app"), "linear.app");
  assertEquals(normalizeDomain("not a domain"), null);
  assertEquals(normalizeDomain(""), null);
});

Deno.test("redact: keys, bearer tokens and long hex never reach the logs", () => {
  assertFalse(redact("Authorization: Bearer abc.def.ghi").includes("abc.def"));
  const fakeKey = ["sk", "ant", "api03", "ABCDEFGHIJKLMNOP"].join("-"); // built at run time so the secret scan never sees a key-shaped string
  assertFalse(redact(`failed with ${fakeKey}`).includes("ABCDEFGHIJ"));
  assertFalse(redact("api_key=supersecretvalue123&x=1").includes("supersecretvalue123"));
  assertFalse(redact("secret " + "a1b2c3d4".repeat(6)).includes("a1b2c3d4a1b2c3d4"));
  assertEquals(redact("plain message"), "plain message");
});

Deno.test("fit: size, stage and region against the profile", () => {
  assertEquals(fitState(facts()), "matches");
  assertEquals(fitState(facts({ employees: 1000 })), "outside");
  assertEquals(fitState(facts({ stage: "Series D" })), "outside");
  assertEquals(fitState(facts({ employees: 15 })), "close"); // slightly under the minimum
  assertEquals(fitState({ employees: null, stage: null, country: null, firmo_at: null }), "unknown");
  const f = fitBreakdown(facts());
  assertEquals([f.size, f.stage, f.region, f.points], [10, 10, 5, 25]);
  assertEquals(fitBreakdown(facts({ country: "BR" })).region, 0);
  assertEquals(fitBreakdown({ firmo_at: null }).points, 15); // neutral baseline while facts are unknown
});

Deno.test("heat: hot, warm and watching", () => {
  const post = { kind: "hiring", title: "Hiring: Account Executive", detail: {}, detected_at: daysAgo(1) };
  const summary = (n: number, age: number) => ({ kind: "hiring", title: `${n} roles`, detail: { salesOpenings: n }, detected_at: daysAgo(age) });
  assertEquals(heatOf([post], "matches"), "hot"); // a role posted this week
  assertEquals(heatOf([summary(2, 100)], "matches"), "hot"); // two or more sales roles open
  assertEquals(heatOf([summary(1, 100)], "matches"), "warm");
  assertEquals(heatOf([], "matches"), "watching");
  assertEquals(heatOf([post], "outside"), "watching"); // never hot outside the profile
  const funding = { kind: "news", title: "Acme raises $10M Series A", detail: { published: daysAgo(10) }, detected_at: daysAgo(10) };
  assertEquals(heatOf([funding], "matches"), "hot");
  const oldNews = { kind: "news", title: "Acme updates its site", detail: { published: daysAgo(40) }, detected_at: daysAgo(40) };
  assertEquals(heatOf([oldNews], "matches"), "warm");
});

Deno.test("priority score: weights, decay and tiers", () => {
  const roles = { kind: "hiring" as const, title: "2 open roles, 2 in sales", detail: { salesOpenings: 2 } };
  assertEquals(priorityScore([roles], 25).score, 49); // 24 from hiring + 25 fit
  const fresh = { kind: "news" as const, title: "Acme raises $10M Series A", detail: { published: daysAgo(2) } };
  assertEquals(priorityScore([roles, fresh], 25).score, 74); // + 25 for fresh funding news
  const stale = { kind: "news" as const, title: "Acme raises $10M Series A", detail: { published: daysAgo(90) } };
  assertEquals(priorityScore([stale], 0).score, 0); // news older than 60 days counts for nothing
  assertEquals(tierOf(74), "tier_1");
  assertEquals(tierOf(49), "tier_2");
  assertEquals(tierOf(20), "tier_3");
  assert(priorityScore([roles, fresh, fresh, fresh], 25).score <= 100);
});

Deno.test("inbound: validation", () => {
  assertEquals(validate({ name: "A", email: "a@b.co" }).ok, false); // name too short
  assertEquals(validate({ name: "Alex Doe", email: "nope" }).ok, false);
  const ok = validate({ name: "  Alex   Doe ", email: "ALEX@Acme.com ", intent: "weird" });
  assert(ok.ok);
  if (ok.ok) {
    assertEquals(ok.lead.name, "Alex Doe");
    assertEquals(ok.lead.email, "alex@acme.com");
    assertEquals(ok.lead.intent, "question"); // an unknown intent falls back
  }
  assertEquals(validate({ name: "Alex Doe", email: "a@acme.com", message: "http://a.co http://b.co http://c.co" }).ok, false); // link spam
});

Deno.test("inbound: lead labels", () => {
  const base = { business: true, disposable: false, intent: "question" as const, fit: "unknown", heat: "watching" };
  assertEquals(labelFor({ ...base, intent: "demo" }), "hot");
  assertEquals(labelFor({ ...base, intent: "pricing", fit: "close" }), "hot");
  assertEquals(labelFor({ ...base, intent: "demo", fit: "outside" }), "not_fit"); // outside the profile, even with a demo request
  assertEquals(labelFor({ ...base, disposable: true, intent: "demo" }), "not_fit");
  assertEquals(labelFor({ ...base, business: false, intent: "demo" }), "review");
  assertEquals(labelFor({ ...base, fit: "matches", heat: "hot" }), "hot");
  assertEquals(labelFor({ ...base, fit: "matches" }), "warm");
  assertEquals(labelFor(base), "review");
});

Deno.test("discovery: reading a Hacker News hiring post", () => {
  const sales = "Acme | Account Executive | Remote (US) | Full-time | https:&#x2F;&#x2F;www.acme.com&#x2F;jobs<p>We build things for developers.";
  const c = parsePost(sales, "123");
  assert(c);
  assertEquals([c!.name, c!.domain, c!.source], ["Acme", "acme.com", "hn_hiring"]);
  assertEquals(parsePost("Foo | Backend Engineer | NYC | https://foo.io<p>We make boring infrastructure.", "1"), null); // not hiring sales
  assertEquals(parsePost("Acme | Account Executive | Remote | https://boards.greenhouse.io/acme", "2"), null); // only a job board link
  assertEquals(parsePost("Just a sentence with no structure about sales", "3"), null);
  assertEquals(companyDomain("see https://www.techcrunch.com/story and https://acme.io", "Acme"), "acme.io"); // news links are skipped
  assertEquals(companyDomain("x", "acme.io"), "acme.io"); // a post headed by the site itself
});

Deno.test("people: ranking titles against the target roles", () => {
  assertEquals(rank("VP of Sales", 80).persona, "Head of Sales / VP Sales");
  assertEquals(rank("Vice President of Sales", 80).persona, "Head of Sales / VP Sales"); // spelled out is the same title
  assertEquals(rank("Chief Revenue Officer", 80).persona, "Head of Sales / VP Sales");
  assertEquals(rank("Chief Executive Officer", 10).persona, "Founder / CEO");
  assertEquals(rank("Co-Founder", 10).persona, "Founder / CEO");
  assert(rank("VP, Sales", 80).relevance >= 100); // "VP, Sales" and "VP of Sales" are the same title
  assertEquals(rank("VP, Sales", 80).relevance, rank("VP of Sales", 80).relevance);
  assertEquals(rank("Head of RevOps", 80).persona, "Head of RevOps");
  assert(rank("Head of RevOps", 80).relevance >= 95);
  const small = rank("Co-Founder & CEO", 10).relevance, big = rank("Co-Founder & CEO", 100).relevance;
  assert(small >= 70 && big < small); // a founder is the buyer at a small company, less so at a bigger one
  assert(rank("Account Executive", 80).relevance < 50); // individual contributors are not the buyer
  assert(rank("Software Engineer", 80).relevance < 50);
});

Deno.test("profile: anything from the page is cleaned before it is saved", () => {
  const d = clean({});
  assertEquals(d.employeesMin, 20);
  assertEquals(d.employeesMax, 200);
  const p = clean({ employeesMin: 500, employeesMax: 10, stages: ["Series B", "Nonsense"], regions: ["Mars"], signals: { hiring: false, news: false, community: false }, hiringRoles: Array.from({ length: 50 }, (_, i) => `role ${i}`) });
  assert(p.employeesMax >= p.employeesMin); // never an empty range
  assertEquals(p.stages, ["Series B"]); // unknown values are dropped
  assertEquals(p.regions, d.regions); // nothing valid left: the defaults
  assert(p.signals.hiring); // at least one signal has to count
  assertEquals(p.hiringRoles.length, 30);
  assertEquals(clean({ personas: [{ title: "Head of RevOps", match: [] }] }).personas.find((x) => x.title === "Head of RevOps")!.match.length > 0, true); // never an empty keyword list
});

const { goneDark } = await import("../_shared/today.ts");
const { isProblem, jobLevel, creditLevel, spendLevel, problemLevel, worst } = await import("../_shared/health.ts");

Deno.test("health: job rules (paused, never run, failed, late, on schedule)", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const job = (o: Record<string, unknown>) => ({ jobname: "x", active: true, last_start: ago(1), last_status: "succeeded", ...o });
  assertEquals(jobLevel(undefined, 24, now).level, "bad");
  assertEquals(jobLevel(job({ active: false }), 24, now).level, "warn");
  assertEquals(jobLevel(job({ last_start: null }), 24, now).level, "warn");
  assertEquals(jobLevel(job({ last_status: "failed" }), 24, now).level, "bad");
  assertEquals(jobLevel(job({ last_start: ago(30) }), 24, now).level, "ok");
  assertEquals(jobLevel(job({ last_start: ago(60) }), 24, now).level, "bad");
  assertEquals(jobLevel(job({ last_start: ago(0.5) }), 1 / 60, now).level, "bad"); // a every-minute job silent for 30 min
});

Deno.test("health: credit, spend and problem thresholds, worst of", () => {
  assertEquals(creditLevel(10, 40), "ok");
  assertEquals(creditLevel(32, 40), "warn");
  assertEquals(creditLevel(40, 40), "bad");
  assertEquals(spendLevel(0.2, 0.25), "warn");
  assertEquals(problemLevel(0, 0), "ok");
  assertEquals(problemLevel(1, 0), "warn");
  assertEquals(problemLevel(5, 0), "bad");
  assertEquals(worst(["ok", "warn", "ok"]), "warn");
  assertEquals(worst([]), "ok");
});

Deno.test("health: rejected callers and bad input are noise, real errors are not", () => {
  assertFalse(isProblem({ level: "warn", event: "response" }));
  assertFalse(isProblem({ level: "warn", event: "admin_key_rejected" }));
  assert(isProblem({ level: "error", event: "response" }));
  assert(isProblem({ level: "warn", event: "ai_output_truncated" }));
});

Deno.test("goneDark: only after the sequence, with a newer signal that is under 30 days old", () => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  const base = { outreach_status: "contacted", touches: 3, next_followup_at: null, last_touch_at: "2026-10-01T00:00:00Z" };
  const sig = (d: string) => Date.parse(d);
  assert(goneDark(base, sig("2026-10-10T00:00:00Z"), now, 3));
  assertFalse(goneDark({ ...base, touches: 2 }, sig("2026-10-10T00:00:00Z"), now, 3)); // still in the sequence
  assertFalse(goneDark({ ...base, next_followup_at: "2026-10-22T00:00:00Z" }, sig("2026-10-10T00:00:00Z"), now, 3));
  assertFalse(goneDark({ ...base, outreach_status: "replied" }, sig("2026-10-10T00:00:00Z"), now, 3));
  assertFalse(goneDark(base, sig("2026-09-25T00:00:00Z"), now, 3)); // older than the last touch
  assertFalse(goneDark(base, sig("2026-09-10T00:00:00Z"), now, 3)); // stale
  assertFalse(goneDark(base, 0, now, 3)); // no signal at all
});

Deno.test("lead context: keeps UTM words, host and path only; builds one sentence", () => {
  const c = cleanContext({ utm_source: "google", utm_medium: "cpc", utm_campaign: "q4 demo<script>", referrer: "https://www.news.example.com/a?token=SECRET", page: "/pricing?email=a@b.c#x" });
  assertEquals(c.utm_campaign, "q4 demoscript");
  assertEquals(c.referrer_host, "news.example.com");
  assertEquals(c.landing_path, "/pricing");
  assertEquals(contextLine(c), "Came from google / cpc / q4 demoscript, landed on /pricing");
  assertEquals(contextLine({ referrer_host: "news.example.com" }), "Came from news.example.com");
  assertEquals(contextLine({ landing_path: "/pricing" }), "Landed on /pricing");
  assertEquals(contextLine({}), "");
  assertEquals(cleanContext({ referrer: "not a url", page: "" }), {});
  assertFalse(JSON.stringify(c).includes("SECRET"));
});

Deno.test("loss reasons: a fixed list, each with a label; anything else is refused", () => {
  assertEquals(LOSS_REASONS.length, 5);
  for (const r of LOSS_REASONS) assert(isLossReason(r) && LOSS_LABEL[r].length > 0);
  assertFalse(isLossReason("because"));
  assertFalse(isLossReason(undefined));
});

Deno.test("HubSpot notes: escaped, labelled, and a draft says it was not sent", () => {
  const b = briefNoteHtml("Intro <call>", "Mon 12 Oct", "Line one\nLine <b>two</b>");
  assert(b.includes("Internal. Not shared with the guest."));
  assertFalse(b.includes("<b>two</b>"));
  assert(b.includes("Line one<br>Line &lt;b&gt;two"));
  const d = draftNoteHtml({ persona: "VP Sales", subject: "Quick \"q\"", body: "Hi {{first_name}},\nHello" });
  assert(d.includes("not sent"));
  assert(d.includes("&quot;q&quot;"));
  assert(d.includes("Hi {{first_name}},<br>Hello"));
});

const { countryName, emailStatusOption, hsSource, hsStatus, newsType, signalFacts } = await import("../_shared/hsfields.ts");

Deno.test("hubspot columns: status and source mapping, country names", () => {
  const a = (o: Record<string, unknown>) => ({ outreach_status: "open", lost_at: null, won_at: null, ...o });
  assertEquals(hsStatus(a({})), "new");
  assertEquals(hsStatus(a({ outreach_status: "contacted" })), "prospecting");
  assertEquals(hsStatus(a({ outreach_status: "replied" })), "engaged");
  assertEquals(hsStatus(a({ outreach_status: "meeting" })), "qualified");
  assertEquals(hsStatus(a({ outreach_status: "snoozed" })), "nurture");
  assertEquals(hsStatus(a({ outreach_status: "not_now", lost_at: "2026-10-01" })), "closed_lost");
  assertEquals(hsStatus(a({ outreach_status: "not_now" })), "nurture");
  assertEquals(hsStatus(a({ won_at: "2026-10-01", lost_at: "2026-09-01" })), "customer");
  assertEquals(hsSource("inbound"), "demo_form");
  assertEquals(hsSource("hubspot"), "hubspot");
  assertEquals(hsSource("discovered"), "api");
  assertEquals(countryName("GB"), "United Kingdom");
  assertEquals(countryName(null), null);
});

Deno.test("hubspot columns: newest real signal, funding type, open roles", () => {
  const row = (kind: string, title: string, detail: Record<string, unknown>, detected_at: string) => ({ kind, title, url: null, detail, detected_at });
  const f = signalFacts([
    row("hiring", "1 open roles, 3 in sales/RevOps", { salesOpenings: 3, totalOpenings: 9 }, "2026-10-09T00:00:00Z"),
    row("hn", "Hacker News: Acme", { points: 2 }, "2026-10-10T00:00:00Z"),
    row("news", "Acme raises $20M Series B", { published: "Fri, 02 Oct 2026 07:00:00 GMT" }, "2026-10-08T00:00:00Z"),
    row("hiring", "Account Executive", {}, "2026-10-01T00:00:00Z"),
  ]);
  assertEquals(f.latest?.title, "Acme raises $20M Series B");
  assertEquals(f.latestType, "FUNDING");
  assertEquals(f.openRoles, 3);
  assertEquals(f.news?.title, "Acme raises $20M Series B");
  assertEquals(signalFacts([]).latest, null);
});

Deno.test("hubspot columns: news headlines map to signal types, ATS comes from the job board", () => {
  assertEquals(newsType("Acme names Jane Roe as new Chief Revenue Officer"), "NEW_CRO");
  assertEquals(newsType("Acme hires VP of Sales from Salesforce"), "NEW_VP_SALES");
  assertEquals(newsType("Acme raises $20M Series B"), "FUNDING");
  assertEquals(newsType("Acme launches a new dashboard"), null);
  assertEquals(newsType("The CRO of Spotify talks about ads"), null); // a CRO mention is not a hire
  const row = (kind: string, title: string, detail: Record<string, unknown>) => ({ kind, title, url: null, detail, detected_at: "2026-10-09T00:00:00Z" });
  assertEquals(signalFacts([row("hiring", "Hiring: Account Executive", { source: "lever" })]).ats, "Lever");
  assertEquals(signalFacts([row("hiring", "Hiring: AE (Hacker News Who is hiring)", { source: "hn_hiring" })]).ats, null);
});

Deno.test("hubspot columns: email status options", () => {
  assertEquals(emailStatusOption("valid"), "valid");
  assertEquals(emailStatusOption("accept_all"), "accept_all");
  assertEquals(emailStatusOption("webmail"), "unknown");
  assertEquals(emailStatusOption(null), "unknown");
});

Deno.test("fit gate: the bar hides what is below it; the default hides only outside range", () => {
  assert(meetsFit("matches", "matches"));
  assertFalse(meetsFit("close", "matches"));
  assert(meetsFit("close", "close") && meetsFit("matches", "close"));
  assertFalse(meetsFit("unknown", "close"));
  assert(meetsFit("unknown", "unknown"));
  assertFalse(meetsFit("outside", "unknown"));
  assert(meetsFit("outside", "outside")); // show everything
  const a = (o: Record<string, unknown>) => ({ employees: 100, stage: "Series A", country: "US", firmo_at: "2026-01-01", priority_score: 50, ...o });
  const cfg = (minFit: string, minScore: number) => ({ minFit: minFit as never, minScore });
  assert(worthShowing(a({}), cfg("matches", 30)));
  assertFalse(worthShowing(a({ priority_score: 20 }), cfg("matches", 30)));
  assertFalse(worthShowing(a({ employees: 5000 }), cfg("unknown", 0))); // outside range
  assert(worthShowing(a({ firmo_at: null }), cfg("unknown", 0))); // not checked yet is still shown by default
  assertFalse(worthShowing(a({ firmo_at: null }), cfg("close", 0)));
});

Deno.test("profile: fit bar and score are validated", () => {
  assertEquals(clean({ minFit: "matches", minScore: 45 }).minFit, "matches");
  assertEquals(clean({ minFit: "banana", minScore: 999 }).minFit, "unknown");
  assertEquals(clean({ minScore: 999 }).minScore, 90);
  assertEquals(clean({ minScore: -5 }).minScore, 0);
  assertEquals(clean({}).minScore, 30);
});

const flagsMod = await import("../_shared/flags.ts");

Deno.test("watch rules: each check fires only when it should", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const h = (n: number) => now - n * 3_600_000;
  const d = (n: number) => new Date(now - n * 86_400_000).toISOString();
  // hot and untouched
  assert(flagsMod.hotUntouched({ outreach_status: "open" }, true, "hot", h(60), now, 48));
  assertFalse(flagsMod.hotUntouched({ outreach_status: "open" }, true, "hot", h(10), now, 48)); // still fresh
  assertFalse(flagsMod.hotUntouched({ outreach_status: "open" }, false, "hot", h(60), now, 48)); // nobody to contact yet
  assertFalse(flagsMod.hotUntouched({ outreach_status: "contacted" }, true, "hot", h(60), now, 48));
  assertFalse(flagsMod.hotUntouched({ outreach_status: "open" }, true, "warm", h(60), now, 48));
  // follow-up overdue
  assert(flagsMod.followupOverdue({ outreach_status: "contacted", next_followup_at: d(3) }, now, 2));
  assertFalse(flagsMod.followupOverdue({ outreach_status: "contacted", next_followup_at: d(1) }, now, 2));
  assertFalse(flagsMod.followupOverdue({ outreach_status: "replied", next_followup_at: d(9) }, now, 2));
  // replied, no next step
  assert(flagsMod.repliedStale({ outreach_status: "replied", last_touch_at: d(6) }, now, 5));
  assertFalse(flagsMod.repliedStale({ outreach_status: "replied", last_touch_at: d(2) }, now, 5));
  // meeting without a debrief
  const m = { status: "briefed", outcome: null, starts_at: d(3), ends_at: null as string | null };
  assert(flagsMod.meetingStale(m, now, 2));
  assertFalse(flagsMod.meetingStale({ ...m, outcome: "went_well" }, now, 2));
  assertFalse(flagsMod.meetingStale({ ...m, starts_at: d(1) }, now, 2));
  assertFalse(flagsMod.meetingStale({ ...m, starts_at: d(40) }, now, 2)); // too old to chase
  // lead past target
  const l = { status: "new", label: "hot", alerted_at: new Date(now - 50 * 60_000).toISOString(), created_at: new Date(now - 55 * 60_000).toISOString() };
  assert(flagsMod.leadLate(l, now, 15, 30));
  assertFalse(flagsMod.leadLate(l, now, 30, 30)); // 50 min is inside 30 + 30
  assertFalse(flagsMod.leadLate({ ...l, status: "contacted" }, now, 15, 30));
  assertFalse(flagsMod.leadLate({ ...l, label: "not_fit" }, now, 15, 30));
  // stuck deal
  assert(flagsMod.dealStuck({ hubspot_deal_id: "1", deal_stage: "qualifiedtobuy" }, now - 20 * 86_400_000, now, 14));
  assertFalse(flagsMod.dealStuck({ hubspot_deal_id: "1", deal_stage: "closedlost" }, now - 20 * 86_400_000, now, 14));
  assertFalse(flagsMod.dealStuck({ hubspot_deal_id: null, deal_stage: null }, now - 20 * 86_400_000, now, 14));
  assertFalse(flagsMod.dealStuck({ hubspot_deal_id: "1", deal_stage: "qualifiedtobuy" }, now - 3 * 86_400_000, now, 14));
  // thin pipeline
  assert(flagsMod.thinPipeline(1, 3));
  assertFalse(flagsMod.thinPipeline(3, 3));
});

Deno.test("watch settings: validated, limited and complete", () => {
  const w = clean({ watch: { urgent: false, checks: { hotUntouched: { on: false, n: 99999 }, dealStuck: { n: 1 }, bogus: { n: 5 } } } }).watch;
  assertEquals(w.urgent, false);
  assertEquals(w.todoForUrgent, true);
  assertEquals(w.checks.hotUntouched.on, false);
  assertEquals(w.checks.hotUntouched.n, 336); // clamped to the maximum
  assertEquals(w.checks.dealStuck.n, 3); // clamped to the minimum
  assertEquals(w.checks.followupOverdue, { on: true, n: 2 }); // untouched defaults fill in
  assertFalse("bogus" in w.checks);
  assertEquals(Object.keys(w.checks).length, 10);
});

Deno.test("personas: fully editable, validated, and used by the ranking", () => {
  // The defaults survive an empty or old-format profile, including weights, HubSpot values and the founder size limit.
  const d = clean({}).personas;
  assertEquals(d.map((p) => p.title), ["Head of Sales / VP Sales", "Head of RevOps", "Founder / CEO"]);
  assertEquals(d.map((p) => p.weight), [100, 95, 90]); // the list order is the priority
  const old = clean({ personas: [{ title: "Founder / CEO", match: ["founder"] }] }).personas;
  assertEquals(old.length, 1);
  assertEquals(old[0].weight, 100); // first in the list
  assertEquals(old[0].hubspot, "Founder"); // a type with the old default name keeps its HubSpot value
  assertEquals(old[0].onlyBelow, null);
  // Validation: no words or no name means the type is dropped; duplicates and extras are trimmed; bad numbers are clamped.
  const p = clean({ personas: [
    { title: "  Marketing   lead ", match: ["CMO", "head of marketing"], weight: 500, hubspot: "  ", onlyBelow: 1 },
    { title: "marketing lead", match: ["x"] },
    { title: "No words", match: [] },
    { title: "", match: ["y"] },
  ] }).personas;
  assertEquals(p.length, 1);
  assertEquals(p[0], { title: "Marketing lead", match: ["CMO", "head of marketing"], weight: 100, hubspot: null, onlyBelow: null, department: "", seniority: [] });
  assertEquals(clean({ personas: Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, match: ["w"] })) }).personas.length, 8);
  assertEquals(clean({ personas: [{ title: "Nothing", match: [] }] }).personas.length, 3); // nothing valid: back to the defaults
  // Ranking follows the owner's list: the best-weighted match wins, and the sales fallbacks switch off with the sales personas.
  apply(clean({ personas: [{ title: "Marketing lead", match: ["head of marketing", "cmo"] }, { title: "Founder", match: ["founder"], hubspot: "Founder" }] }));
  try {
    assertEquals(rank("CMO", 80).persona, "Marketing lead");
    assertEquals(rank("Head of Marketing", 80).relevance, 103); // weight 100 plus the seniority bonus
    assertEquals(rank("VP Sales", 80).relevance, 0);
    assertEquals(rank("Founder", 10).relevance, 99); // second in the list: 95, plus the seniority bonus
  } finally {
    apply(clean({}));
  }
  assertEquals(rank("VP of Sales", 80).persona, "Head of Sales / VP Sales"); // the defaults are back
});

// Synthetic data in the exact shape of a real PredictLeads news_events response (no real company or person data is stored in the repo).
const plReal = JSON.parse(await Deno.readTextFile(new URL("./fixtures_predictleads.json", import.meta.url)));

Deno.test("predictleads: a response in the real shape is read and the noise categories are ignored", () => {
  const events = normalizeEvents(plReal);
  assertEquals(events.length, 5);
  assertEquals(events.map((e) => e.category), ["hires", "integrates_with", "identified_as_competitor_of", "integrates_with", "integrates_with"]);
  const now = Date.parse("2026-10-11T00:00:00Z");
  // None of these five is a buying signal: a hire with no role named, three integrations and a competitor mention.
  assertEquals(events.map((e) => toSignal(e, now)), [null, null, null, null, null]);
  assertEquals(normalizeEvents({}), []);
  assertEquals(normalizeEvents({ data: [{ type: "company", id: "x" }] }), []);
});

Deno.test("predictleads: funding and executive hires become signals, with the right type and date", () => {
  const ev = (o: Record<string, unknown>) => ({ id: "1", category: "", headline: "H", summary: "", found_at: "2026-10-01T00:00:00Z", effective_date: null, confidence: 0.8, planning: false, job_title: null, contact: null, financing_type: null, amount: null, ...o });
  const now = Date.parse("2026-10-11T00:00:00Z");
  assertEquals(classify(ev({ category: "receives_financing" })), "FUNDING");
  assertEquals(classify(ev({ category: "invests_into" })), "FUNDING"); // the category PredictLeads really uses for a funding round
  assertEquals(classify(ev({ category: "other", financing_type: "series_b" })), "FUNDING");
  assertEquals(classify(ev({ category: "hires", job_title: "Chief Revenue Officer" })), "NEW_CRO");
  assertEquals(classify(ev({ category: "hires", headline: "Acme hired Jo as VP of Sales" })), "NEW_VP_SALES");
  assertEquals(classify(ev({ category: "hires", job_title: "Head of Marketing" })), "LEADER_HIRE");
  assertEquals(classify(ev({ category: "hires", job_title: "Software Engineer" })), null);
  assertEquals(classify(ev({ category: "integrates_with" })), null);
  const s = toSignal(ev({ category: "receives_financing", headline: "Acme raises $20M Series B", effective_date: "2026-10-05", amount: 20000000 }), now)!;
  assertEquals(s.kind, "news");
  assertEquals(s.title, "Acme raises $20M Series B");
  assertEquals(s.detail?.plType, "FUNDING");
  assertEquals(s.detail?.source, "predictleads");
  assertEquals(String(s.detail?.published).slice(0, 10), "2026-10-05"); // the date it happened, not the date it was found
  assertEquals(toSignal(ev({ category: "receives_financing", confidence: 0.3 }), now), null); // too uncertain
  assertEquals(toSignal(ev({ category: "receives_financing", planning: true }), now), null); // only planned
  assertEquals(toSignal(ev({ category: "receives_financing", effective_date: "2025-01-01" }), now), null); // too old
  assertEquals(toSignal(ev({ category: "receives_financing", headline: "" }), now), null);
});

Deno.test("predictleads: the monthly allowance is shared out, with a reserve for the owner", () => {
  assert(plAllowed("auto", 59, 100));
  assertFalse(plAllowed("auto", 60, 100)); // background use stops at 60%
  assert(plAllowed("brief", 89, 100));
  assertFalse(plAllowed("brief", 90, 100)); // meeting briefs stop at 90%
  assert(plAllowed("manual", 99, 100));
  assertFalse(plAllowed("manual", 100, 100)); // never past the cap
  assertFalse(plAllowed("auto", 0, 0));
});

Deno.test("news: directory and data pages are not news; real articles pass", () => {
  for (const t of [
    "Attio - 2026 Funding Rounds & List of Investors - Tracxn",
    "Clay Revenue 2025: $100M ARR, $5B Valuation - GetLatka",
    "Lemlist Revenue 2026: $53M, $150M Est. Valuation (2025) - GetLatka",
    "Neon One Revenue 2025: $20M Est. ARR - GetLatka",
    "Acme Company Profile - Crunchbase",
    "Top 10 Acme Alternatives & Competitors",
  ]) assert(isListing(t), t);
  for (const t of [
    "Clay Raises $115M to be the AI Growth Engine for Every Company - Business Wire",
    "AI sales startup Clay raises funding at a $7 billion valuation - WION",
    "Convex Raises $57 Million Series B, Bringing Total Funding To $110.5 Million - Pulse 2.0",
    "FusionAuth Establishes UK Team as European Demand for Data Sovereignty Drives 72% Regional Growth",
  ]) assertFalse(isListing(t), t);
  for (const k of ["funding", "leadership", "expansion", "product", "customer"]) assert(USEFUL_NEWS.has(k));
  for (const k of ["opinion", "listing", "partnership", "other"]) assertFalse(USEFUL_NEWS.has(k));
});

Deno.test("score: a funding label beats the keywords, and unlabelled old items still use them", () => {
  assert(isFundingSignal({ title: "Anything", detail: { plType: "FUNDING" } }));
  assertFalse(isFundingSignal({ title: "Acme raises $5M", detail: { plType: "NEW_CRO" } }));
  assertFalse(isFundingSignal({ title: "Acme funding rounds list", detail: { newsType: "listing" } }));
  assert(isFundingSignal({ title: "Acme raises $5M", detail: { newsType: "funding" } }));
  assert(isFundingSignal({ title: "Acme raises $5M Series A", detail: {} })); // stored before labels existed
  assertFalse(isFundingSignal({ title: "Acme ships a new feature", detail: {} }));
});

Deno.test("hiring: an unreachable board means unknown, never zero roles", () => {
  const re = /account executive|sdr/i;
  const jobs = [{ title: "Account Executive", url: "u1", source: "ashby" }, { title: "Engineer", url: "u2", source: "ashby" }];
  const ok = buildHiring(jobs, false, true, re);
  assertEquals(ok.unknown, false);
  assertEquals([ok.signals.at(-1)!.detail?.totalOpenings, ok.signals.at(-1)!.detail?.salesOpenings], [2, 1]);
  const partial = buildHiring(jobs, true, true, re); // another board timed out
  assertEquals(partial.unknown, true);
  assertEquals(partial.signals.length, 1); // the role is kept
  assertFalse(partial.signals.some((x) => x.detail && "salesOpenings" in x.detail)); // the count is not written
  const none = buildHiring([], true, false, re);
  assertEquals(none.unknown, true);
  assertEquals(none.signals, []);
  assertEquals(buildHiring([], false, false, re).unknown, false); // really no boards: nothing unknown
});

Deno.test("hiring: roles read from a Hacker News post, never a URL or a city", () => {
  assertEquals(rolesFromSnippet("Rootly (https://rootly.com/) | design, engineering, GTM, sales | Remote"), "GTM, Sales");
  assertEquals(rolesFromSnippet("Reactor | https://reactor.inc | San Francisco, CA, USA"), "");
  assertEquals(rolesFromSnippet("Hiring Account Executives and SDRs, also revops"), "Account Executive, SDR, RevOps");
  assertEquals(rolesFromSnippet("Backend Engineers, Sr. Software Engineer (Marketing) | REMOTE"), ""); // an engineer on the marketing team is not a sales role
  assertEquals(rolesFromSnippet("MTS, Applied ML | Remote (India)"), "");
  assertEquals(rolesFromSnippet("Technical Content & Community Lead | REMOTE (UK)"), "");
  assertEquals(rolesFromSnippet("Part-time B2B Sales Lead | REMOTE (US)"), "Sales");
});

Deno.test("predictleads: one funding round counts once", () => {
  const sig = (title: string, day: string) => ({ kind: "news" as const, title, detail: { plType: "FUNDING", published: `${day}T00:00:00Z` } });
  assertEquals(roundKey("Wellington invested into Clay $115M in Series D on Aug 31st"), "series d");
  assertEquals(roundKey("Acme closes Pre-Seed round"), "pre-seed");
  assertEquals(roundKey("Something happened"), null);
  const fresh = [sig("Wellington invested into Clay $115M in Series D", "2026-08-31"), sig("Bloomberg Beta invested into Clay $115M in Series D", "2026-09-09"), sig("Clay raises Series E", "2026-10-01")];
  assertEquals(dedupeRounds(fresh, []).map((s) => s.title), [fresh[0].title, fresh[2].title]); // the second investor is the same round
  assertEquals(dedupeRounds([fresh[1]], [{ title: fresh[0].title, published: "2026-08-31T00:00:00Z" }]), []); // already stored
  assertEquals(dedupeRounds([sig("Acme Series B", "2027-06-01")], [{ title: "Acme Series B", published: "2026-01-01T00:00:00Z" }]).length, 1); // far apart: a different event
});

Deno.test("hunter facts: industry, tools, tags and description are read from the company lookup", () => {
  // The field names come from Hunter's Company Enrichment documentation.
  const f = extraFacts({
    category: { sector: "Information Technology", industryGroup: "Software & Services", industry: "Software", subIndustry: "Software" },
    tech: ["HubSpot", "cloudflare", " Ruby "], techCategories: ["crm"], tags: ["SaaS", "B2B"], description: "  We build   a CRM\nfor teams.  ", linkedin: { handle: "company/acme" },
  });
  assertEquals(f.industry, "Information Technology / Software & Services / Software"); // repeated words are not repeated
  assertEquals(f.tech, ["hubspot", "cloudflare", "ruby"]);
  assertEquals(f.tags, ["saas", "b2b"]);
  assertEquals(f.blurb, "We build a CRM for teams.");
  assertEquals(f.linkedin, "company/acme");
  const empty = extraFacts({});
  assertEquals([empty.industry, empty.tags, empty.tech, empty.blurb, empty.linkedin], [null, [], [], null, null]);
  assertEquals(extraFacts({ tech: "not a list", description: 5 }).tech, []);
  assertEquals(extraFacts({ description: "x".repeat(500) }).blurb!.length, 300);
});

Deno.test("fit model: the default weights give exactly the old size + stage + region points", () => {
  apply(clean({}));
  const a = { employees: 100, stage: "Series A", country: "US", firmo_at: "2026-01-01" };
  assertEquals(fitBreakdown(a).points, 25); // a perfect match
  assertEquals(fitBreakdown({ ...a, employees: 22 * 100 }).points, 15); // size 0, stage 10, region 5
  assertEquals(fitBreakdown({ ...a, stage: "Series D" }).points, 15);
  assertEquals(fitBreakdown({ firmo_at: null }).points, 15); // nothing looked up: the neutral baseline
  // Industry, tools and motion carry no weight until the owner gives them one.
  assertEquals(fitBreakdown({ ...a, tech: ["salesforce"], industry: "Retail" }).points, 25);
});

Deno.test("fit model: industry, tools and sales style score 0 to 1 and the weights decide", () => {
  const profile = clean({ toolsGood: ["HubSpot"], toolsAvoid: ["Clay"], motion: "sales_led", industries: ["B2B SaaS"], excludeWords: ["agency"], excludeDomains: ["rival.com"] });
  assertEquals(profile.fitWeights, { size: 10, stage: 10, region: 5, industry: 4, tools: 5, motion: 4 }); // automatic: each extra criterion counts once there is something to compare with
  assertEquals(profile.excludeDomains, ["rival.com"]);
  apply(profile);
  try {
    assertEquals(industryScore({ industry: "Information Technology / Software" }), 1);
    assertEquals(industryScore({ industry: "Retail / Apparel", tags: ["fashion"] }), 0);
    assertEquals(industryScore({}), 0.5); // no data yet: neutral
    assertEquals(toolsScore({ tech: ["HubSpot", "stripe"] }), 1);
    assertEquals(toolsScore({ tech: ["hub spot", "clay"] }), 0); // an avoided tool wins
    assertEquals(toolsScore({ tech: ["stripe"] }), 0.5);
    assertEquals(toolsScore({}), 0.5);
    assertEquals(motionScore({ sales_motion: "sales_led" }), 1);
    assertEquals(motionScore({ sales_motion: "both" }), 0.75);
    assertEquals(motionScore({ sales_motion: "self_serve" }), 0);
    assertEquals(motionScore({}), 0.5);
    const base = { employees: 100, stage: "Series A", country: "US", firmo_at: "2026-01-01" };
    const good = fitBreakdown({ ...base, industry: "Software", tech: ["hubspot"], sales_motion: "sales_led" }).points;
    const bad = fitBreakdown({ ...base, industry: "Retail", tech: ["clay"], sales_motion: "self_serve" }).points;
    assert(good > 24.9 && bad < 17 && good - bad > 8); // right on every criterion vs wrong on the three new ones (25 x 25/38 = 16.4)
    // Exclusions: a word, a domain and a customer are never prospects, and fitState says so.
    assertEquals(exclusion({ blurb: "A digital marketing agency", name: "Pixel" }), 'Matches "agency"');
    assertEquals(exclusion({ domain: "RIVAL.com" }), "On your never-show list");
    assertEquals(exclusion({ known_as: "customer" }), "Already a customer");
    assertEquals(exclusion({ blurb: "Software for agencies' clients" }), null); // "agencies" is not the word "agency"... a word must start the match
    assertEquals(fitState({ ...base, domain: "rival.com" }), "outside");
    assertEquals(fitState({ firmo_at: null, domain: "rival.com" }), "outside"); // even before its size is known
    const r = fitReasons({ ...base, industry: "Software", tech: ["hubspot"], sales_motion: "self_serve" });
    assertEquals(r.map((x) => `${x.key}:${x.state}`), ["size:ok", "stage:ok", "region:ok", "industry:ok", "tools:ok", "motion:no"]);
  } finally {
    apply(clean({}));
  }
  assertEquals(fitReasons({ employees: 100, stage: "Series A", country: "US", firmo_at: "2026-01-01" }).map((x) => x.key), ["size", "stage", "region"]); // only what counts
});

Deno.test("fit model: settings from the page are cleaned", () => {
  assertEquals(industryWords("B2B SaaS").includes("software"), true);
  assertEquals(clean({}).fitWeights, { size: 10, stage: 10, region: 5, industry: 0, tools: 0, motion: 0 }); // nothing chosen: size, stage and region only
  assertEquals(clean({ fitWeights: { size: 0 } }).fitWeights.size, 10); // weights are no longer settable
  assertEquals(clean({ industries: ["Fintech", "Not a real industry"] }).industries, ["Fintech"]);
  assertEquals(clean({ stages: ["Series E or later", "Nope"], regions: ["Germany", "Nordics", "Mars"] }).regions, ["Germany", "Nordics"]);
  assertEquals(clean({ product: { description: "x".repeat(2000), website: "https://www.Example.com/about?x=1" } }).product, { description: "x".repeat(1500), website: "example.com" });
  assertEquals(clean({ product: { website: "not a site" } }).product.website, "");
  assertEquals(clean({ motion: "weird" }).motion, "any");
  assertEquals(clean({ excludeDomains: ["https://www.Rival.com/pricing", ""] }).excludeDomains, ["rival.com"]);
});

Deno.test("not a fit: a fixed list of reasons, each with a label", () => {
  assertEquals(NOT_FIT_REASONS.length, 8);
  for (const [k, l] of NOT_FIT_REASONS) assert(isNotFitReason(k) && notFitLabel(k) === l);
  assertFalse(isNotFitReason("because"));
  assertFalse(isNotFitReason(undefined));
  assertEquals(notFitLabel("mystery"), "mystery");
});

Deno.test("sales style: the homepage invites a demo, a free start, both or neither", () => {
  assertEquals(salesMotion("<a>Book a demo</a><p>Talk to sales</p>"), "sales_led");
  assertEquals(salesMotion("<button>Start free</button> <span>No credit card required</span>"), "self_serve");
  assertEquals(salesMotion("<a>Request a demo</a> or <a>Start for free</a>"), "both");
  assertEquals(salesMotion("<h1>We build things</h1><script>var demo = 'book a demo'</script>"), null); // script text is not page text
  assertEquals(salesMotion(""), null);
});

Deno.test("job posts: seniority, founding roles, tools and problems are read from the sales roles", () => {
  const job = (title: string, desc = "") => ({ title, url: "u", source: "lever", desc });
  const i = jobInsights([job("Head of Sales"), job("Founding Account Executive", "You will be our first sales hire. Experience with Salesforce and Gong, improving forecasting and pipeline hygiene.")]);
  assertEquals(i.leader, true);
  assertEquals(i.founding, true);
  assertEquals(i.tools, ["salesforce", "gong"]);
  assertEquals(i.pains, ["forecasting", "pipeline"]);
  const plain = jobInsights([job("Account Executive", "Close deals.")]);
  assertEquals([plain.leader, plain.founding, plain.tools, plain.pains], [false, false, [], []]);
  assertEquals(jobInsights([job("Sales Rep", "We hold a close relationship with customers and do outreach and segment our market")]).tools, []); // everyday words are not tools
  assertEquals(jobInsights([job("Sales Rep", "Daily work in Close CRM and Outreach.io")]).tools, ["outreach", "close"]);
  // The summary carries the insights, and the tools can be read back from it.
  const h = buildHiring([{ title: "Head of Sales", url: "u", source: "lever", desc: "Use HubSpot" }], false, true, /sales/i);
  assertEquals(toolsFromHiring(h.signals), ["hubspot"]);
  assertEquals(toolsFromHiring([]), []);
});

Deno.test("scoring: leadership and founding roles add hiring points; a well-timed round adds a little news points", () => {
  apply(clean({}));
  const sum = (d: Record<string, unknown>) => ({ kind: "hiring" as const, title: "x", detail: { salesOpenings: 1, totalOpenings: 5, ...d } });
  const base = priorityScore([sum({})]).parts.hiring;
  assertEquals(priorityScore([sum({ leader: true })]).parts.hiring, base + 8);
  assertEquals(priorityScore([sum({ leader: true, founding: true })]).parts.hiring, base + 14);
  assertEquals(priorityScore([sum({ leader: true })].concat(Array(5).fill(sum({ salesOpenings: 3 }))) as never).parts.hiring <= 40, true); // never above the hiring cap
  const now = Date.parse("2026-10-11T00:00:00Z");
  const ago = (d: number) => new Date(now - d * 86_400_000).toISOString();
  assertEquals(roundTiming(ago(200), now), 1); // inside 90 to 270 days
  assertEquals(roundTiming(ago(30), now), 0.6); // just raised
  assertEquals(roundTiming(ago(350), now), 0.4); // fading
  assertEquals(roundTiming(ago(900), now), 0);
  assertEquals(roundTiming(null, now), 0);
  assert(priorityScore([], 15, 1).parts.news > priorityScore([], 15, 0).parts.news);
  const a = { employees: 100, stage: "Series A", country: "US", firmo_at: "2026-01-01", last_round_date: ago(200).slice(0, 10) };
  assertEquals(scoreAccount([], { ...a, last_round_date: null }).parts.fit, scoreAccount([], a).parts.fit); // timing is not a fit change
});

Deno.test("settings: the funding window is validated", () => {
  assertEquals(clean({}).roundWindow, [90, 270]);
  assertEquals(clean({ roundWindow: [30, 120] }).roundWindow, [30, 120]);
  assertEquals(clean({ roundWindow: [400, 10] }).roundWindow, [400, 401]); // never an empty window
  assertEquals(clean({ roundWindow: "x" }).roundWindow, [90, 270]);
});

Deno.test("people search: the job titles asked for come from the buyer types", () => {
  apply(clean({}));
  const t = personaTitles();
  assert(t.length > 0 && t.length <= 14);
  assert(t.includes("VP of Sales") && t.includes("Chief Revenue Officer") && t.includes("Revenue Operations")); // abbreviations are written out
  assertEquals(t.indexOf("VP of Sales") < t.indexOf("Chief Executive Officer"), true); // the best-weighted buyer type comes first
  assertEquals(new Set(t.map((x) => x.toLowerCase())).size, t.length); // no repeats
  apply(clean({ personas: [{ title: "Marketing lead", match: ["head of marketing", "cmo"], weight: 90, hubspot: null, onlyBelow: null }] }));
  try {
    assertEquals(personaTitles(), ["Head Of Marketing", "Chief Marketing Officer"]);
  } finally {
    apply(clean({}));
  }
  assertEquals(personaTitles([]), []);
});

Deno.test("already-known guard: opted out and bounced are never suggested; known is marked; ours is fine", () => {
  const hs = (o: Record<string, unknown> = {}) => ({ id: "1", optedOut: false, bounced: false, lastContacted: null, ...o });
  assertEquals(guardStatus(undefined, false), { status: null, note: null }); // not in HubSpot: nothing to say
  assertEquals(guardStatus(hs({ optedOut: true }), false).status, "opted_out");
  assertEquals(guardStatus(hs({ optedOut: true }), true).status, "opted_out"); // even a contact we added
  assertEquals(guardStatus(hs({ bounced: true }), false).status, "bounced");
  assertEquals(guardStatus(hs(), true), { status: null, note: null }); // we added them ourselves
  const k = guardStatus(hs({ lastContacted: "2026-09-12T10:00:00Z" }), false);
  assertEquals(k.status, "known");
  assert(k.note!.includes("2026-09-12") && k.note!.includes("Check before reaching out"));
  assertEquals(guardStatus(hs(), false).status, "known");
});

Deno.test("bulk find: hot first, then warm, by score; watching is never searched; capped", () => {
  const r = (name: string, heat: string, priority: number | null) => ({ name, heat, priority });
  const rows = [r("a", "warm", 60), r("b", "hot", 40), r("c", "watching", 90), r("d", "hot", 70), r("e", "warm", 80), r("f", "hot", null)];
  assertEquals(pickTop(rows, 10).map((x) => x.name), ["d", "b", "f", "e", "a"]);
  assertEquals(pickTop(rows, 2).map((x) => x.name), ["d", "b"]);
  assertEquals(pickTop(Array.from({ length: 20 }, (_, i) => r(`x${i}`, "hot", i)), 99).length, 8); // never more than the cap
  assertEquals(pickTop([r("z", "watching", 99)], 5), []);
});

Deno.test("buyer types: department and seniority narrow who matches", () => {
  apply(clean({ personas: [{ title: "Sales leader", match: ["head of sales", "vp sales"], seniority: ["vp", "head_director"] }, { title: "Ops", match: ["operations"], department: "Revenue operations" }] }));
  try {
    assertEquals(rank("VP Sales", 80).persona, "Sales leader");
    assertEquals(rank("Head of Sales", 80).persona, "Sales leader");
    assertEquals(rank("Sales Manager", 80).persona, null); // not a chosen seniority and no matching words
    assertEquals(rank("Director of Operations", 80, "operations").persona, "Ops");
    assertEquals(rank("Director of Operations", 80, "engineering").persona, null); // wrong department
    assertEquals(rank("Director of Operations", 80, null).persona, "Ops"); // an unknown department never rules someone out
  } finally {
    apply(clean({}));
  }
});

Deno.test("location choices: groups and single countries both resolve to country codes", async () => {
  const { codesFor, REGIONS } = await import("../_shared/lists.ts");
  assertEquals(codesFor("Germany"), ["DE"]);
  assertEquals(codesFor("DACH (Germany, Austria, Switzerland)"), ["DE", "AT", "CH"]);
  assertEquals(codesFor("Mars"), []);
  assertEquals(new Set(REGIONS).size, REGIONS.length);
});

Deno.test("signals you add: rules are cleaned, tools match loosely, and tool and competitor rules add points", () => {
  const p = clean({ signalRules: [
    { id: "a1", type: "competitor", words: ["Outreach", "Gong"], on: true },
    { id: "a2", type: "weird", words: ["x"] },
    { id: "a3", type: "tool", words: [] },
    { type: "watch", words: ["switching CRM"], on: false },
  ] }).signalRules;
  assertEquals(p.length, 2);
  assertEquals(p[0], { id: "a1", type: "competitor", words: ["Outreach", "Gong"], on: true });
  assertEquals(p[1].on, false);
  assertEquals(clean({ signalRules: Array.from({ length: 30 }, (_, i) => ({ type: "tool", words: [`t${i}`] })) }).signalRules.length, 12);
  assertEquals(usesTool(["salesforce-crm", "stripe"], "Salesforce"), true);
  assertEquals(usesTool(["hubspot"], "hub"), false); // short words must match exactly
  assertEquals(usesTool([], "hubspot"), false);
  const base = priorityScore([], 15).score;
  const tool = priorityScore([{ kind: "tech", title: "Uses hubspot", detail: { rule: "r1", ruleType: "tool" } }], 15);
  const comp = priorityScore([{ kind: "tech", title: "Uses a competitor: gong", detail: { rule: "r2", ruleType: "competitor" } }], 15);
  assertEquals([tool.score - base, comp.score - base], [5, 10]);
  assertEquals(tool.parts.custom, 5);
  const many = priorityScore(["a", "b", "c", "d"].map((w) => ({ kind: "tech" as const, title: `Uses a competitor: ${w}`, detail: { rule: "r2", ruleType: "competitor" } })), 15);
  assertEquals(many.parts.custom, 12); // capped
  assertEquals(heatOf([{ kind: "tech", title: "Uses a competitor: gong", detail: { ruleType: "competitor" }, detected_at: new Date().toISOString() }], "matches"), "warm"); // never hot on its own
});

Deno.test("watchlist: a followed company is never hidden by the fit bar, and its alert says so", () => {
  const outside = { employees: 5000, stage: "IPO", country: "US", firmo_at: "2026-01-01", priority_score: 5 };
  assertEquals(worthShowing(outside), false);
  assertEquals(worthShowing({ ...outside, watched_at: "2026-10-12T00:00:00Z" }), true);
  const mail = alertEmail({ name: "Acme", tier: "tier_3", domain: "acme.com", watched: true }, { title: "Acme raises $10M" }, "why", []);
  assertEquals(mail.subject.startsWith("Watchlist: Acme"), true);
  assertEquals(alertEmail({ name: "Acme", tier: "tier_1", domain: "acme.com" }, { title: "x" }, "why", []).subject.startsWith("Hot: "), true);
});

Deno.test("alert and email settings are clamped and reach the shared config", () => {
  const w = clean({ watch: { alertsPerDay: 99, todayCap: 1, watchlistAlerts: false, digestFlags: false } }).watch;
  assertEquals([w.alertsPerDay, w.todayCap, w.watchlistAlerts, w.digestFlags], [10, 3, false, false]);
  assertEquals(clean({ watch: { alertsPerDay: 0 } }).watch.alertsPerDay, 0); // 0 turns instant alerts off
  const d = clean({}).watch;
  assertEquals([d.alertsPerDay, d.todayCap, d.watchlistAlerts, d.digestFlags], [3, 8, true, true]);
  apply(clean({ watch: { alertsPerDay: 5, todayCap: 12 } }));
  try {
    assertEquals([icp.alerts.maxPerDay, icp.today.cap], [5, 12]);
  } finally {
    apply(clean({}));
  }
  assertEquals([icp.alerts.maxPerDay, icp.today.cap], [3, 8]);
});
