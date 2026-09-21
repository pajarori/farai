const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const SENSITIVE_NAME = "(?:access[_-]?token|api[_-]?key|auth(?:orization)?|bearer|client[_-]?secret|cookie|credential|id[_-]?token|pass(?:word|wd|phrase)?|private[_-]?key|proxy[_-]?authorization|refresh[_-]?token|secret|session(?:id)?|set[_-]?cookie|token|x[_-]?api[_-]?key)";
const HEADER_RE = new RegExp(`^(\\s*${SENSITIVE_NAME}\\s*:\\s*).*$`, "gim");
const QUERY_RE = new RegExp(`([?&]${SENSITIVE_NAME}=)[^&#\\s]*`, "gi");
const FORM_RE = new RegExp(`(^|[&;\\s])(${SENSITIVE_NAME}=)[^&;\\s]*`, "gim");
const JSON_STRING_RE = new RegExp(`("${SENSITIVE_NAME}"\\s*:\\s*")[^"]*(")`, "gi");
const JSON_SCALAR_RE = new RegExp(`("${SENSITIVE_NAME}"\\s*:\\s*)(?!")[^,}\\s]+`, "gi");
const AUTH_SCHEME_RE = /\b(bearer|basic)\s+[a-z0-9._~+\/-]+=*/gi;
const URL_CREDENTIAL_RE = /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

export function sanitizeToolOutput(value: string): string {
  if (!value) return value;
  const http = splitHttpResponse(value);
  if (http && isBinaryLike(http.body)) {
    return `${sanitizeText(http.head).trimEnd()}\n\n${binaryPreview(http.body, "binary body")}`;
  }
  if (isBinaryLike(value)) {
    return binaryPreview(value, "binary-like output");
  }
  return sanitizeText(value);
}

function binaryPreview(value: string, label: string): string {
  const bytes = Buffer.from(value, "utf8");
  const strings = printableStrings(bytes).slice(0, 24).map(redactSensitiveText);
  const hex = [...bytes.subarray(0, 192)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .reduce<string[]>((lines, byte, index) => {
      const line = Math.floor(index / 16);
      lines[line] = `${lines[line] ?? ""}${lines[line] ? " " : ""}${byte}`;
      return lines;
    }, []);
  return [
    `[${label}: ${bytes.byteLength} bytes; showing readable strings and a hex preview]`,
    ...(strings.length ? [strings.join("\n")] : []),
    ...(hex.length ? [hex.join("\n")] : [])
  ].join("\n");
}

function printableStrings(bytes: Buffer): string[] {
  const result: string[] = [];
  let current = "";
  const flush = () => {
    if (current.length >= 4) result.push(current);
    current = "";
  };
  for (const byte of bytes) {
    if (byte === 0x09 || byte === 0x20 || (byte >= 0x21 && byte <= 0x7e)) current += String.fromCharCode(byte);
    else if (byte === 0x0a || byte === 0x0d) flush();
    else flush();
  }
  flush();
  return result;
}

export function isBinaryLike(value: string): boolean {
  if (!value) return false;
  const sample = value.slice(0, 8192);
  if (sample.includes("\x00")) return true;
  const stripped = stripTerminalSequences(sample);
  const chars = Array.from(stripped);
  if (!chars.length) return false;
  const controls = stripped.match(CONTROL_RE)?.length ?? 0;
  return controls / chars.length > 0.1;
}

function sanitizeText(value: string): string {
  return redactSensitiveText(stripTerminalSequences(value).replace(CONTROL_RE, ""));
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(HEADER_RE, "$1[redacted]")
    .replace(QUERY_RE, "$1[redacted]")
    .replace(FORM_RE, "$1$2[redacted]")
    .replace(JSON_STRING_RE, "$1[redacted]$2")
    .replace(JSON_SCALAR_RE, "$1\"[redacted]\"")
    .replace(AUTH_SCHEME_RE, "$1 [redacted]")
    .replace(URL_CREDENTIAL_RE, "$1[redacted]@");
}

function stripTerminalSequences(value: string): string {
  let output = "";
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code !== 0x1b) {
      output += value[index];
      index += 1;
      continue;
    }

    const next = value.charCodeAt(index + 1);
    if (next === 0x5b) {
      index = consumeCsi(value, index + 2);
      continue;
    }
    if (next === 0x5d) {
      index = consumeStringEscape(value, index + 2, true);
      continue;
    }
    if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
      index = consumeStringEscape(value, index + 2, false);
      continue;
    }

    index += 1;
    while (index < value.length && value.charCodeAt(index) >= 0x20 && value.charCodeAt(index) <= 0x2f) index += 1;
    if (index < value.length) index += 1;
  }
  return output;
}

function consumeCsi(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index++);
    if (code >= 0x40 && code <= 0x7e) break;
  }
  return index;
}

function consumeStringEscape(value: string, start: number, bellTerminates: boolean): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (bellTerminates && code === 0x07) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
    index += 1;
  }
  return index;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function splitHttpResponse(value: string): { head: string; body: string } | undefined {
  const response = parseHttpResponseChain(value).origin;
  if (!response) return undefined;
  return {
    head: response.headers,
    body: response.body
  };
}
import { parseHttpResponseChain } from "./http-response";
