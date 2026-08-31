import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { EmailAttachmentSummary, EmailMessageDetail, EmailMessageSummary } from "./types";

const MAX_TEXT_CHARS = 40_000;
const MAX_RAW_CHARS = 120_000;
const MAX_URLS = 100;
const MAX_OTP_CANDIDATES = 20;

export async function parseEmailSource(id: string, source: Buffer, includeRaw = false): Promise<EmailMessageDetail> {
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextLinks: false });
  const text = boundedText(parsed.text || htmlFallback(parsed.html));
  const html = typeof parsed.html === "string" ? boundedText(parsed.html) : undefined;
  const raw = includeRaw ? boundedRaw(source.toString("utf8")) : undefined;
  const urls = extractUrls([text, html ?? ""].join("\n"));
  const otpCandidates = extractOtpCandidates([parsed.subject ?? "", text].join("\n"));
  return {
    id,
    from: addressText(parsed.from),
    to: addressList(parsed.to),
    subject: parsed.subject?.trim() || "(no subject)",
    seen: false,
    hasAttachments: parsed.attachments.length > 0,
    ...(source.byteLength ? { size: source.byteLength } : {}),
    ...(parsed.date ? { receivedAt: parsed.date.toISOString() } : {}),
    text,
    ...(html ? { html } : {}),
    urls,
    otpCandidates,
    attachments: parsed.attachments.map(attachmentSummary),
    ...(raw ? { raw } : {})
  };
}

export function mergeMessageState(detail: EmailMessageDetail, summary: Partial<EmailMessageSummary>): EmailMessageDetail {
  return {
    ...detail,
    ...summary,
    id: detail.id,
    text: detail.text,
    urls: detail.urls,
    otpCandidates: detail.otpCandidates,
    attachments: detail.attachments
  };
}

export function extractUrls(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s<>'"`\])}]+/gi) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[.,;:!?]+$/, "")))].slice(0, MAX_URLS);
}

export function extractOtpCandidates(value: string): string[] {
  const explicit = [...value.matchAll(/\b(?:otp|code|verification|verify|pin|passcode)\D{0,24}([a-z0-9-]{4,12})\b/gi)].map((match) => match[1]!);
  const numeric = [...value.matchAll(/\b\d{4,8}\b/g)].map((match) => match[0]);
  return [...new Set([...explicit, ...numeric])].slice(0, MAX_OTP_CANDIDATES);
}

function addressText(value: AddressObject | AddressObject[] | undefined): string {
  return addressList(value)[0] ?? "unknown sender";
}

function addressList(value: AddressObject | AddressObject[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap((item) => item.value.map((entry) => {
    const address = entry.address?.trim() ?? "";
    const name = entry.name?.trim() ?? "";
    return name && address ? `${name} <${address}>` : address || name;
  })).filter(Boolean);
}

function attachmentSummary(attachment: ParsedMail["attachments"][number]): EmailAttachmentSummary {
  return {
    filename: normalizeAttachmentName(attachment.filename),
    contentType: attachment.contentType || "application/octet-stream",
    size: Number.isFinite(attachment.size) ? attachment.size : attachment.content.byteLength
  };
}

export function normalizeAttachmentName(value: string | undefined): string {
  const name = (value ?? "attachment").replace(/[\\/\0\r\n]/g, "_").replace(/^\.+/, "").trim();
  return (name || "attachment").slice(0, 160);
}

function boundedText(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  return normalized.length > MAX_TEXT_CHARS
    ? `${normalized.slice(0, MAX_TEXT_CHARS)}\n\n[message body truncated; ${normalized.length - MAX_TEXT_CHARS} characters omitted]`
    : normalized;
}

function boundedRaw(value: string): string {
  return value.length > MAX_RAW_CHARS
    ? `${value.slice(0, MAX_RAW_CHARS)}\n\n[raw message truncated; ${value.length - MAX_RAW_CHARS} characters omitted]`
    : value;
}

function htmlFallback(value: ParsedMail["html"]): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

