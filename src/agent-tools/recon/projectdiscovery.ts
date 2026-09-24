import type { BackendExecResult } from "../backends/types";
import type { ToolContext, ToolResult } from "../../types";
import { sanitizeToolOutput } from "../shared/output-sanitize";

export type JsonRecord = Record<string, unknown>;

function coerceStringListInput(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
    }
  }
  return [value];
}

export function stringList(value: unknown, name: string, max = 500): string[] {
  const values = coerceStringListInput(value);
  const normalized = values.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
  if (!normalized.length) throw new Error(`${name} must contain at least one non-empty string`);
  if (normalized.length > max) throw new Error(`${name} cannot contain more than ${max} items`);
  if (normalized.some((item) => item.length > 4_096 || /[\r\n\0]/.test(item))) throw new Error(`${name} contains an invalid value`);
  return [...new Set(normalized)];
}

export function optionalStringList(value: unknown, name: string, max = 100): string[] {
  if (value === undefined) return [];
  return stringList(value, name, max);
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < items.length) {
      if (signal?.aborted) throw signal.reason ?? new Error("cancelled");
      const current = index;
      index += 1;
      results[current] = await mapper(items[current]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

export function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function inputFileCommand(binary: string, args: string[], input: string[], inputFlag: string): string {
  const values = input.map(shellQuote).join(" ");
  const command = [binary, ...args].map(shellQuote).join(" ");
  return [
    'input="$(mktemp /tmp/farai-tool-input.XXXXXX)" || exit 1',
    'trap \'rm -f "$input"\' EXIT',
    `printf '%s\\n' ${values} > "$input"`,
    `${command} ${shellQuote(inputFlag)} "$input"`
  ].join("\n");
}

export function parseJsonLines(raw: string): { records: JsonRecord[]; malformed: number } {
  const records: JsonRecord[] = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

export function parseJsonDocument(raw: string): { records: JsonRecord[]; malformed: number } {
  const trimmed = raw.trim();
  if (!trimmed) return { records: [], malformed: 0 };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return { records: parsed.filter(isRecord), malformed: 0 };
    if (!isRecord(parsed)) return { records: [], malformed: 1 };
    for (const key of ["results", "vulnerabilities", "data", "items", "matches"]) {
      const nested = parsed[key];
      if (Array.isArray(nested)) return { records: nested.filter(isRecord), malformed: 0 };
    }
    return { records: [parsed], malformed: 0 };
  } catch {
    return parseJsonLines(raw);
  }
}

export function projectDiscoveryResult<T extends JsonRecord>(
  context: ToolContext,
  options: {
    tool: string;
    backend: string;
    result: BackendExecResult;
    records: T[];
    malformed: number;
    outputLines: string[];
    noun: string;
    metadata?: Record<string, unknown>;
    resultCount?: number;
  }
): ToolResult {
  const resultCount = options.resultCount ?? options.records.length;
  const metadataRecords = options.records.slice(0, 200);
  const outputLines = options.outputLines.slice(0, 100);
  const omittedOutputLines = Math.max(0, options.outputLines.length - outputLines.length);
  const raw = [options.result.stdout, options.result.stderr.trim() ? `STDERR:\n${options.result.stderr}` : ""].filter(Boolean).join("\n");
  const artifact = raw.trim() ? context.store.saveOutputArtifact({
    sessionId: context.session.id,
    ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
    content: raw
  }) : undefined;
  const ok = resultCount > 0 || (options.result.exitCode === 0 && !options.result.timedOut);
  const partial = resultCount > 0 && (options.result.exitCode !== 0 || options.result.timedOut);
  const diagnostics = compactDiagnostics(options.result.stderr);
  const diagnosticWarning = diagnostics && (options.result.exitCode !== 0 || /\b(?:warn|error|fatal|failed|unauthoriz|timed?\s*out)\b/i.test(diagnostics)) ? diagnostics : "";
  const emptySuccess = resultCount === 0 && options.result.exitCode === 0 && !options.result.timedOut;
  const failureCategory = reconFailureCategory(options.result, resultCount, diagnostics);
  const emptyMessage = emptySuccess ? `${options.tool}: completed with no ${options.noun}s found` : `${options.tool}: no output`;
  let summary: string;
  if (!ok) summary = `${options.tool}: failed`;
  else if (emptySuccess) summary = `${options.tool}: completed, no ${options.noun}s found`;
  else summary = `${options.tool}: ${resultCount} ${options.noun}${resultCount === 1 ? "" : "s"}${partial ? " (partial)" : ""}`;
  const output = [
    ...outputLines,
    ...(omittedOutputLines ? [`… +${omittedOutputLines} more ${options.noun}${omittedOutputLines === 1 ? "" : "s"} in artifact`] : []),
    ...(options.malformed ? [`warning: ignored ${options.malformed} malformed JSON record${options.malformed === 1 ? "" : "s"}`] : []),
    ...(diagnosticWarning ? [diagnosticWarning] : []),
    ...(!options.outputLines.length && diagnostics && !diagnosticWarning ? [diagnostics] : []),
    ...(emptySuccess ? [emptyMessage] : []),
    ...(artifact ? [`full ${options.backend} output: artifact ${artifact.id}`] : [])
  ].filter(Boolean).join("\n") || emptyMessage;
  return {
    ok,
    summary,
    output,
    ...(artifact ? { outputArtifactId: artifact.id } : {}),
    metadata: {
      ...(options.metadata ?? {}),
      backend: options.backend,
      recordCount: options.records.length,
      resultCount,
      records: metadataRecords,
      recordsTruncated: options.records.length > metadataRecords.length,
      partial,
      failureCategory,
      malformedJsonLines: options.malformed,
      exitCode: options.result.exitCode,
      durationMs: options.result.durationMs,
      ...(artifact ? { outputArtifact: artifact } : {})
    }
  };
}

function reconFailureCategory(result: BackendExecResult, recordCount: number, diagnostics: string): "success" | "no_findings" | "deadline" | "unreachable" | "backend_failure" | "partial" {
  if (recordCount > 0) return result.exitCode === 0 && !result.timedOut ? "success" : "partial";
  if (result.timedOut || result.exitCode === 124 || /\b(?:deadline|timed?\s*out|timeout|killed)\b/i.test(diagnostics)) return "deadline";
  if (/\b(?:could not resolve|connection refused|connection reset|host unreachable|network is unreachable|no route to host|temporary failure in name resolution)\b/i.test(diagnostics)) return "unreachable";
  if (result.exitCode === 0) return "no_findings";
  return "backend_failure";
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function textArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
}

export function record(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compactDiagnostics(value: string): string {
  return sanitizeToolOutput(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join("\n");
}
