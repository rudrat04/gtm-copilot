// Small building blocks for the HTML version of internal emails. Inline styles only (email clients ignore
// stylesheets), no hard-coded text or background colours so light and dark mode both stay readable.

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const MUTED = "#78716c";
const ACCENT = "#6366f1";
const LINE = "#d6d3d1";

export const muted = (html: string, size = 13) => `<div style="color:${MUTED};font-size:${size}px;line-height:1.5;margin:2px 0">${html}</div>`;
export const link = (href: string, text: string) => `<a href="${esc(href)}" style="color:${ACCENT};text-decoration:none">${esc(text)}</a>`;
export const mailto = (email: string) => link(`mailto:${email}`, email);
export const h2 = (t: string) =>
  `<div style="font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};margin:26px 0 4px">${esc(t)}</div>`;
export const quote = (label: string, text: string) =>
  `<div style="margin:10px 0;padding:2px 0 2px 12px;border-left:3px solid ${ACCENT}"><b>${esc(label)}</b> ${esc(text)}</div>`;
export const list = (items: string[]) =>
  items.length ? `<ul style="margin:6px 0 6px;padding-left:20px">${items.map((i) => `<li style="margin:3px 0">${i}</li>`).join("")}</ul>` : "";
export const button = (href: string, text: string) =>
  `<a href="${esc(href)}" style="display:inline-block;margin-top:10px;padding:9px 16px;border-radius:8px;background:${ACCENT};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px">${esc(text)}</a>`;
export const divider = `<div style="border-top:1px solid ${LINE};margin:16px 0"></div>`;

export function layout(inner: string, footer: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark"></head>
<body style="margin:0;padding:16px"><div style="max-width:620px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55">
${inner}
${divider}${muted(footer, 12)}
</div></body></html>`;
}
