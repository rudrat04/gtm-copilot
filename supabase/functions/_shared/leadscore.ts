// A lead temperature for a PERSON (Hot, Warm or Cold), the way companies have one. It combines how well the person matches your buyer
// types, how well their company fits, how hot the company is, what happened to the person (a recent job change is the strongest
// reason to reach out) and whether their email is usable. Pure rules, no AI, no credits, and the reasons are listed.

export type PersonInput = {
  relevance: number;                       // from the buyer-type match (0 = not a buyer)
  persona: string | null;
  companyFit: "matches" | "close" | "unknown" | "outside";
  companyHeat: "hot" | "warm" | "watching";
  jobChangeDays: number | null;            // days since a job change was seen, if any
  mentionDays: number | null;              // days since the person was in the news, if any
  emailStatus: string | null;              // valid, accept_all, unknown, invalid, ...
  hasEmail: boolean;
  hsStatus: string | null;                 // known, opted_out, bounced
};
export type Lead = { score: number; label: "hot" | "warm" | "cold" | "blocked"; buyer: "strong" | "good" | "partial" | "none"; reasons: string[] };

export const buyerFit = (relevance: number): Lead["buyer"] => relevance >= 90 ? "strong" : relevance >= 70 ? "good" : relevance >= 50 ? "partial" : "none";

export function scorePerson(p: PersonInput): Lead {
  const buyer = buyerFit(p.relevance);
  if (p.hsStatus === "opted_out" || p.hsStatus === "bounced") return { score: 0, label: "blocked", buyer, reasons: [p.hsStatus === "opted_out" ? "Opted out of email in HubSpot" : "Their address bounced before"] };
  const reasons: string[] = [];
  let score = 0;
  const fitPts = { strong: 40, good: 30, partial: 15, none: 0 }[buyer];
  score += fitPts;
  reasons.push(buyer === "none" ? "Not one of your buyer types" : `${buyer === "strong" ? "Strong" : buyer === "good" ? "Good" : "Partial"} match${p.persona ? `: ${p.persona}` : ""}`);
  score += { matches: 20, close: 10, unknown: 8, outside: 0 }[p.companyFit];
  if (p.companyFit === "matches") reasons.push("Their company fits your profile");
  else if (p.companyFit === "outside") reasons.push("Their company is outside your range");
  score += { hot: 30, warm: 15, watching: 0 }[p.companyHeat];
  if (p.companyHeat === "hot") reasons.push("Their company is hot right now");
  else if (p.companyHeat === "warm") reasons.push("Their company has a signal");
  if (p.jobChangeDays != null && p.jobChangeDays <= 90) { score += 15; reasons.push(`New in role (${p.jobChangeDays <= 1 ? "just now" : `${p.jobChangeDays} days ago`}): new leaders often change tools`); }
  if (p.mentionDays != null && p.mentionDays <= 30) { score += 5; reasons.push("In the news recently"); }
  if (["invalid", "blocked", "disposable"].includes(p.emailStatus ?? "")) { score -= 20; reasons.push("Their email looks invalid"); }
  else if (p.emailStatus === "valid") { score += 5; reasons.push("Email verified"); }
  else if (!p.hasEmail) reasons.push("No email found");
  if (buyer === "none") score = Math.min(score, 30); // someone who is not a buyer is never more than cold
  score = Math.max(0, Math.min(100, score));
  return { score, label: score >= 70 ? "hot" : score >= 45 ? "warm" : "cold", buyer, reasons };
}
