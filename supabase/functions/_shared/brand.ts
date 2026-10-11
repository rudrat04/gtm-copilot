import { sb } from "./db.ts";

// White-label: the name, tagline and logo the page shows. Public to read (it is only branding), owner-only to change.
// The logo is a small image stored as a data URL, so the page needs no file hosting.

export type Brand = { name: string; tagline: string; logo: string };
export const DEFAULT_BRAND: Brand = { name: "F1rstword", tagline: "Know who to talk to, and when.", logo: "" };
export const LOGO_MAX = 300_000;

const LOGO_RE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

/** Validates what the page sends. Anything odd falls back to the default (text) or no logo. Pure. */
export function cleanBrand(input: unknown): Brand {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const text = (v: unknown, max: number, fallback: string) => {
    const t = String(v ?? "").replace(/[<>]|\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
    return t || fallback;
  };
  const logo = typeof i.logo === "string" && i.logo.length <= LOGO_MAX && LOGO_RE.test(i.logo) ? i.logo : "";
  return { name: text(i.name, 40, DEFAULT_BRAND.name), tagline: text(i.tagline, 80, DEFAULT_BRAND.tagline), logo };
}

export async function loadBrand(): Promise<Brand> {
  const { data } = await sb.from("cp_state").select("value").eq("key", "brand").maybeSingle();
  try { return data?.value ? cleanBrand(JSON.parse(data.value)) : DEFAULT_BRAND; } catch { return DEFAULT_BRAND; }
}

export async function saveBrand(b: Brand) {
  await sb.from("cp_state").upsert({ key: "brand", value: JSON.stringify(b), updated_at: new Date().toISOString() });
}
