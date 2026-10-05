import { sb } from "./db.ts";
import { log } from "./log.ts";
import icp from "./icp.json" with { type: "json" };

// Claude Haiku 4.5 list prices, USD per token.
const PRICE_IN = 1 / 1_000_000;
const PRICE_OUT = 5 / 1_000_000;

export class BudgetError extends Error {}

export async function askClaude(opts: {
  feature: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const { data } = await sb.from("cp_ai_spend_today").select("usd").single();
  if (Number(data?.usd ?? 0) >= icp.ai.dailyBudgetUsd) {
    await log("warn", "budget_reached", { detail: { feature: opts.feature, spent_usd: Number(data?.usd) } });
    throw new BudgetError("Daily AI budget reached");
  }

  const started = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: icp.ai.model,
      max_tokens: opts.maxTokens ?? 1500,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    await log("error", "ai_request_failed", {
      message: `Anthropic ${res.status}`,
      detail: { feature: opts.feature, status: res.status, body },
      ms: Date.now() - started,
    });
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`);
  }

  const out = await res.json();
  const inTok = out.usage?.input_tokens ?? 0;
  const outTok = out.usage?.output_tokens ?? 0;
  await sb.from("cp_ai_usage").insert({
    feature: opts.feature,
    model: icp.ai.model,
    input_tokens: inTok,
    output_tokens: outTok,
    cost_usd: inTok * PRICE_IN + outTok * PRICE_OUT,
  });
  await log("info", "ai_call", {
    detail: { feature: opts.feature, input_tokens: inTok, output_tokens: outTok, cost_usd: +(inTok * PRICE_IN + outTok * PRICE_OUT).toFixed(5), stop: out.stop_reason },
    ms: Date.now() - started,
  });
  if (out.stop_reason === "max_tokens") {
    await log("warn", "ai_output_truncated", { detail: { feature: opts.feature, max_tokens: opts.maxTokens ?? 1500 } });
  }
  return out.content?.map((c: { text?: string }) => c.text ?? "").join("") ?? "";
}

export function parseJson<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) {
    void log("error", "json_parse_failed", { message: "Model returned no JSON", detail: { snippet: text.slice(0, 300) } });
    throw new Error("Model returned no JSON");
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch (e) {
    void log("error", "json_parse_failed", { message: (e as Error).message, detail: { snippet: text.slice(0, 300) } });
    throw e;
  }
}
