import icp from "./icp.json" with { type: "json" };

// Leaf module (no imports beyond the ICP) so score.ts can use it without a cycle.
const hashStr = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
type Seller = { pitch?: string; name?: string; description?: string };
const c = () => icp.company as { industries: string[]; keywords?: string[]; excludeWords?: string[] };

/** The part of the profile that decides fit, in plain English. */
export const icpText = (): string => {
  const s = icp.seller as Seller;
  return `What the seller sells: ${s.pitch ?? s.description ?? ""}\nTarget industries: ${c().industries.join(", ") || "any"}${c().keywords?.length ? `\nKeywords: ${c().keywords!.join(", ")}` : ""}${c().excludeWords?.length ? `\nNever: ${c().excludeWords!.join(", ")}` : ""}`;
};
/** Changes whenever something that decides fit changes, so old verdicts are re-judged. */
export const icpVersion = (): string => hashStr(icpText());
/** A stored verdict counts only when it was made for the current profile. */
export const verdictCurrent = (a: { fit_ai?: string | null; fit_ai_ver?: string | null }): boolean => !!a.fit_ai && a.fit_ai_ver === icpVersion();
