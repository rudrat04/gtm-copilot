import { AsyncLocalStorage } from "node:async_hooks";
import { cors, sb } from "./db.ts";
import { applyProfile } from "./profile.ts";

type Level = "info" | "warn" | "error";

// Defence in depth: whatever ends up in a log line, secrets are masked first.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/(api[_-]?key|token|secret|password|authorization)(["']?\s*[=:]\s*["']?)[^&\s"')]+/gi, "$1$2[redacted]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]"],
  [/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted-jwt]"],
  [/\b[a-f0-9]{40,}\b/gi, "[redacted-hex]"],
];
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((t, [re, to]) => t.replace(re, to), text);
}
type Ctx = { fn: string; runId: string };

const store = new AsyncLocalStorage<Ctx>();

/**
 * Write one structured log row. Works from any shared module: the function name and run id
 * come from the current invocation, so callers only pass what is specific to the event.
 * Logging must never break the request, so failures here are swallowed.
 */
export async function log(
  level: Level,
  event: string,
  data: { message?: string; account?: string; detail?: unknown; ms?: number } = {},
): Promise<void> {
  const ctx = store.getStore();
  const row = {
    run_id: ctx?.runId ?? null,
    fn: ctx?.fn ?? "unknown",
    level,
    event,
    account: data.account ?? null,
    message: data.message ? redact(data.message).slice(0, 500) : null,
    detail: JSON.parse(redact(JSON.stringify(data.detail ?? {}))),
    ms: data.ms ?? null,
  };
  console[level === "info" ? "log" : level](JSON.stringify(row));
  try {
    await sb.from("cp_logs").insert(row);
  } catch { /* ignore */ }
}

export function runId(): string | undefined {
  return store.getStore()?.runId;
}

/**
 * Serve an Edge Function with a run context, request/response logging and a safety net for
 * uncaught errors. A response carrying the header `x-noop` is treated as an idle run and
 * is not logged, so a cron that wakes up every few minutes does not flood the table.
 */
export function serve(fn: string, handler: (req: Request) => Promise<Response>) {
  Deno.serve((req) =>
    store.run({ fn, runId: crypto.randomUUID() }, async () => {
      if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
      const started = Date.now();
      const id = runId()!;
      try {
        await applyProfile();
        const res = await handler(req);
        try {
          res.headers.set("x-run-id", id);
        } catch { /* immutable headers */ }
        if (!res.headers.has("x-noop")) {
          const status = res.status;
          await log(status >= 500 ? "error" : status >= 400 ? "warn" : "info", "response", {
            detail: { status, method: req.method },
            ms: Date.now() - started,
          });
        }
        return res;
      } catch (e) {
        const err = e as Error;
        await log("error", "unhandled_exception", {
          message: err.message,
          detail: { stack: err.stack?.slice(0, 1500) },
          ms: Date.now() - started,
        });
        return new Response(JSON.stringify({ error: "Internal error", run_id: id }), {
          status: 500,
          headers: { ...cors, "Content-Type": "application/json", "x-run-id": id },
        });
      }
    })
  );
}
