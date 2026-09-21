import type { ToolErrorCategory, ToolResult } from "../types";

const CATEGORIES = new Set<ToolErrorCategory>([
  "cancelled",
  "deadline",
  "invalid_input",
  "not_found",
  "permission_denied",
  "authentication_failed",
  "precondition_failed",
  "conflict",
  "rate_limited",
  "unreachable",
  "unavailable",
  "backend_failure"
]);

const CATEGORY_ALIASES: Record<string, ToolErrorCategory | undefined> = {
  timeout: "deadline",
  timed_out: "deadline",
  unauthorized: "authentication_failed",
  unauthenticated: "authentication_failed",
  forbidden: "permission_denied",
  permission: "permission_denied",
  invalid_arguments: "invalid_input",
  validation: "invalid_input",
  missing: "not_found",
  network: "unreachable",
  transport: "unreachable",
  backend: "backend_failure",
  failure: "backend_failure",
  success: undefined,
  no_findings: undefined,
  partial: undefined
};

export function normalizeToolErrorCategory(value: unknown): ToolErrorCategory | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (CATEGORIES.has(normalized as ToolErrorCategory)) return normalized as ToolErrorCategory;
  return CATEGORY_ALIASES[normalized];
}

export function classifyToolError(input: {
  error?: unknown;
  result?: ToolResult;
  cancelled?: boolean;
  timedOut?: boolean;
}): ToolErrorCategory {
  if (input.cancelled || input.result?.metadata?.cancelled === true) return "cancelled";
  if (input.timedOut || input.result?.metadata?.timedOut === true) return "deadline";
  const explicit = normalizeToolErrorCategory(input.result?.errorCategory)
    ?? normalizeToolErrorCategory(input.result?.metadata?.errorCategory)
    ?? normalizeToolErrorCategory(input.result?.metadata?.failureCategory);
  if (explicit) return explicit;
  const code = errorCode(input.error) ?? errorCode(input.result?.metadata?.code);
  if (code) {
    if (["ABORT_ERR", "ERR_ABORTED"].includes(code)) return "cancelled";
    if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "ERR_TIMEOUT"].includes(code)) return "deadline";
    if (["ENOENT", "ENOTDIR"].includes(code)) return "not_found";
    if (["EACCES", "EPERM", "EROFS"].includes(code)) return "permission_denied";
    if (["EADDRINUSE", "EEXIST"].includes(code)) return "conflict";
    if (["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN"].includes(code)) return "unreachable";
  }
  const text = errorText(input);
  if (/\b(?:cancelled|canceled|aborted)\b/i.test(text)) return "cancelled";
  if (/\b(?:deadline|timed?\s*out|timeout)\b/i.test(text)) return "deadline";
  if (/\b(?:rate.?limit|too many requests|http\s*429)\b/i.test(text)) return "rate_limited";
  if (/\b(?:unauthenticated|unauthorized|authentication failed|invalid api key|invalid token|http\s*401)\b/i.test(text)) return "authentication_failed";
  if (/\b(?:permission denied|forbidden|access denied|operation not permitted|http\s*403)\b/i.test(text)) return "permission_denied";
  if (/\b(?:address already in use|already exists|conflict|http\s*409)\b/i.test(text)) return "conflict";
  if (/\b(?:not found|no such file|unknown record|unknown skill|http\s*404)\b/i.test(text)) return "not_found";
  if (/\b(?:invalid argument|invalid input|missing required|required field|must be one of|expected .+ received|validation failed)\b/i.test(text)) return "invalid_input";
  if (/\b(?:not a git repository|precondition|not initialized|must be configured|requires .+ first)\b/i.test(text)) return "precondition_failed";
  if (/\b(?:could not resolve|connection refused|connection reset|host unreachable|network is unreachable|no route to host|temporary failure in name resolution|transport error)\b/i.test(text)) return "unreachable";
  if (/\b(?:not available|unavailable|not supported|disabled|service is down|unknown or expired background session)\b/i.test(text)) return "unavailable";
  return "backend_failure";
}

export function normalizeFailedToolResult(result: ToolResult): ToolResult {
  if (result.ok || result.errorCategory) return result;
  return { ...result, errorCategory: classifyToolError({ result }) };
}

function errorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code.toUpperCase() : undefined;
}

function errorText(input: { error?: unknown; result?: ToolResult }): string {
  const error = input.error instanceof Error ? input.error.message : input.error === undefined ? "" : String(input.error);
  const result = input.result;
  const diagnostic = typeof result?.metadata?.diagnostic === "string" ? result.metadata.diagnostic : "";
  return [error, result?.summary, result?.output, diagnostic].filter(Boolean).join("\n");
}
