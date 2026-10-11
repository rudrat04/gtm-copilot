// Checks the static page without a browser: its script must parse, the content security policy must be present,
// and every dynamic value must go through esc() (a rough guard against raw interpolation of API fields).
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../docs/index.html", import.meta.url), "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
let ok = true;
const fail = (m) => { console.error("FAIL:", m); ok = false; };

try { new Function(script); } catch (e) { fail(`the page script does not parse: ${e.message}`); }
if (!/<meta http-equiv="Content-Security-Policy"/.test(html)) fail("the content security policy meta tag is missing");
if (!/default-src 'none'/.test(html)) fail("the content security policy no longer starts from default-src 'none'");
if (/innerHTML\s*=\s*[^;]*\$\{(?:d|r|e)\.(?:error|message)\}/.test(script)) fail("an error message is written to innerHTML without esc()");
if (ok) console.log("page checks passed");
process.exit(ok ? 0 : 1);
