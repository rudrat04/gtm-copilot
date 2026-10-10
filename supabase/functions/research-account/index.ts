import { json, normalizeDomain, sb } from "../_shared/db.ts";
import { askClaude, BudgetError, parseJson } from "../_shared/claude.ts";
import { collectSignals, type SiteInfo } from "../_shared/signals.ts";
import { priorityScore } from "../_shared/score.ts";
import { log, serve } from "../_shared/log.ts";
import { callerId, isAdmin, rateOk } from "../_shared/auth.ts";
import { fetchFirmo, firmoLine, fitPoints, saveFirmo } from "../_shared/firmo.ts";
import icp from "../_shared/icp.json" with { type: "json" };

const CACHE_HOURS = 24;

const SYSTEM = `You are a sales researcher writing a one-page account dossier for a rep at ${icp.seller.name}.
${icp.seller.pitch}
The ICP describes who ${icp.seller.name} sells to. It is NOT a fact about the company being researched.
Describe the company only from the website evidence and signals. Never attribute ICP traits to it.
Use ONLY the evidence provided. If something is not in the evidence, write "unknown" rather than guessing.
Website text (product demos, sample deals, customer quotes, pricing examples) is marketing copy about their product. It is NOT evidence of the company's own sales situation, stage, team size or deal sizes. Never cite it that way.
Verified facts (headcount, funding stage, funds raised, HQ) come from a company database. Trust them over anything on the website, and quote them when judging ICP fit. Do not state funding stage or headcount unless the verified facts or the evidence say so.
Talk-track openers must be questions about the prospect's situation. They must never claim customers, experience, research or relationships ("we work with", "teams we've seen", "we noticed"), and must never say or imply the prospect said something ("you mentioned", "you said", "I saw", "I noticed", "as you know"). Ground each one in a listed signal or in what the company sells.
When there is no buying signal, say so and do not invent problems.
Be specific and short. No filler, no hype. Return a single JSON object and nothing else.`;

function prompt(name: string, domain: string, site: SiteInfo | null, signals: unknown[], facts: string): string {
  return `Company: ${name} (${domain})
Verified facts: ${facts || "none available"}

ICP:
${JSON.stringify(icp.company)}
Buyer personas: ${icp.personas.map((p) => p.title).join("; ")}

Website evidence:
${JSON.stringify(site ? { title: site.title, description: site.description, text: site.text } : null)}

Signals found (hiring, news, Hacker News):
${JSON.stringify(signals)}

Return JSON with exactly these keys:
{
  "summary": "2 sentences: what they do and who they sell to",
  "icp_fit": { "score": 0-100, "reasons": ["max 3 short reasons, grounded in evidence"] },
  "why_now": "one sentence naming the strongest buying signal, or 'No strong signal found'",
  "pains": ["max 3 likely sales/RevOps pains, tied to evidence"],
  "talk_tracks": [{ "angle": "short label", "opener": "one natural sentence a rep could say" }],
  "risks": ["max 2 reasons this may not be a fit"]
}
Give exactly 3 talk_tracks.`;
}

serve("research-account", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = (await req.json().catch(() => null)) ?? {};
  const domain = normalizeDomain(String(body.domain ?? ""));
  if (!domain) {
    await log("warn", "invalid_domain", { message: "Rejected input", detail: { input: String(body.domain ?? "").slice(0, 80) } });
    return json({ error: "Enter a valid company domain, e.g. linear.app" }, 400);
  }

  let { data: account } = await sb.from("cp_accounts").select("*").eq("domain", domain).maybeSingle();

  // Serve a recent dossier without spending AI credits.
  if (account && !body.refresh) {
    const { data: cached } = await sb.from("cp_dossiers").select("content, created_at")
      .eq("account_id", account.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (cached && Date.now() - new Date(cached.created_at).getTime() < CACHE_HOURS * 3600_000) {
      const { data: signals } = await sb.from("cp_signals").select("kind,title,url,detail")
        .eq("account_id", account.id).order("detected_at", { ascending: false }).limit(30);
      await log("info", "research_cache_hit", { account: domain, detail: { age_hours: +((Date.now() - new Date(cached.created_at).getTime()) / 3600_000).toFixed(1) } });
      return json({ account, signals, dossier: cached.content, cached: true });
    }
  }

  // Fresh research spends AI credits. Owner is unlimited; everyone else gets a few an hour and a daily cap overall.
  if (!(await isAdmin(req))) {
    const me = await callerId(req);
    if (!(await rateOk(`research:${me}`, 3600, 6)) || !(await rateOk("research:all", 86400, 40))) {
      await log("warn", "research_rate_limited", { account: domain });
      return json({ error: "Too many new lookups right now. Saved companies still load instantly; try again in a little while." }, 429);
    }
  }

  const guessName = account?.name ?? domain.split(".")[0].replace(/^./, (c) => c.toUpperCase());
  const { site, signals } = await collectSignals(guessName, domain, account?.segment ?? "");

  if (!account) {
    // Website titles are often long slogans; fall back to the domain name when the first part is not a short name.
    const firstPart = site?.title ? site.title.split(/\s*[|–—:]\s*|\s+-\s+/)[0].trim() : "";
    const name = firstPart && firstPart.length <= 40 && !firstPart.includes("&") ? firstPart : guessName;
    const { data, error } = await sb.from("cp_accounts")
      .insert({ domain, name, source: "research" }).select().single();
    if (error) {
      await log("error", "account_insert_failed", { account: domain, message: error.message });
      return json({ error: error.message }, 500);
    }
    account = data;
  }

  // Company facts cost a little Hunter credit, so only the owner triggers the lookup, and only once per company.
  if (!account.firmo_at && (await isAdmin(req))) {
    const f = await fetchFirmo(domain);
    if (f) {
      await saveFirmo(account.id, f);
      account = (await sb.from("cp_accounts").select("*").eq("id", account.id).single()).data;
    }
  }

  if (signals.length) {
    await sb.from("cp_signals").upsert(
      signals.map((s) => ({
        account_id: account.id,
        kind: s.kind,
        title: s.title.slice(0, 300),
        url: s.url,
        detail: s.detail ?? {},
      })),
      { onConflict: "account_id,kind,title", ignoreDuplicates: true },
    );
  }

  let dossier;
  try {
    const raw = await askClaude({
      feature: "research-account",
      system: SYSTEM,
      user: prompt(account.name, domain, site, signals, firmoLine(account)),
      maxTokens: 1400,
    });
    dossier = parseJson<{ icp_fit?: { score?: number }; why_now?: string }>(raw);
  } catch (e) {
    if (e instanceof BudgetError) return json({ error: "Daily AI budget reached. Try again tomorrow." }, 429);
    await log("error", "research_failed", { account: domain, message: (e as Error).message });
    return json({ error: `Research failed: ${(e as Error).message}` }, 502);
  }

  await sb.from("cp_dossiers").insert({ account_id: account.id, content: dossier, model: icp.ai.model });
  await sb.from("cp_accounts").update({
    icp_score: Math.round(Number(dossier.icp_fit?.score ?? 0)) || null,
    why_now: dossier.why_now ?? null,
    priority_score: priorityScore(signals, fitPoints(account)).score,
    last_scanned_at: new Date().toISOString(),
  }).eq("id", account.id);

  await log("info", "research_done", {
    account: domain,
    detail: { signals: signals.length, icp_score: dossier.icp_fit?.score ?? null, new_account: account.source === "research" },
  });
  return json({ account, signals, dossier, cached: false });
});
