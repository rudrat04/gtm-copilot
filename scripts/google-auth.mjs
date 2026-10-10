// One-time Google sign-in. Run: node scripts/google-auth.mjs
// Opens the consent page, receives the redirect on localhost, and saves GOOGLE_REFRESH_TOKEN and
// GOOGLE_ACCOUNT_EMAIL into .env. Tokens are never printed.
import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
const env = Object.fromEntries(
  readFileSync(envPath, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = env;
if (!clientId || !clientSecret) {
  console.error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env first.");
  process.exit(1);
}

const PORT = 8765;
const redirect = `http://localhost:${PORT}/callback`;
const state = crypto.randomBytes(16).toString("hex");
const scopes = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");

const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirect,
  response_type: "code",
  scope: scopes,
  access_type: "offline",
  prompt: "consent", // forces a refresh token even if you signed in before
  state,
});

function saveEnv(pairs) {
  let text = readFileSync(envPath, "utf8");
  if (!text.endsWith("\n")) text += "\n";
  for (const [k, v] of Object.entries(pairs)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : text + `${k}=${v}\n`;
  }
  writeFileSync(envPath, text, { mode: 0o600 });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }

  const done = (code, msg) => { res.writeHead(code, { "Content-Type": "text/html" }).end(`<p style="font:16px system-ui">${msg}</p>`); };
  try {
    if (url.searchParams.get("state") !== state) throw new Error("State mismatch");
    if (url.searchParams.get("error")) throw new Error(url.searchParams.get("error"));

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: url.searchParams.get("code"),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirect,
        grant_type: "authorization_code",
      }),
    });
    const t = await tokenRes.json();
    if (!tokenRes.ok || !t.refresh_token) throw new Error(t.error_description || t.error || "No refresh token returned");

    const email = JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString()).email;
    saveEnv({ GOOGLE_REFRESH_TOKEN: t.refresh_token, GOOGLE_ACCOUNT_EMAIL: email });
    done(200, `Signed in as <b>${email}</b>. You can close this tab and go back to the terminal.`);
    console.log(`Done. Signed in as ${email}. Refresh token saved to .env.`);
    server.close(); process.exit(0);
  } catch (e) {
    done(500, `Sign-in failed: ${e.message}`);
    console.error("Sign-in failed:", e.message);
    server.close(); process.exit(1);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Opening Google sign-in in your browser...");
  console.log("If it does not open, visit this URL:\n" + authUrl + "\n");
  execFile("open", [authUrl], () => {});
});
setTimeout(() => { console.error("Timed out waiting for sign-in."); process.exit(1); }, 5 * 60 * 1000);
