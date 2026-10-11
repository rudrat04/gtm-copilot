// Unit tests for the rule-based parts of Account Copilot: scoring, fit, labels, parsing, validation, redaction.
// No network and no database are used. Run: deno test --allow-env --allow-read tests/
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";

// The shared modules create a database client when they load, so give them harmless values first.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");

const { normalizeDomain } = await import("../_shared/db.ts");
const { redact } = await import("../_shared/log.ts");
const { fitBreakdown } = await import("../_shared/firmo.ts");
const { fitState, heatOf, priorityScore, tierOf } = await import("../_shared/score.ts");
const { isLossReason, LOSS_LABEL, LOSS_REASONS } = await import("../_shared/lossreason.ts");
const { cleanContext, contextLine, labelFor, validate } = await import("../_shared/inbound.ts");
const { companyDomain, parsePost } = await import("../_shared/discover.ts");
const { rank } = await import("../_shared/people.ts");
const { clean } = await import("../_shared/profile.ts");

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
