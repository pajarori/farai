import type { SessionEventType, ToolStatus, TurnStopReason } from "../types";

const EVAL_MAX_CASES = 200;
const EVAL_MAX_PROMPTS = 50;
const EVAL_MAX_EXPECTATIONS = 100;
const EVAL_MAX_STRING_BYTES = 128 * 1024;
const EVAL_MAX_ARGS_BYTES = 32 * 1024;
export const MAX_CASE_TIMEOUT_SECONDS = 600;

const PLANNERS = ["heuristic", "malformed-once", "unknown-tool-once", "stall"] as const;
const TURN_STOP_REASONS: TurnStopReason[] = ["final_response", "cancelled", "planner_error", "no_actions", "step_limit", "time_limit", "context_budget", "cost_budget"];
const TOOL_STATUSES: ToolStatus[] = ["pending", "running", "running_background", "done", "error"];
const EVENT_TYPES: SessionEventType[] = [
  "text", "provider_context", "provider_catalog", "reasoning_summary", "tool_call", "tool_result", "artifact", "finding", "error",
  "planner_attempt", "planner_error", "loop_stop", "compaction", "tool_started", "tool_progress", "mcp_startup_update", "mcp_startup_complete",
  "mcp_catalog_changed", "phase_change", "job_started", "job_progress", "job_completed", "job_failed", "job_cancelled", "job_lost",
  "mailbox_queued", "mailbox_consumed", "tool_input_start", "tool_input_delta", "tool_input_end", "loop_supervision", "control", "stream_text",
  "stream_reasoning"
];

export type EvalPlanner = typeof PLANNERS[number];

export type EvalToolExpectation = {
  tool: string;
  status?: ToolStatus;
  argsInclude?: Record<string, unknown>;
  atLeast?: number;
};

export type EvalExpectations = {
  responseIncludes?: string[];
  responseExcludes?: string[];
  events?: SessionEventType[];
  notesAtLeast?: number;
  turnsAtLeast?: number;
  stopReasons?: TurnStopReason[];
  plannerErrorsAtMost?: number;
  toolErrorsAtMost?: number;
  toolCalls?: EvalToolExpectation[];
  toolCallsAbsent?: string[];
  toolsInOrder?: string[];
};

export type EvalSuite = {
  schemaVersion: 1;
  title?: string;
  defaultTimeoutSeconds?: number;
  cases: EvalCase[];
};

export type EvalCase = {
  name: string;
  planner: EvalPlanner;
  prompts: string[];
  timeoutSeconds?: number;
  expect: EvalExpectations;
};

export function normalizeEvalSuite(value: unknown): EvalSuite {
  const suite = record(value, "eval suite");
  knownKeys(suite, ["schemaVersion", "title", "defaultTimeoutSeconds", "cases"], "eval suite");
  if (suite.schemaVersion !== 1) throw new Error("eval suite schemaVersion must be 1");
  const rawCases = array(suite.cases, "eval suite cases", 1, EVAL_MAX_CASES);
  const cases = rawCases.map((item, index) => normalizeCase(item, index));
  const names = new Set<string>();
  for (const item of cases) {
    if (names.has(item.name)) throw new Error(`duplicate eval case name: ${item.name}`);
    names.add(item.name);
  }
  return {
    schemaVersion: 1,
    ...optional("title", optionalString(suite.title, "eval suite title", 300)),
    ...optional("defaultTimeoutSeconds", optionalPositiveInteger(suite.defaultTimeoutSeconds, "defaultTimeoutSeconds", MAX_CASE_TIMEOUT_SECONDS)),
    cases
  };
}

export function stableEvalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableEvalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableEvalStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeCase(value: unknown, index: number): EvalCase {
  const label = `eval case ${index + 1}`;
  const item = record(value, label);
  knownKeys(item, ["name", "planner", "prompts", "timeoutSeconds", "expect"], label);
  const planner = item.planner === undefined ? "heuristic" : enumValue(item.planner, PLANNERS, `${label} planner`);
  const prompts = stringArray(item.prompts, `${label} prompts`, 1, EVAL_MAX_PROMPTS, EVAL_MAX_STRING_BYTES);
  return {
    name: stringValue(item.name, `${label} name`, 300),
    planner,
    prompts,
    ...optional("timeoutSeconds", optionalPositiveInteger(item.timeoutSeconds, `${label} timeoutSeconds`, MAX_CASE_TIMEOUT_SECONDS)),
    expect: normalizeExpectations(item.expect, label)
  };
}

function normalizeExpectations(value: unknown, caseLabel: string): EvalExpectations {
  const label = `${caseLabel} expect`;
  const expect = record(value, label);
  const keys = ["responseIncludes", "responseExcludes", "events", "notesAtLeast", "turnsAtLeast", "stopReasons", "plannerErrorsAtMost", "toolErrorsAtMost", "toolCalls", "toolCallsAbsent", "toolsInOrder"];
  knownKeys(expect, keys, label);
  if (!Object.keys(expect).length) throw new Error(`${label} must define at least one metric`);
  const toolCalls = expect.toolCalls === undefined
    ? undefined
    : array(expect.toolCalls, `${label}.toolCalls`, 1, EVAL_MAX_EXPECTATIONS).map((item, index) => normalizeToolExpectation(item, `${label}.toolCalls[${index}]`));
  return {
    ...optional("responseIncludes", optionalStringArray(expect.responseIncludes, `${label}.responseIncludes`)),
    ...optional("responseExcludes", optionalStringArray(expect.responseExcludes, `${label}.responseExcludes`)),
    ...optional("events", optionalEnumArray(expect.events, EVENT_TYPES, `${label}.events`)),
    ...optional("notesAtLeast", optionalNonNegativeInteger(expect.notesAtLeast, `${label}.notesAtLeast`)),
    ...optional("turnsAtLeast", optionalNonNegativeInteger(expect.turnsAtLeast, `${label}.turnsAtLeast`)),
    ...optional("stopReasons", optionalEnumArray(expect.stopReasons, TURN_STOP_REASONS, `${label}.stopReasons`)),
    ...optional("plannerErrorsAtMost", optionalNonNegativeInteger(expect.plannerErrorsAtMost, `${label}.plannerErrorsAtMost`)),
    ...optional("toolErrorsAtMost", optionalNonNegativeInteger(expect.toolErrorsAtMost, `${label}.toolErrorsAtMost`)),
    ...optional("toolCalls", toolCalls),
    ...optional("toolCallsAbsent", optionalStringArray(expect.toolCallsAbsent, `${label}.toolCallsAbsent`, 200)),
    ...optional("toolsInOrder", optionalStringArray(expect.toolsInOrder, `${label}.toolsInOrder`, 200))
  };
}

function normalizeToolExpectation(value: unknown, label: string): EvalToolExpectation {
  const item = record(value, label);
  knownKeys(item, ["tool", "status", "argsInclude", "atLeast"], label);
  const argsInclude = item.argsInclude === undefined ? undefined : jsonObject(item.argsInclude, `${label}.argsInclude`);
  if (argsInclude && Buffer.byteLength(stableEvalStringify(argsInclude), "utf8") > EVAL_MAX_ARGS_BYTES) throw new Error(`${label}.argsInclude is too large`);
  return {
    tool: stringValue(item.tool, `${label}.tool`, 200),
    ...optional("status", item.status === undefined ? undefined : enumValue(item.status, TOOL_STATUSES, `${label}.status`)),
    ...optional("argsInclude", argsInclude),
    ...optional("atLeast", optionalPositiveInteger(item.atLeast, `${label}.atLeast`, 10_000))
  };
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const normalized = jsonValue(value, label, seen, 0);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) throw new Error(`${label} must be a JSON object`);
  return normalized as Record<string, unknown>;
}

function jsonValue(value: unknown, label: string, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") throw new Error(`${label} must contain only JSON values`);
  if (depth >= 20) throw new Error(`${label} exceeds maximum nesting depth`);
  if (seen.has(value)) throw new Error(`${label} must not be cyclic`);
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`, seen, depth + 1));
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, jsonValue(item, `${label}.${key}`, seen, depth + 1)]));
  } finally {
    seen.delete(value);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${label} must contain ${minimum}-${maximum} items`);
  return value;
}

function stringArray(value: unknown, label: string, minimum: number, maximum: number, maxBytes = 4_096): string[] {
  return array(value, label, minimum, maximum).map((item, index) => stringValue(item, `${label}[${index}]`, maxBytes));
}

function optionalStringArray(value: unknown, label: string, maxBytes = 4_096): string[] | undefined {
  return value === undefined ? undefined : stringArray(value, label, 1, EVAL_MAX_EXPECTATIONS, maxBytes);
}

function optionalEnumArray<T extends string>(value: unknown, allowed: readonly T[], label: string): T[] | undefined {
  return value === undefined ? undefined : array(value, label, 1, EVAL_MAX_EXPECTATIONS).map((item, index) => enumValue(item, allowed, `${label}[${index}]`));
}

function stringValue(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${label} is too large`);
  return value;
}

function optionalString(value: unknown, label: string, maxBytes: number): string | undefined {
  return value === undefined ? undefined : stringValue(value, label, maxBytes);
}

function optionalPositiveInteger(value: unknown, label: string, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) throw new Error(`${label} must be a positive integer <= ${maximum}`);
  return Number(value);
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

function knownKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} contains unknown field: ${unknown}`);
}

function optional<Key extends string, Value>(key: Key, value: Value | undefined): { [Property in Key]?: Value } {
  return value === undefined ? {} : { [key]: value } as { [Property in Key]?: Value };
}
