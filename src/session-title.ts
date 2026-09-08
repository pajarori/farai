import type { Session } from "./types";

export const DEFAULT_SESSION_TITLE = "new session";

const DEFAULT_TITLES = new Set(["new session", "untitled", "untitled session"]);
const LOW_INFORMATION = /^(?:hi|hey|hello|halo|hai|yo|bro|test|testing|ping|p|ok|oke|okay|sip|thanks|thank you|makasih|terima kasih)[.!?\s]*$/i;
const LEADING_FILLER = /^(?:(?:please|pls|tolong|mohon|coba|cobain|bisa(?:kah)?|boleh|mari|ayo|yuk|can you|could you|would you|i want you to|saya mau|gw mau|gue mau)\s+)+/i;

export function isDefaultSessionTitle(value: string | undefined): boolean {
  return !value?.trim() || DEFAULT_TITLES.has(value.trim().toLowerCase());
}

const TITLE_MAX_WORDS = 6;
const TITLE_MAX_CHARS = 48;

export function normalizeSessionTitle(value: string, fallback = DEFAULT_SESSION_TITLE): string {
  const clean = value
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_#>~|]+/g, " ")
    .replace(/["'“”‘’()\[\]{}]/g, " ")
    .replace(/^\s*(?:[-*#>]+|\d+[.)])\s*/, "")
    .replace(/[^\p{L}\p{N}\s.\/&+-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:\/&+-]+$/, "")
    .trim()
    .toLowerCase();
  if (!clean) return fallback;
  const byWords = clean.split(" ").slice(0, TITLE_MAX_WORDS).join(" ");
  return byWords.length > TITLE_MAX_CHARS ? byWords.slice(0, TITLE_MAX_CHARS).trimEnd() : byWords;
}

export function titleFromPrompt(prompt: string, fallback = DEFAULT_SESSION_TITLE): string {
  const first = prompt
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  if (!first || first.startsWith("/") || LOW_INFORMATION.test(first)) return fallback;
  return normalizeSessionTitle(first.replace(LEADING_FILLER, ""), fallback);
}

export const SESSION_TITLE_PROMPT = `Write a short title for this session, describing the user's overall task.
Rules: 3 to 6 words, at most 48 characters, lowercase, plain text only.
No quotes, no markdown, no emoji, no trailing punctuation, no prefixes like "title:".
Be general about the whole task, not a single step. Respond with the title only.`;

export function titleFromModelText(text: string, fallback = DEFAULT_SESSION_TITLE): string {
  const stripped = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*title\s*[:\-]\s*/i, "");
  const first = stripped
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  return normalizeSessionTitle(first, fallback);
}

export function sessionDisplayName(session: Pick<Session, "title"> | undefined): string {
  if (isDefaultSessionTitle(session?.title)) return DEFAULT_SESSION_TITLE;
  return normalizeSessionTitle(session!.title!, DEFAULT_SESSION_TITLE);
}
