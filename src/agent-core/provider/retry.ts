export const MODEL_RETRY_MAX_ATTEMPTS = 5;

const MAX_RETRY_AFTER_MS = 30_000;
const MAX_BACKOFF_MS = 8_000;
const INITIAL_BACKOFF_MS = 1_000;
const JITTER_FACTOR = 0.25;
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);
const NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);
const RETRYABLE_MESSAGE_PATTERNS = [
  /\b(?:408|409|425|429|500|502|503|504|524)\b/i,
  /rate[-_\s]?limit|too many requests|resource exhausted|resource_exhausted/i,
  /overloaded|service[-_\s]?unavailable|internal[-_\s]?(?:server[-_\s]?)?error|provider[-_\s]?returned[-_\s]?error/i,
  /fetch failed|failed to fetch|network[-_\s]?error|upstream connect/i,
  /connection (?:error|refused|lost|reset|terminated|closed)|socket (?:connection was closed|hang up)|reset before headers/i,
  /getaddrinfo|dns lookup|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)|^timeout$/i,
  /stream (?:disconnected|ended unexpectedly)|premature close|terminated/i,
  /try (?:your request )?again|temporarily at capacity/i
];
const CONTEXT_OVERFLOW_PATTERNS = [
  /context[_\s-]?length[_\s-]?exceeded/i,
  /maximum context length/i,
  /context window/i,
  /context.*(?:length|limit).*exceed/i,
  /prompt.*too long/i,
  /too many tokens/i,
  /input.*too long/i
];

export type ModelRetryDecision = {
  retryable: boolean;
  reason: "http" | "network" | "timeout" | "none";
  status?: number;
};

export function classifyModelRetry(error: unknown): ModelRetryDecision {
  const chain = errorChain(error);
  const status = firstNumber(chain, ["status", "statusCode"]);
  const text = chain.map(errorText).filter(Boolean).join("\n");
  if (isAbortChain(chain, text) || CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) {
    return { retryable: false, reason: "none", ...(status !== undefined ? { status } : {}) };
  }
  if (status !== undefined) {
    if (RETRYABLE_STATUSES.has(status) || (status >= 500 && status <= 599)) return { retryable: true, reason: "http", status };
    if (status >= 400 && status <= 499) return { retryable: false, reason: "none", status };
  }
  const code = firstString(chain, ["code"]);
  if (code && NETWORK_CODES.has(code.toUpperCase())) {
    return { retryable: true, reason: code.toUpperCase().includes("TIMEOUT") ? "timeout" : "network", ...(status !== undefined ? { status } : {}) };
  }
  if (/(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)|^timeout$/i.test(text)) {
    return { retryable: true, reason: "timeout", ...(status !== undefined ? { status } : {}) };
  }
  if (RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { retryable: true, reason: "network", ...(status !== undefined ? { status } : {}) };
  }
  return { retryable: false, reason: "none", ...(status !== undefined ? { status } : {}) };
}

export function modelRetryDelayMs(error: unknown, failedAttempt: number, random = Math.random()): number {
  const retryAfterMs = firstNumber(errorChain(error), ["retryAfterMs"]);
  if (retryAfterMs !== undefined && retryAfterMs >= 0) return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  const base = Math.min(INITIAL_BACKOFF_MS * 2 ** Math.max(0, failedAttempt - 1), MAX_BACKOFF_MS);
  const boundedRandom = Math.min(1, Math.max(0, random));
  return Math.min(Math.ceil(base + base * JITTER_FACTOR * boundedRandom), MAX_BACKOFF_MS);
}

function errorChain(error: unknown): unknown[] {
  const queue = [error];
  const seen = new Set<unknown>();
  const values: unknown[] = [];
  while (queue.length > 0) {
    const value = queue.shift();
    if (value === undefined || value === null || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (record.cause !== undefined) queue.push(record.cause);
    if (Array.isArray(record.errors)) queue.push(...record.errors);
  }
  return values;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value ?? "");
  const record = value as Record<string, unknown>;
  return [record.name, record.message, record.code].filter((item): item is string => typeof item === "string").join(" ");
}

function firstNumber(values: unknown[], keys: string[]): number | undefined {
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    }
  }
  return undefined;
}

function firstString(values: unknown[], keys: string[]): string | undefined {
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate) return candidate;
    }
  }
  return undefined;
}

function isAbortChain(values: unknown[], text: string): boolean {
  const name = firstString(values, ["name"]);
  const code = firstString(values, ["code"]);
  if (name === "AbortError" || code === "ABORT_ERR") return true;
  return /^abort(?:ed)?$/i.test(text.trim()) || /\bcancelled by user\b/i.test(text);
}
