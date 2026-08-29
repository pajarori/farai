import { decodeHTML } from "entities";

export async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`response is too large (${declared} bytes; limit ${maxBytes})`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel(`response exceeded ${maxBytes} bytes`).catch(() => {});
        throw new Error(`response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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
