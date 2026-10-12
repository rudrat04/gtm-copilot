import { sb } from "./db.ts";
import { log } from "./log.ts";

// The notification centre: things worth knowing, each told once (the key dedupes), with a place to go and a read state.
// Emails still go out as before; this is the same news kept inside the app so nothing is lost in an inbox.

export type NoteKind = "alert" | "watch" | "flag" | "discovery" | "credits" | "info";
export type Note = { key: string; kind: NoteKind; title: string; body?: string | null; route?: string | null };

/** Stores a notification once. Never throws: a failure here must not break the job that produced the news. */
export async function notify(n: Note): Promise<boolean> {
  try {
    const { data, error } = await sb.from("cp_notifications").upsert({ key: n.key, kind: n.kind, title: n.title.slice(0, 200), body: n.body?.slice(0, 400) ?? null, route: n.route ?? null }, { onConflict: "key", ignoreDuplicates: true }).select("id");
    if (error) { await log("warn", "notify_failed", { message: error.message }); return false; }
    return (data ?? []).length > 0;
  } catch { return false; }
}

export async function listNotifications(limit = 40) {
  const { data } = await sb.from("cp_notifications").select("id,kind,title,body,route,created_at,read_at").order("created_at", { ascending: false }).limit(limit);
  const { count } = await sb.from("cp_notifications").select("id", { count: "exact", head: true }).is("read_at", null);
  return { items: data ?? [], unread: count ?? 0 };
}

/** Marks some (or all) as read. */
export async function markRead(ids?: string[]) {
  const q = sb.from("cp_notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
  await (ids?.length ? q.in("id", ids) : q);
}
