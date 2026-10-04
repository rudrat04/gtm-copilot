import { cors, json, normalizeDomain, sb } from "../_shared/db.ts";
import { askClaude, BudgetError, parseJson } from "../_shared/claude.ts";
import { collectSignals } from "../_shared/signals.ts";
import icp from "../_shared/icp.json" with { type: "json" };

const CACHE_HOURS = 24;

const SYSTEM = `You are a sales researcher writing a one-page account dossier for a rep at ${icp.seller.name}.
${icp.seller.pitch}
The ICP describes who ${icp.seller.name} sells to. It is NOT a fact about the company being researched.
Describe the company only from the website evidence and signals. Never attribute ICP traits to it.
Use ONLY the evidence provided. If something is not in the evidence, write "unknown" rather than guessing.
When there is no buying signal, keep talk tracks grounded in what the company actually sells and do not invent problems.
Be specific and short. No filler, no hype. Return a single JSON object and nothing else.`;

function prompt(name: string, domain: string, site: unknown, signals: unknown[]): string {
  return `Company: ${name} (${domain})

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
  "likely_buyers": [{ "persona": "title", "why": "short reason" }],
  "risks": ["max 2 reasons this may not be a fit"]
}
Give exactly 3 talk_tracks.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = await req.json().catch(() => ({}));
  const domain = normalizeDomain(String(body.domain ?? ""));
  if (!domain) return json({ error: "Enter a valid company domain, e.g. linear.app" }, 400);

  let { data: account } = await sb.from("cp_accounts").select("*").eq("domain", domain).maybeSingle();

  // Serve a recent dossier without spending AI credits.
  if (account && !body.refresh) {
    const { data: cached } = await sb.from("cp_dossiers").select("content, created_at")
      .eq("account_id", account.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (cached && Date.now() - new Date(cached.created_at).getTime() < CACHE_HOURS * 3600_000) {
      const { data: signals } = await sb.from("cp_signals").select("kind,title,url,detail")
        .eq("account_id", account.id).order("detected_at", { ascending: false }).limit(30);
      return json({ account, signals, dossier: cached.content, cached: true });
    }
  }

  const guessName = account?.name ?? domain.split(".")[0].replace(/^./, (c) => c.toUpperCase());
  const { site, signals } = await collectSignals(guessName, domain);

  if (!account) {
    const name = site?.title ? site.title.split(/[|\-–:]/)[0].trim().slice(0, 60) || guessName : guessName;
    const { data, error } = await sb.from("cp_accounts")
      .insert({ domain, name, source: "research" }).select().single();
    if (error) return json({ error: error.message }, 500);
    account = data;
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
      user: prompt(account.name, domain, site, signals),
      maxTokens: 1400,
    });
    dossier = parseJson<{ icp_fit?: { score?: number }; why_now?: string }>(raw);
  } catch (e) {
    if (e instanceof BudgetError) return json({ error: "Daily AI budget reached. Try again tomorrow." }, 429);
    return json({ error: `Research failed: ${(e as Error).message}` }, 502);
  }

  await sb.from("cp_dossiers").insert({ account_id: account.id, content: dossier, model: icp.ai.model });
  await sb.from("cp_accounts").update({
    icp_score: Math.round(Number(dossier.icp_fit?.score ?? 0)) || null,
    why_now: dossier.why_now ?? null,
    last_scanned_at: new Date().toISOString(),
  }).eq("id", account.id);

  return json({ account, signals, dossier, cached: false });
});
