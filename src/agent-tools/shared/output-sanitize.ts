const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function sanitizeToolOutput(value: string): string {
  if (!value) return value;
  const http = splitHttpResponse(value);
  if (http && isBinaryLike(http.body)) {
    return `${sanitizeText(http.head).trimEnd()}\n\n[binary body suppressed: ${byteLength(http.body)} bytes]`;
  }
  if (isBinaryLike(value)) {
    return `[binary output suppressed: ${byteLength(value)} bytes]\nUse a file-oriented command such as file, unzip -l, strings, or hexdump -C to inspect it.`;
  }
  return sanitizeText(value);
}

export function isBinaryLike(value: string): boolean {
  if (!value) return false;
  const sample = value.slice(0, 8192);
  if (sample.includes("\x00")) return true;
  const stripped = sample.replace(ANSI_RE, "");
  const chars = Array.from(stripped);
  if (!chars.length) return false;
  const controls = stripped.match(CONTROL_RE)?.length ?? 0;
  const replacements = stripped.match(/\uFFFD/g)?.length ?? 0;
  return controls / chars.length > 0.02 || replacements >= 3 || replacements / chars.length > 0.01;
}

function sanitizeText(value: string): string {
  return value.replace(CONTROL_RE, "�");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function splitHttpResponse(value: string): { head: string; body: string } | undefined {
  if (!value.startsWith("HTTP/")) return undefined;
  const separator = value.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
  const index = value.indexOf(separator);
  if (index === -1) return undefined;
  return {
    head: value.slice(0, index),
    body: value.slice(index + separator.length)
  };
}
