import { decodeHTML } from "entities";
import { readBoundedResponseBytes, ResponseSizeLimitError } from "../../http-response";

export async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  try {
    return await readBoundedResponseBytes(response, maxBytes);
  } catch (error) {
    if (error instanceof ResponseSizeLimitError) throw new Error(`response exceeded ${maxBytes} bytes`);
    throw error;
  }
}

export function decodeBody(bytes: Uint8Array, charset = "utf-8"): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

export function cleanHtml(html: string): { title?: string; text: string } {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? collapse(decodeHTML(stripTags(titleMatch[1] ?? ""))) : undefined;
  const withoutNoise = html
    .replace(/<(script|style|noscript|svg|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|header|footer|nav|li|h[1-6]|tr)>/gi, "\n");
  return { ...(title ? { title } : {}), text: normalizeText(decodeHTML(stripTags(withoutNoise))) };
}

export function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

export function normalizeText(value: string): string {
  return value
    .replace(/\r/g, "")
    .split("\n")
    .map(collapse)
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function boundedLimit(value: unknown, fallback = 5, maximum = 20): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback;
}
