import { sb } from "./db.ts";
import { notify } from "./notify.ts";

// Followed companies: nothing is dropped silently. One that has been quiet for a long time asks "still following?".
export const QUIET_DAYS = 60;

/** Pure: days since the latest of the given dates (ISO strings), or null when there are none. */
export const quietDays = (dates: (string | null | undefined)[], now = Date.now()): number | null => {
  const t = dates.filter(Boolean).map((d) => Date.parse(d as string)).filter((n) => !isNaN(n));
  return t.length ? Math.floor((now - Math.max(...t)) / 864e5) : null;
};

/** One notification per quiet company every 60 days. Free: only reads what we already hold. */
export async function askStillFollowing(): Promise<number> {
  const cutoff = new Date(Date.now() - QUIET_DAYS * 864e5).toISOString();
  const { data: followed } = await sb.from("cp_accounts").select("id,name,watched_at").not("watched_at", "is", null).lt("watched_at", cutoff).is("removed_at", null);
  let n = 0;
  for (const a of followed ?? []) {
    const [{ count: s }, { count: e }] = await Promise.all([
      sb.from("cp_signals").select("id", { count: "exact", head: true }).eq("account_id", a.id).gte("detected_at", cutoff),
      sb.from("cp_watch_events").select("id", { count: "exact", head: true }).eq("account_id", a.id).gte("detected_at", cutoff),
    ]);
    if ((s ?? 0) + (e ?? 0) > 0) continue;
    const ok = await notify({ key: `quiet:${a.id}:${Math.floor(Date.now() / (QUIET_DAYS * 864e5))}`, kind: "watch", title: `Still watching ${a.name}?`, body: `Nothing new for ${QUIET_DAYS} days. Unfollow it if it is no longer interesting.`, route: "#watchlist" });
    if (ok) n++;
  }
  return n;
}
