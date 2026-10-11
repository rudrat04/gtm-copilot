import { sb } from "./db.ts";
import { log } from "./log.ts";
import { isListing, rolesFromSnippet, type Signal } from "./signals.ts";
import { keepRelevant } from "./relevance.ts";
import { roundKey } from "./predictleads.ts";
import { isFundingSignal } from "./score.ts";

// One-off and repeatable tidy-up of signals stored before the stricter filters existed. Works on our own database only.
// A dry run lists what would change; nothing is deleted without `dry: false`.

const DAY = 86_400_000;
type Row = { id: string; account_id: string; kind: string; title: string; detail: Record<string, unknown> | null };

export type CleanReport = { dry: boolean; listings: string[]; duplicate_rounds: string[]; renamed_hiring: string[]; removed_hiring: string[]; ai_dropped: string[]; ai_labelled: number; ai_cost_note?: string };

const when = (r: Row) => Date.parse(String(r.detail?.published ?? ""));

export async function cleanSignals(opts: { dry: boolean; ai?: boolean }): Promise<CleanReport> {
  const { data: accts } = await sb.from("cp_accounts").select("id,name,domain,segment");
  const acct = new Map((accts ?? []).map((a) => [a.id, a]));
  const label = (r: Row) => `${acct.get(r.account_id)?.name ?? "?"}: ${r.title.slice(0, 90)}`;
  const report: CleanReport = { dry: opts.dry, listings: [], duplicate_rounds: [], renamed_hiring: [], removed_hiring: [], ai_dropped: [], ai_labelled: 0 };
  const remove = new Set<string>();

  const { data: news } = await sb.from("cp_signals").select("id,account_id,kind,title,detail").eq("kind", "news").limit(3000);
  const newsRows = (news ?? []) as Row[];

  // 1) Directory and data-site pages.
  for (const r of newsRows) if (isListing(r.title)) { report.listings.push(label(r)); remove.add(r.id); }

  // 2) One funding round counted several times: keep the earliest.
  const byRound = new Map<string, Row[]>();
  for (const r of newsRows.filter((x) => !remove.has(x.id) && isFundingSignal(x))) {
    const k = roundKey(r.title);
    if (k) (byRound.get(`${r.account_id}|${k}`) ?? byRound.set(`${r.account_id}|${k}`, []).get(`${r.account_id}|${k}`)!).push(r);
  }
  for (const rows of byRound.values()) {
    const sorted = rows.filter((r) => !Number.isNaN(when(r))).sort((a, b) => when(a) - when(b));
    let anchor = sorted[0];
    for (const r of sorted.slice(1)) {
      if (when(r) - when(anchor) < 45 * DAY) { report.duplicate_rounds.push(label(r)); remove.add(r.id); } else anchor = r;
    }
  }

  // 3) Optional, about 0.1 cent per company: label older news with no type, and drop opinion pieces, namesakes and the like.
  if (opts.ai) {
    const unlabelled = newsRows.filter((r) => !remove.has(r.id) && !r.detail?.newsType && !r.detail?.plType);
    const perAccount = new Map<string, Row[]>();
    for (const r of unlabelled) (perAccount.get(r.account_id) ?? perAccount.set(r.account_id, []).get(r.account_id)!).push(r);
    for (const [id, rows] of [...perAccount].slice(0, 25)) {
      const a = acct.get(id);
      if (!a) continue;
      const sigs: Signal[] = rows.map((r) => ({ kind: "news", title: r.title, detail: r.detail ?? {} }));
      const kept = await keepRelevant(a.name, a.domain, a.segment ?? "", sigs, null);
      const keptTitles = new Map(kept.headlines.map((h) => [h.title, String(h.detail?.newsType ?? "")]));
      for (const r of rows) {
        const type = keptTitles.get(r.title);
        if (type === undefined) { report.ai_dropped.push(label(r)); remove.add(r.id); }
        else if (type && !opts.dry) { await sb.from("cp_signals").update({ detail: { ...(r.detail ?? {}), newsType: type } }).eq("id", r.id); report.ai_labelled++; }
        else if (type) report.ai_labelled++;
      }
    }
    report.ai_cost_note = "About 0.1 cent per company checked.";
  }

  // 4) Hacker News hiring titles that were built from a URL or a city.
  const { data: hn } = await sb.from("cp_signals").select("id,account_id,kind,title,detail").eq("kind", "hiring").contains("detail", { source: "hn_hiring" });
  for (const r of (hn ?? []) as Row[]) {
    const a = acct.get(r.account_id);
    if (!a) continue;
    const { data: found } = await sb.from("cp_discovered").select("snippet").eq("domain", a.domain).maybeSingle();
    const roles = rolesFromSnippet(found?.snippet ?? "");
    if (!roles) { // the post names no sales or go-to-market role, so it was never a sales-hiring signal
      report.removed_hiring.push(`${a.name}: ${r.title.slice(0, 90)}`);
      remove.add(r.id);
      continue;
    }
    const title = `Hiring: ${roles} (Hacker News Who is hiring)`;
    if (title !== r.title) {
      report.renamed_hiring.push(`${a.name}: ${r.title.slice(0, 70)} -> ${title}`);
      if (!opts.dry) await sb.from("cp_signals").update({ title }).eq("id", r.id);
    }
  }

  if (!opts.dry && remove.size) await sb.from("cp_signals").delete().in("id", [...remove]);
  await log("info", "signals_cleaned", { detail: { dry: opts.dry, listings: report.listings.length, duplicate_rounds: report.duplicate_rounds.length, renamed: report.renamed_hiring.length, removed_hiring: report.removed_hiring.length, ai_dropped: report.ai_dropped.length } });
  return report;
}
