import icp from "./icp.json" with { type: "json" };

/** The messages the owner can switch off completely: nothing is built, no credits or AI are spent, nothing is sent. */
export const MAIL_KEYS = ["hot", "watchlist", "daily", "flags", "briefs", "debrief", "leads", "loss", "calendar"] as const;
export const mailOn = (key: (typeof MAIL_KEYS)[number]): boolean => (icp.watch as unknown as { mail?: Record<string, boolean> }).mail?.[key] !== false;
