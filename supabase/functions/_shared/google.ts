import { log } from "./log.ts";

let cached: { token: string; exp: number } | null = null;

export function googleConfigured(): boolean {
  return !!(Deno.env.get("GOOGLE_CLIENT_ID") && Deno.env.get("GOOGLE_CLIENT_SECRET") && Deno.env.get("GOOGLE_REFRESH_TOKEN"));
}

export const ownerEmail = () => (Deno.env.get("GOOGLE_ACCOUNT_EMAIL") ?? "").toLowerCase();

async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    await log("error", "google_token_failed", {
      message: body.error_description ?? body.error ?? `HTTP ${res.status}`,
      detail: { status: res.status, error: body.error, hint: body.error === "invalid_grant" ? "Re-run node scripts/google-auth.mjs" : undefined },
    });
    throw new Error("Google sign-in expired or invalid");
  }
  cached = { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function g(url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    await log("error", "google_request_failed", {
      detail: { url: url.split("?")[0], status: res.status, error: JSON.stringify(body.error ?? body).slice(0, 300) },
    });
    throw new Error(`Google ${res.status}`);
  }
  return body;
}

export type CalEvent = {
  id: string;
  status?: string;
  summary?: string;
  updated: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email: string; displayName?: string; self?: boolean; resource?: boolean; responseStatus?: string }[];
};

/** Events changed since `updatedMin` that have not ended yet. */
export async function listChangedEvents(updatedMin: string): Promise<CalEvent[]> {
  const q = new URLSearchParams({
    updatedMin,
    timeMin: new Date().toISOString(),
    singleEvents: "true",
    showDeleted: "true", // cancelled meetings must show up, so we can tell the owner
    maxResults: "50",
    orderBy: "updated",
  });
  const body = await g(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`);
  return body.items ?? [];
}

export async function getEvent(id: string): Promise<CalEvent | null> {
  try {
    return await g(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
}

function b64(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}
// Mail lines must stay short (RFC 2045): wrap base64 bodies at 76 columns.
const wrap76 = (s: string) => s.replace(/(.{76})/g, "$1\r\n");

/** Plain text when ASCII; otherwise encoded words of at most 15 characters each, as the standard requires. */
function encodeSubject(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const chars = [...s];
  const words: string[] = [];
  for (let i = 0; i < chars.length; i += 15) words.push(`=?UTF-8?B?${b64(chars.slice(i, i + 15).join(""))}?=`);
  return words.join("\r\n ");
}

/**
 * Sends an email from the signed-in account. Only ever used to email the owner.
 * With `html`, the message has two versions (HTML and plain text) and the reader's client picks one.
 */
export async function sendMail(to: string, subject: string, text: string, html?: string) {
  const head = [`To: ${to}`, `Subject: ${encodeSubject(subject)}`, "MIME-Version: 1.0"];
  const part = (type: string, body: string) =>
    [`Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", wrap76(b64(body))].join("\r\n");
  const boundary = `ac_${crypto.randomUUID().replace(/-/g, "")}`;
  const raw = html
    ? [...head, `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
      `--${boundary}`, part("text/plain", text), `--${boundary}`, part("text/html", html), `--${boundary}--`, ""].join("\r\n")
    : [...head, part("text/plain", text)].join("\r\n");
  const body = b64(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await g("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: body }),
  });
}
