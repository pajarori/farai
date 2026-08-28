import type { Session } from "./types";

export const DEFAULT_SESSION_TITLE = "new session";

const DEFAULT_TITLES = new Set(["new session", "untitled", "untitled session"]);
const LOW_INFORMATION = /^(?:hi|hey|hello|halo|hai|yo|bro|test|testing|ping|p|ok|oke|okay|sip|thanks|thank you|makasih|terima kasih)[.!?\s]*$/i;
const LEADING_FILLER = /^(?:(?:please|pls|tolong|mohon|coba|cobain|bisa(?:kah)?|boleh|mari|ayo|yuk|can you|could you|would you|i want you to|saya mau|gw mau|gue mau)\s+)+/i;

export function isDefaultSessionTitle(value: string | undefined): boolean {
  return !value?.trim() || DEFAULT_TITLES.has(value.trim().toLowerCase());
}

export function normalizeSessionTitle(value: string, fallback = DEFAULT_SESSION_TITLE): string {
  const clean = value
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*(?:[-*#>]+|\d+[.)])\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:]+$/, "")
    .trim();
  if (!clean) return fallback;
  return clean.length > 72 ? `${clean.slice(0, 69).trimEnd()}...` : clean;
}

export function titleFromPrompt(prompt: string, fallback = DEFAULT_SESSION_TITLE): string {
  const first = prompt
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  if (!first || first.startsWith("/") || LOW_INFORMATION.test(first)) return fallback;
  return normalizeSessionTitle(first.replace(LEADING_FILLER, ""), fallback);
}

export function sessionDisplayName(session: Pick<Session, "title"> | undefined): string {
  if (isDefaultSessionTitle(session?.title)) return DEFAULT_SESSION_TITLE;
  return normalizeSessionTitle(session!.title!, DEFAULT_SESSION_TITLE);
}
