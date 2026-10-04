import { askClaude, parseJson } from "./claude.ts";
import type { SiteInfo, Signal } from "./signals.ts";
import icp from "./icp.json" with { type: "json" };

export type Draft = {
  why_now: string;
  persona: string;
  subject: string;
  body: string;
};

const SYSTEM = `You write short first-touch outreach for a rep at ${icp.seller.name}.
${icp.seller.pitch}
Rules:
- Use ONLY the evidence provided. Never invent facts, numbers, customers or relationships.
- Never write "we work with", "teams we've seen", "I noticed you" unless the evidence states it. Name the actual signal instead.
- Website text is marketing copy about their product, not proof of their sales situation.
- The email is at most 80 words, plain text, one soft question as the call to action. No hype, no emojis, no exclamation marks.
- Return a single JSON object and nothing else.`;

export async function writeDraft(
  name: string,
  domain: string,
  site: SiteInfo | null,
  signals: Signal[],
): Promise<Draft> {
  const evidence = signals.slice(0, 12).map((s) => `${s.kind}: ${s.title}`);
  const raw = await askClaude({
    feature: "signal-draft",
    system: SYSTEM,
    maxTokens: 600,
    user: `Company: ${name} (${domain})
What they say about themselves: ${site?.description || site?.title || "unknown"}
Personas we sell to: ${icp.personas.map((p) => p.title).join("; ")}
Signals:
${evidence.join("\n")}

Return JSON: {
  "why_now": "one sentence naming the strongest signal and why it matters to ${icp.seller.name}",
  "persona": "the single best persona title from the list",
  "subject": "max 6 words, no clickbait",
  "body": "the email body, starting with a first name placeholder line 'Hi {{first_name}},'"
}`,
  });
  return parseJson<Draft>(raw);
}
