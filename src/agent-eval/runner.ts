import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentRuntime } from "../agent-core/runtime";
import { atomicWriteFile } from "../agent-core/atomic-file";
import { isSensitiveMcpField } from "../agent-core/mcp-secret-fields";
import { HeuristicPlanner, type PlanOptions, type PlannerAction, type PlannerInput, type PlannerProvider } from "../agent-core/provider";
import { takeBytes } from "../agent-tools/shared/output-bound";
import { readBoundedFileText } from "../file-read";
import type { SessionEvent, SessionEventType, ToolStatus, TurnStopReason } from "../types";
import {
  MAX_CASE_TIMEOUT_SECONDS,
  normalizeEvalSuite,
  stableEvalStringify,
  type EvalCase,
  type EvalExpectations,
  type EvalPlanner,
  type EvalSuite,
  type EvalToolExpectation
} from "./schema";

export { normalizeEvalSuite } from "./schema";
export type { EvalCase, EvalExpectations, EvalPlanner, EvalSuite, EvalToolExpectation } from "./schema";

const EVAL_SUITE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_CASE_TIMEOUT_SECONDS = 30;
const TRACE_RESPONSE_MAX_BYTES = 128 * 1024;

export type EvalTrace = {
  responses: string[];
  eventCounts: Partial<Record<SessionEventType, number>>;
  stopReasons: Array<TurnStopReason | undefined>;
  notes: number;
  turns: number;
  toolCalls: Array<{ tool: string; status: ToolStatus; args: unknown }>;
};

export type EvalCaseResult = {
  name: string;
  ok: boolean;
  durationMs: number;
  failures: string[];
  error?: string;
  response?: string;
  workspace?: string;
  trace: EvalTrace;
};

export type EvalRunResult = {
  schemaVersion: 1;
  suite: string;
  suiteHash: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  ok: boolean;
  passed: number;
  failed: number;
  results: EvalCaseResult[];
};

export type EvalRunOptions = {
  keepWorkspaces?: boolean;
  workspacesRoot?: string;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
};

export async function loadEvalSuite(file?: string): Promise<EvalSuite> {
  if (!file) return defaultEvalSuite();
  return normalizeEvalSuite(JSON.parse(await readBoundedFileText(file, EVAL_SUITE_MAX_BYTES, "eval suite")));
}

export async function runEvalSuite(input: EvalSuite, options: EvalRunOptions = {}): Promise<EvalRunResult> {
  const suite = normalizeEvalSuite(input);
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > MAX_CASE_TIMEOUT_SECONDS * 1_000)) {
    throw new Error(`eval timeoutMs must be > 0 and <= ${MAX_CASE_TIMEOUT_SECONDS * 1_000}`);
  }
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const results: EvalCaseResult[] = [];
  for (let index = 0; index < suite.cases.length; index += 1) {
    const item = suite.cases[index]!;
    options.onProgress?.(`[${index + 1}/${suite.cases.length}] running ${item.name}`);
    const result = await runEvalCase(item, suite.defaultTimeoutSeconds ?? DEFAULT_CASE_TIMEOUT_SECONDS, options, index);
    results.push(result);
    options.onProgress?.(`[${index + 1}/${suite.cases.length}] ${result.ok ? "passed" : "failed"} ${item.name}${result.error ? `: ${result.error}` : ""}`);
  }
  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  return {
    schemaVersion: 1,
    suite: suite.title ?? "Farai harness eval",
    suiteHash: sha256(stableEvalStringify(suite)),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    ok: failed === 0,
    passed,
    failed,
    results
  };
}

export function writeEvalResult(result: EvalRunResult, path: string): void {
  atomicWriteFile(path, `${JSON.stringify(result, null, 2)}\n`, 0o600);
}

async function runEvalCase(item: EvalCase, defaultTimeoutSeconds: number, options: EvalRunOptions, index: number): Promise<EvalCaseResult> {
  const root = options.workspacesRoot ? resolve(options.workspacesRoot) : tmpdir();
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, `farai-eval-${index + 1}-`));
  const timeoutMs = options.timeoutMs ?? (item.timeoutSeconds ?? defaultTimeoutSeconds) * 1_000;
  const controller = new AbortController();
  const timeoutError = new Error(`eval case exceeded ${Math.ceil(timeoutMs)}ms timeout`);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const runtime = new AgentRuntime(dir, plannerFor(item.planner), {
    inheritConfig: false,
    enableKnowledge: false,
    enableSkills: false,
    enableHooks: false,
    enableMcp: false,
    enableProjectInstructions: false,
    enableSessionTitles: false,
    registerSessionCatalog: false
  });
  const started = Date.now();
  let trace = emptyTrace();
  let sessionId: string | undefined;
  const responses: string[] = [];
  let result: EvalCaseResult;
  try {
    const session = await runtime.createSession();
    sessionId = session.id;
    for (const prompt of item.prompts) {
      const result = await runtime.prompt(session, prompt, { signal: controller.signal });
      if (controller.signal.aborted) throw timeoutError;
      responses.push(result.response);
    }
    const observed = captureTrace(runtime, session.id, responses);
    const failures = evaluateExpectations(item.expect, observed);
    trace = redactTrace(observed);
    result = {
      name: item.name,
      ok: failures.length === 0,
      durationMs: Date.now() - started,
      failures,
      ...(failures.length ? { error: failures.join("; ") } : {}),
      ...optional("response", responses.at(-1)),
      ...(options.keepWorkspaces ? { workspace: dir } : {}),
      trace
    };
  } catch (error) {
    if (sessionId) trace = redactTrace(captureTrace(runtime, sessionId, responses));
    const message = controller.signal.aborted ? timeoutError.message : error instanceof Error ? error.message : String(error);
    result = {
      name: item.name,
      ok: false,
      durationMs: Date.now() - started,
      failures: [message],
      error: message,
      ...optional("response", trace.responses.at(-1)),
      ...(options.keepWorkspaces ? { workspace: dir } : {}),
      trace
    };
  } finally {
    clearTimeout(timer);
    const cleanupErrors: string[] = [];
    try { await runtime.shutdown(); } catch (error) { cleanupErrors.push(`runtime shutdown failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!options.keepWorkspaces) {
      try { await rm(dir, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(`workspace cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (cleanupErrors.length) {
      result!.ok = false;
      result!.failures.push(...cleanupErrors);
      result!.error = result!.failures.join("; ");
    }
  }
  return result!;
}

function captureTrace(runtime: AgentRuntime, sessionId: string, responses: string[]): EvalTrace {
  const events = runtime.store.listEvents(sessionId);
  const turns = runtime.store.listTurns(sessionId);
  const toolCalls = runtime.store.listToolCalls(sessionId, 10_000);
  return {
    responses: responses.map((response) => boundedResponse(response, TRACE_RESPONSE_MAX_BYTES)),
    eventCounts: countEvents(events),
    stopReasons: turns.map((turn) => turn.stopReason),
    notes: runtime.store.listNotes(sessionId).length,
    turns: turns.length,
    toolCalls: toolCalls.map((call) => ({ tool: call.tool, status: call.status, args: call.args }))
  };
}

function redactTrace(trace: EvalTrace): EvalTrace {
  return {
    ...trace,
    toolCalls: trace.toolCalls.map((call) => ({ ...call, args: redactTraceValue(call.args) }))
  };
}

function evaluateExpectations(expect: EvalExpectations, trace: EvalTrace): string[] {
  const failures: string[] = [];
  const response = trace.responses.at(-1) ?? "";
  for (const text of expect.responseIncludes ?? []) if (!response.includes(text)) failures.push(`response missing: ${text}`);
  for (const text of expect.responseExcludes ?? []) if (response.includes(text)) failures.push(`response unexpectedly includes: ${text}`);
  for (const type of expect.events ?? []) if (!trace.eventCounts[type]) failures.push(`event missing: ${type}`);
  if (expect.notesAtLeast !== undefined && trace.notes < expect.notesAtLeast) failures.push(`expected notes >= ${expect.notesAtLeast}, got ${trace.notes}`);
  if (expect.turnsAtLeast !== undefined && trace.turns < expect.turnsAtLeast) failures.push(`expected turns >= ${expect.turnsAtLeast}, got ${trace.turns}`);
  for (const reason of expect.stopReasons ?? []) if (!trace.stopReasons.includes(reason)) failures.push(`stop reason missing: ${reason}`);
  const plannerErrors = trace.eventCounts.planner_error ?? 0;
  if (expect.plannerErrorsAtMost !== undefined && plannerErrors > expect.plannerErrorsAtMost) failures.push(`expected planner errors <= ${expect.plannerErrorsAtMost}, got ${plannerErrors}`);
  const toolErrors = trace.toolCalls.filter((call) => call.status === "error").length;
  if (expect.toolErrorsAtMost !== undefined && toolErrors > expect.toolErrorsAtMost) failures.push(`expected tool errors <= ${expect.toolErrorsAtMost}, got ${toolErrors}`);
  for (const wanted of expect.toolCalls ?? []) {
    const count = trace.toolCalls.filter((call) => toolCallMatches(call, wanted)).length;
    const minimum = wanted.atLeast ?? 1;
    if (count < minimum) failures.push(`expected tool ${wanted.tool} matching criteria >= ${minimum}, got ${count}`);
  }
  for (const tool of expect.toolCallsAbsent ?? []) if (trace.toolCalls.some((call) => call.tool === tool)) failures.push(`unexpected tool call: ${tool}`);
  if (expect.toolsInOrder && !isSubsequence(expect.toolsInOrder, trace.toolCalls.map((call) => call.tool))) {
    failures.push(`tool order missing: ${expect.toolsInOrder.join(" -> ")}`);
  }
  return failures;
}

function toolCallMatches(call: EvalTrace["toolCalls"][number], wanted: EvalToolExpectation): boolean {
  if (call.tool !== wanted.tool) return false;
  if (wanted.status && call.status !== wanted.status) return false;
  return wanted.argsInclude === undefined || containsSubset(call.args, wanted.argsInclude);
}

function containsSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => containsSubset(actual[index], item));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) => containsSubset((actual as Record<string, unknown>)[key], value));
  }
  return Object.is(actual, expected);
}

function isSubsequence(expected: string[], actual: string[]): boolean {
  let index = 0;
  for (const tool of actual) if (tool === expected[index]) index += 1;
  return index === expected.length;
}

function countEvents(events: SessionEvent[]): Partial<Record<SessionEventType, number>> {
  const counts: Partial<Record<SessionEventType, number>> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))) as Partial<Record<SessionEventType, number>>;
}

function plannerFor(name: EvalPlanner): PlannerProvider {
  if (name === "malformed-once") return new MalformedOncePlanner();
  if (name === "unknown-tool-once") return new UnknownToolOncePlanner();
  if (name === "stall") return new StallingPlanner();
  return new HeuristicPlanner();
}

class MalformedOncePlanner implements PlannerProvider {
  name = "malformed-once";
  private calls = 0;

  async plan(_input: PlannerInput): Promise<PlannerAction[]> {
    this.calls += 1;
    if (this.calls === 1) return [{ kind: "respond", text: "" } as PlannerAction];
    return [{ kind: "respond", text: "Recovered from malformed planner output." }];
  }
}

class UnknownToolOncePlanner implements PlannerProvider {
  name = "unknown-tool-once";
  private calls = 0;

  async plan(_input: PlannerInput): Promise<PlannerAction[]> {
    this.calls += 1;
    if (this.calls === 1) return [{ kind: "tool", tool: "missing_tool", args: {}, rationale: "Exercise stale tool behavior." }];
    return [{ kind: "respond", text: "Recovered from unknown tool." }];
  }
}

class StallingPlanner implements PlannerProvider {
  name = "stall";

  async plan(_input: PlannerInput, options?: PlanOptions): Promise<PlannerAction[]> {
    return await new Promise<PlannerAction[]>((_resolve, reject) => {
      const signal = options?.signal;
      const abort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error("stalling planner cancelled"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

function defaultEvalSuite(): EvalSuite {
  return {
    schemaVersion: 1,
    title: "Farai Agent Loop Self-Test",
    defaultTimeoutSeconds: 30,
    cases: [
      {
        name: "note memory",
        planner: "heuristic",
        prompts: ["remember local target context"],
        expect: {
          notesAtLeast: 1,
          events: ["tool_call", "tool_result", "loop_stop"],
          stopReasons: ["final_response"],
          plannerErrorsAtMost: 0,
          toolErrorsAtMost: 0,
          toolCalls: [{ tool: "knowledge_manage", status: "done", argsInclude: { operation: "add", text: "remember local target context", tags: ["user"] } }]
        }
      },
      {
        name: "missing target guidance",
        planner: "heuristic",
        prompts: ["scan the target"],
        expect: { responseIncludes: ["Freestyle ready"], events: ["loop_stop"], turnsAtLeast: 1, plannerErrorsAtMost: 0, toolErrorsAtMost: 0 }
      },
      {
        name: "malformed planner repair",
        planner: "malformed-once",
        prompts: ["trigger malformed output"],
        expect: { responseIncludes: ["Recovered from malformed"], events: ["planner_error"], stopReasons: ["final_response"], toolErrorsAtMost: 0 }
      },
      {
        name: "unknown tool recovery",
        planner: "unknown-tool-once",
        prompts: ["trigger unknown tool"],
        expect: { responseIncludes: ["Recovered from unknown tool"], events: ["planner_error"], stopReasons: ["final_response"], toolCallsAbsent: ["missing_tool"] }
      }
    ]
  };
}

function emptyTrace(): EvalTrace {
  return { responses: [], eventCounts: {}, stopReasons: [], notes: 0, turns: 0, toolCalls: [] };
}

function redactTraceValue(value: unknown, key?: string, depth = 0): unknown {
  if (key && isSensitiveMcpField("env", key)) return "<redacted>";
  if (depth >= 8) return "<max-depth>";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactTraceValue(item, undefined, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 200).map(([name, item]) => [name, redactTraceValue(item, name, depth + 1)]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedResponse(value: string, maximum: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  const marker = "\n[response truncated]";
  return `${takeBytes(value, maximum - Buffer.byteLength(marker, "utf8"), "head")}${marker}`;
}

function optional<Key extends string, Value>(key: Key, value: Value | undefined): { [Property in Key]?: Value } {
  return value === undefined ? {} : { [key]: value } as { [Property in Key]?: Value };
}
