import type { ToolErrorCategory } from "../types";

const ANSI_SEQUENCE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ULID_RE = /\b[0-9a-hjkmnp-tv-z]{26}\b/gi;
const OPAQUE_ID_RE = /\b(?:art(?:ifact)?|call|flow|job|msg|proc(?:ess)?|run|ses(?:sion)?|tool)[_-][a-z0-9_-]{8,}\b/gi;
const ID_FIELD_RE = /\b(?:artifact|campaign|child session|flow|job|message|output|process|record|request|run|session|tool call)?\s*id\s*[:=]/i;
const HOST_PATH_FIELD_RE = /^(?:directory|file|filename|path|workspace)\s*[:=]/i;
const INTERNAL_REFERENCE_RE = /\b(?:artifact|process|job)\s+(?:available|stored|saved|output)?\s*[:=]?[a-z0-9_-]{6,}\b/i;
const BACKEND_LOG_RE = /^(?:\[[a-z]{2,8}\]|(?:debug|error|fatal|info|stderr|stdout|trace|warn(?:ing)?)\s*[:|]|traceback\b|caused by\b|at\s+\S+\s*\(|mcp process exited\b)/i;
const STACK_RE = /^(?:\s*at\s+|\s*file\s+".*",\s+line\s+\d+|\s*\^+$)/i;
const TRUST_MARKER_RE = /\[\[\/?UNTRUSTED:[^\]]+\]\]/gi;
const POSIX_HOST_PATH_RE = /\/(?:Users\/[^/\s]+|home\/[^/\s]+|private\/tmp|tmp|workspace)(?:\/[^\s"'`<>|]+)+/g;
const WINDOWS_HOST_PATH_RE = /\b[A-Za-z]:\\(?:Users\\[^\\\s]+|Temp|workspace)(?:\\[^\s"'`<>|]+)+/g;
const SAFE_JSON_KEYS = new Set([
  "action", "address", "browser", "canonical", "count", "domain", "host", "kind", "label", "method",
  "name", "operation", "package", "provider", "score", "severity", "state", "status", "summary", "target",
  "title", "total", "type", "url", "version"
]);

export function collapsedToolText(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const sanitized = stripAnsi(value).replace(TRUST_MARKER_RE, "").replace(/\s+/g, " ").trim();
  if (sanitized.includes(" · ")) {
    const fields = sanitized.split(" · ").flatMap((field) => collapsedSanitizedText(field) ?? []);
    return fields.length ? fields.join(" · ") : undefined;
  }
  return collapsedSanitizedText(sanitized);
}

function collapsedSanitizedText(sanitized: string): string | undefined {
  if (!sanitized || isJsonBlock(sanitized) || BACKEND_LOG_RE.test(sanitized) || STACK_RE.test(sanitized)) return undefined;
  if (ID_FIELD_RE.test(sanitized) || INTERNAL_REFERENCE_RE.test(sanitized) || HOST_PATH_FIELD_RE.test(sanitized)) return undefined;
  const compacted = sanitized
    .replace(POSIX_HOST_PATH_RE, "[local path]")
    .replace(WINDOWS_HOST_PATH_RE, "[local path]")
    .replace(/\b(?:processId|jobId|artifactId|outputArtifactId)=[^\s]+/gi, "")
    .replace(UUID_RE, "[id]")
    .replace(ULID_RE, "[id]")
    .replace(OPAQUE_ID_RE, "[id]")
    .replace(/\s+/g, " ")
    .trim();
  return compacted || undefined;
}

export function collapsedToolLines(values: readonly string[], limit = 5): string[] {
  const lines = values.flatMap((value) => collapsedToolText(value) ?? []).slice(0, limit);
  return Array.from(new Set(lines));
}

export function collapsedToolPreview(text: string, limit: number, tail = false): string[] {
  const json = semanticJsonPreview(text, limit);
  if (json.length) return json;
  const lines = collapsedToolLines(text.split("\n"), Number.MAX_SAFE_INTEGER);
  if (lines.length <= limit) return lines;
  if (tail) return [`… ${lines.length - limit} earlier lines`, ...lines.slice(-limit)];
  const head = Math.max(1, Math.floor(limit / 2));
  const tailCount = Math.max(1, limit - head - 1);
  return [...lines.slice(0, head), `… +${lines.length - head - tailCount} lines`, ...lines.slice(-tailCount)];
}

export function collapsedToolError(category: ToolErrorCategory | undefined): string {
  if (category === "cancelled") return "cancelled";
  if (category === "deadline") return "deadline exceeded";
  if (category === "invalid_input") return "invalid input";
  if (category === "not_found") return "not found";
  if (category === "permission_denied") return "permission denied";
  if (category === "authentication_failed") return "authentication failed";
  if (category === "precondition_failed") return "precondition failed";
  if (category === "conflict") return "conflict";
  if (category === "rate_limited") return "rate limited";
  if (category === "unreachable") return "target unreachable";
  if (category === "unavailable") return "service unavailable";
  return "operation failed";
}

function semanticJsonPreview(text: string, limit: number): string[] {
  const value = parseJson(text);
  if (value === undefined) return [];
  const lines: string[] = [];
  collectJsonLines(value, lines, limit);
  return collapsedToolLines(lines, limit);
}

function collectJsonLines(value: unknown, lines: string[], limit: number, prefix = ""): void {
  if (lines.length >= limit) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonLines(item, lines, limit, prefix);
      if (lines.length >= limit) return;
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (lines.length >= limit) return;
    const normalized = key.replace(/([a-z\d])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();
    if (!SAFE_JSON_KEYS.has(key) && !SAFE_JSON_KEYS.has(normalized)) continue;
    const label = prefix ? `${prefix} ${normalized}` : normalized;
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      lines.push(`${label}: ${String(item)}`);
      continue;
    }
    collectJsonLines(item, lines, limit, label);
  }
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!isJsonBlock(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function isJsonBlock(value: string): boolean {
  return (value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"));
}

function stripAnsi(value: string): string {
  const bun = (globalThis as typeof globalThis & { Bun?: { stripANSI?: (text: string) => string } }).Bun;
  if (typeof bun?.stripANSI === "function") {
    try {
      return bun.stripANSI(value);
    } catch {
    }
  }
  return value.replace(ANSI_SEQUENCE, "");
}
