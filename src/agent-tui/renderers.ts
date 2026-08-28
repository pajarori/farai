import type {
  MessageWithParts,
  Note,
  Part,
  SessionEvent,
  ToolCallRecord,
  ToolInputPreview,
  TodoItem,
  Evidence
} from "../types";
import type { ToolResult } from "../types";
import { parseReasoning } from "./reasoning";
import { isInternalMetaReasoning, normalizeReasoningSummary } from "../agent-core/reasoning-summary";
import {
  explorationVerb,
  isWorkspaceExplorationTool,
  shortToolName,
  summarizeToolInput,
  TOOL_PAYLOAD_KEYS
} from "./tool-presentation";

export const MAX_PAYLOAD_BYTES = 200_000;
const HEAD_BUDGET = 4_096;
const TAIL_BUDGET = 1_024;
const TOOL_DETAIL_MAX_BYTES = 32 * 1024;

export function truncateLine(line: string, maxWidth: number): string {
  const safe = Math.max(maxWidth, 1);
  if (line.length <= safe) return line;
  return safe > 1 ? line.slice(0, safe - 1) + "…" : line.slice(0, safe);
}

export function truncatePayload(text: string, maxBytes = MAX_PAYLOAD_BYTES): string {
  if (text.length <= maxBytes) return text;
  const head = text.slice(0, HEAD_BUDGET);
  const tail = text.slice(text.length - TAIL_BUDGET);
  const dropped = text.length - HEAD_BUDGET - TAIL_BUDGET;
  return `${head}\n… [truncated ${dropped} bytes] …\n${tail}`;
}

export function formatPayload(payload: unknown, maxBytes = MAX_PAYLOAD_BYTES): string {
  let text: string;
  try {
    text = typeof payload === "string" ? payload : safeStringify(payload);
  } catch {
    text = String(payload);
  }
  return truncatePayload(text, maxBytes);
}

function previewArguments(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return safePartialArguments(raw);
  }
}

function safePartialArguments(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let index = skipWhitespace(raw, 0);
  if (raw[index] !== "{") return result;
  index += 1;
  for (;;) {
    index = skipWhitespace(raw, index);
    if (raw[index] === "}") return result;
    const keyToken = parseJsonString(raw, index);
    if (!keyToken) return result;
    index = skipWhitespace(raw, keyToken.end);
    if (raw[index] !== ":") return result;
    index = skipWhitespace(raw, index + 1);
    const value = parseCompletedJsonValue(raw, index);
    if (!value) return result;
    if (!TOOL_PAYLOAD_KEYS.has(keyToken.value) && isJsonScalar(value.value)) result[keyToken.value] = value.value;
    index = skipWhitespace(raw, value.end);
    if (raw[index] === ",") {
      index += 1;
      continue;
    }
    return result;
  }
}

function parseCompletedJsonValue(raw: string, index: number): { value: unknown; end: number } | undefined {
  if (raw[index] === '"') return parseJsonString(raw, index);
  const start = index;
  const first = raw[index];
  if (first === "{" || first === "[") {
    const end = completedContainerEnd(raw, index);
    if (end === undefined) return undefined;
    try {
      return { value: JSON.parse(raw.slice(start, end)), end };
    } catch {
      return undefined;
    }
  }
  while (index < raw.length && !/[\s,}\]]/.test(raw[index]!)) index += 1;
  if (index === raw.length) return undefined;
  try {
    return { value: JSON.parse(raw.slice(start, index)), end: index };
  } catch {
    return undefined;
  }
}

function parseJsonString(raw: string, index: number): { value: string; end: number } | undefined {
  if (raw[index] !== '"') return undefined;
  for (let cursor = index + 1; cursor < raw.length; cursor += 1) {
    if (raw[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (raw[cursor] !== '"') continue;
    try {
      return { value: JSON.parse(raw.slice(index, cursor + 1)) as string, end: cursor + 1 };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function completedContainerEnd(raw: string, index: number): number | undefined {
  const stack: string[] = [];
  let quoted = false;
  for (let cursor = index; cursor < raw.length; cursor += 1) {
    const char = raw[cursor]!;
    if (quoted) {
      if (char === "\\") cursor += 1;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return cursor + 1;
    }
  }
  return undefined;
}

function skipWhitespace(raw: string, index: number): number {
  while (index < raw.length && /\s/.test(raw[index]!)) index += 1;
  return index;
}

function isJsonScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function safeStringify(payload: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(payload, (_, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value as object)) return "[Circular]";
      seen.add(value as object);
    }
    return value;
  }, 2);
}

export type TimelineRow =
  | { kind: "user"; text: string; id: string }
  | { kind: "assistant"; text: string; streaming: boolean; id: string }
  | { kind: "thinking"; title: string; body: string; streaming: boolean; id: string }
  | { kind: "tool"; tool: string; args: unknown; argsSummary: string; status: string; liveOutput?: string; result?: string; fullResult?: string; processId?: string; jobId?: string; toolCallId: string | undefined; id: string; mcp?: McpToolRowData; toolResult?: ToolResult }
  | { kind: "exploration"; status: string; items: ExplorationItem[]; id: string }
  | { kind: "todo_list"; title: string; items: TodoListRowItem[]; id: string }
  | { kind: "plan"; title: string; explanation?: string; items: PlanItem[]; markdown?: string; streaming: boolean; id: string }
  | { kind: "mcp_inventory"; text: string; id: string }
  | { kind: "artifact"; title: string; detail: string; body?: string; id: string }
  | { kind: "finding"; title: string; severity: string; target: string; detail: string; body?: string; id: string }
  | { kind: "progress"; title: string; detail: string; status: "running" | "done" | "info"; id: string }
  | { kind: "phase"; phase: string; detail: string; id: string }
  | { kind: "loop_stop"; text: string; reason: string; id: string }
  | { kind: "compaction"; text: string; summary?: string; id: string }
  | { kind: "error"; title: string; text: string; body?: string; id: string }
  | { kind: "notice"; tone: "info" | "warning" | "success"; title: string; detail?: string; body?: string; id: string };

export type ExplorationItem = {
  tool: string;
  verb: "read" | "list" | "search";
  target: string;
  status: string;
  result?: string;
  fullResult?: string;
  toolCallId: string | undefined;
};

export type McpToolRowData = {
  server: string;
  tool: string;
  result: unknown;
  durationMs?: number;
};

export type PlanItem = {
  step: string;
  status: "completed" | "in_progress" | "pending";
};

export type TodoListRowItem = {
  id?: string;
  text: string;
  status: "completed" | "in_progress" | "pending" | "blocked";
  priority?: string;
};

const DEFAULT_WIDTH = 120;

export function projectMessagesToRows(
  messages: MessageWithParts[],
  width = DEFAULT_WIDTH,
  runningTurnId?: string,
  latestToolCalls: ToolCallRecord[] = [],
  toolInputPreviews: ToolInputPreview[] = [],
  options: { fullToolResults?: boolean } = {}
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const latestToolRecords = new Map(latestToolCalls.map((record) => [record.id, record]));
  const persistedProviderToolCalls = new Set(
    latestToolCalls.flatMap((record) => record.providerToolCallId && record.turnId
      ? [providerToolCallKey(record.turnId, record.providerToolCallId)]
      : [])
  );
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool_call") continue;
      const providerToolCallId = ((part.payload as { record?: ToolCallRecord })?.record)?.providerToolCallId;
      if (providerToolCallId) persistedProviderToolCalls.add(providerToolCallKey(message.turnId, providerToolCallId));
    }
  }
  const toolRows = new Map<string, Extract<TimelineRow, { kind: "tool" }>>();
  const reasoningRows = new Map<string, Extract<TimelineRow, { kind: "thinking" }>>();
  const assistantTextsByTurn = new Map<string, Set<string>>();
  for (const message of messages) {
    const start = rows.length;
    const assistantTexts = assistantTextsByTurn.get(message.turnId) ?? new Set<string>();
    assistantTextsByTurn.set(message.turnId, assistantTexts);
    const suppressCompactionLeak = message.role === "assistant" && message.parts.some((part) => (
      part.type === "text" && looksLikeInternalCompactionLeak(safeText(part.payload, width * 20))
    ));
    for (const part of message.parts) {
      if (suppressCompactionLeak && (part.type === "text" || part.type === "reasoning_summary")) continue;
      const row = partToRow(message, part, width, runningTurnId === message.turnId, toolRows, latestToolRecords, reasoningRows, Boolean(options.fullToolResults));
      if (!row) continue;
      if (row.kind === "assistant" && message.role === "assistant") {
        const text = row.text.trim();
        if (text && assistantTexts.has(text)) continue;
        if (text) assistantTexts.add(text);
      }
      rows.push(row);
    }
    hoistLateThinking(rows, start);
    stopStaleStreaming(rows.slice(start), message, reasoningRows.get(`${message.id}:reasoning`));
  }
  for (const preview of toolInputPreviews) {
    if (preview.turnId !== runningTurnId) continue;
    if (preview.providerToolCallId && persistedProviderToolCalls.has(providerToolCallKey(preview.turnId, preview.providerToolCallId))) continue;
    const tool = preview.tool || "tool";
    const args = previewArguments(preview.rawArguments);
    rows.push({
      kind: "tool",
      tool,
      args,
      argsSummary: summarizeToolArgs(tool, args, 80),
      status: "pending",
      toolCallId: preview.providerToolCallId,
      id: preview.providerToolCallId ? toolTimelineRowId(preview.turnId, preview.providerToolCallId) : preview.id
    });
  }
  return groupExplorationRows(rows);
}

function hoistLateThinking(rows: TimelineRow[], start: number): void {
  const messageRows = rows.slice(start);
  const firstAssistant = messageRows.findIndex((row) => row.kind === "assistant");
  if (firstAssistant < 0) return;
  const lateThinking = messageRows.filter((row, index) => row.kind === "thinking" && index > firstAssistant);
  if (lateThinking.length === 0) return;
  const lateIds = new Set(lateThinking.map((row) => row.id));
  const remaining = messageRows.filter((row) => !lateIds.has(row.id));
  const insertAt = remaining.findIndex((row) => row.kind === "assistant");
  rows.splice(start, messageRows.length, ...remaining.slice(0, insertAt), ...lateThinking, ...remaining.slice(insertAt));
}

function looksLikeInternalCompactionLeak(text: string): boolean {
  return /^\s*<analysis>[\s\S]*?(?:<\/analysis>\s*)?<summary>/i.test(text);
}

function stopStaleStreaming(messageRows: TimelineRow[], message: MessageWithParts, reasoning: Extract<TimelineRow, { kind: "thinking" }> | undefined): void {
  const lastMeaningful = [...message.parts].reverse().find((part) => part.type !== "planner_attempt");
  if (!lastMeaningful) return;
  const lastText = lastMeaningful.type === "text" ? safeText(lastMeaningful.payload, 100_000).trim() : undefined;
  if (reasoning && lastMeaningful.type !== "reasoning_summary") reasoning.streaming = false;
  for (const row of messageRows) {
    if (row.kind === "thinking") continue;
    if (row.kind === "assistant" && lastText && row.text.trim() === lastText) continue;
    if ("streaming" in row && row.streaming && row.id !== lastMeaningful.id) {
      (row as { streaming: boolean }).streaming = false;
    }
  }
}

function partToRow(
  message: MessageWithParts,
  part: Part,
  width: number,
  streaming: boolean,
  toolRows: Map<string, Extract<TimelineRow, { kind: "tool" }>>,
  latestToolRecords: Map<string, ToolCallRecord>,
  reasoningRows: Map<string, Extract<TimelineRow, { kind: "thinking" }>>,
  includeFullToolResults: boolean
): TimelineRow | null {
  switch (part.type) {
    case "text": {
      if (message.role === "user") {
        return { kind: "user", text: stripOuterBlankLines(safeText(part.payload, width * 20)), id: part.id };
      }
      if (message.role === "assistant" || message.role === "system") {
        const text = safeText(part.payload, width * 20);
        if (message.role === "assistant" && isInternalMetaReasoning(text)) return null;
        return { kind: "assistant", text, streaming, id: part.id };
      }
      return null;
    }
    case "reasoning_summary": {
      const raw = extractField(part.payload, "rationale") ?? extractField(part.payload, "text") ?? safeText(part.payload, width * 4);
      const normalized = normalizeReasoningSummary(raw);
      if (!normalized) return null;
      const { title, body } = parseReasoning(normalized);
      const key = `${message.id}:reasoning`;
      const existing = reasoningRows.get(key);
      if (existing) {
        if (title !== "reasoning" && title !== existing.title) {
          if (!body && existing.title !== "reasoning") existing.body = appendReasoning(existing.body, existing.title);
          existing.title = title;
        }
        if (body) existing.body = appendReasoning(existing.body, body);
        existing.streaming = existing.streaming || streaming;
        return null;
      }
      const row: Extract<TimelineRow, { kind: "thinking" }> = {
        kind: "thinking",
        title,
        body,
        streaming,
        id: part.id
      };
      reasoningRows.set(key, row);
      return row;
    }
    case "tool_call": {
      const record = (part.payload as { record?: ToolCallRecord })?.record;
      const toolCallId = extractField(part.payload, "toolCallId") ?? record?.id;
      const latest = toolCallId ? latestToolRecords.get(toolCallId) : undefined;
      const tool = latest?.tool ?? extractField(part.payload, "tool") ?? record?.tool ?? "tool";
      const args = latest?.args ?? record?.args ?? (part.payload as { args?: unknown })?.args;
      const status = latest?.status ?? extractField(part.payload, "status") ?? record?.status ?? "pending";
      const liveOutput = latest?.liveOutput ?? record?.liveOutput;
      const processId = latest?.processId ?? record?.processId;
      const jobId = latest?.jobId ?? record?.jobId;
      const providerToolCallId = latest?.providerToolCallId ?? record?.providerToolCallId;
      const row: Extract<TimelineRow, { kind: "tool" }> = {
        kind: "tool",
        tool,
        args,
        argsSummary: summarizeToolArgs(tool, args, 80),
        status,
        ...(status === "running" && liveOutput ? { liveOutput } : {}),
        ...(processId ? { processId } : {}),
        ...(jobId ? { jobId } : {}),
        toolCallId,
        id: providerToolCallId ? toolTimelineRowId(message.turnId, providerToolCallId) : part.id
      };
      if (toolCallId) toolRows.set(toolCallId, row);
      return row;
    }
    case "tool_result": {
      const result = extractField(part.payload, "result");
      const humanResult = extractField(part.payload, "humanResult");
      const toolResult = field(part.payload, "toolResult") as ToolResult | undefined;
      const text = result ?? safeText(part.payload, width * 4);
      const toolCallId = extractField(part.payload, "toolCallId");
      const linked = toolCallId ? toolRows.get(toolCallId) : undefined;
      const display = displayToolResult(linked?.tool ?? extractField(part.payload, "tool") ?? "tool", text, toolResult, humanResult);
      const full = fullToolResult(text, toolResult);
      const fullResult = includeFullToolResults || (humanResult !== undefined && humanResult !== full)
        ? truncatePayload(full, includeFullToolResults ? MAX_PAYLOAD_BYTES : TOOL_DETAIL_MAX_BYTES)
        : undefined;
      if (linked) {
        linked.result = truncatePayload(display, width * 4);
        if (toolResult) linked.toolResult = toolResult;
        if (fullResult !== undefined) linked.fullResult = fullResult;
        const mcp = mcpToolRowData(toolResult);
        if (mcp) linked.mcp = mcp;
        if (toolResult?.processId) linked.processId = toolResult.processId;
        if (linked.status === "pending" || linked.status === "running") linked.status = "done";
        return null;
      }
      const mcp = mcpToolRowData(toolResult);
      return {
        kind: "tool",
        tool: extractField(part.payload, "tool") ?? "tool",
        args: undefined,
        argsSummary: "",
        status: "done",
        result: truncatePayload(display, width * 4),
        ...(fullResult !== undefined ? { fullResult } : {}),
        ...(mcp ? { mcp } : {}),
        ...(toolResult?.processId ? { processId: toolResult.processId } : {}),
        ...(toolResult ? { toolResult } : {}),
        toolCallId,
        id: part.id
      };
    }
    case "planner_attempt":
    case "provider_context":
    case "provider_catalog":
      return null;
    case "tool_started":
      return null;
    case "tool_progress":
      return {
        kind: "progress",
        title: "tool progress",
        detail: toolProgressDetail(part.payload, width),
        status: "info",
        id: part.id
      };
    case "phase_change":
      return {
        kind: "phase",
        phase: extractField(part.payload, "phase") ?? extractField(part.payload, "next") ?? "phase",
        detail: safeText(part.payload, width * 2),
        id: part.id
      };
    case "artifact":
      if (looksLikePlanPayload(part.payload)) return planRow(part, width, streaming);
      if (extractField(part.payload, "kind") === "mcp_inventory") return mcpInventoryRow(part, width);
      return artifactRow(part, width);
    case "finding":
      return findingRow(part, width);
    case "loop_stop":
      return {
        kind: "loop_stop",
        text: extractField(part.payload, "errorSummary") ?? extractField(part.payload, "reason") ?? safeText(part.payload, width * 2),
        reason: extractField(part.payload, "reason") ?? extractField(part.payload, "status") ?? "final_response",
        id: part.id
      };
    case "compaction":
      return { kind: "compaction", text: safeText(part.payload, width * 2), id: part.id };
    case "error":
      return errorRow(part, width);
    case "planner_error":
      return (part.payload as { retrying?: unknown } | undefined)?.retrying === true ? null : errorRow(part, width);
    default:
      {
        const presentation = semanticPayloadPresentation(part.payload, width);
      return {
        kind: "notice",
        tone: "info",
        title: part.type,
        ...(presentation.detail ? { detail: presentation.detail } : {}),
        ...(presentation.body ? { body: presentation.body } : {}),
        id: part.id
      };
      }
  }
}

function semanticPayloadPresentation(payload: unknown, width: number): { detail?: string; body?: string } {
  if (typeof payload === "string") {
    const body = payload.trim();
    if (!body) return {};
    return {
      detail: truncateLine(singleLine(body), width),
      ...(body !== singleLine(body) ? { body } : {})
    };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload === undefined || payload === null ? {} : { detail: truncateLine(String(payload), width) };
  }
  const record = payload as Record<string, unknown>;
  const preferred = ["message", "summary", "text", "error", "status", "title", "path", "tool", "phase"];
  const values = preferred.flatMap((key) => {
    const value = record[key];
    return typeof value === "string" && value.trim() ? [{ key, value: value.trim() }] : [];
  });
  if (values.length === 0) return { detail: "event received" };
  const detail = truncateLine(values.map(({ key, value }) => `${key}: ${singleLine(value)}`).join(" · "), width);
  const bodyParts = values.filter(({ value }) => value !== singleLine(value)).map(({ key, value }) => `## ${key}\n${value}`);
  return { detail, ...(bodyParts.length > 0 ? { body: bodyParts.join("\n\n") } : {}) };
}

function errorRow(part: Part, width: number): Extract<TimelineRow, { kind: "error" }> {
  const tool = extractField(part.payload, "tool");
  const planner = extractField(part.payload, "planner");
  const title = tool
    ? `${humanLabel(tool)} failed`
    : planner
      ? `${humanLabel(planner)} failed`
      : part.type === "planner_error"
        ? "planning failed"
        : "request failed";
  const raw = extractField(part.payload, "error")
    ?? extractField(part.payload, "message")
    ?? extractField(part.payload, "text")
    ?? extractField(part.payload, "errorSummary")
    ?? (typeof part.payload === "string" ? part.payload : "unexpected error");
  return {
    kind: "error",
    title: truncateLine(title, Math.max(1, width - 2)),
    text: truncateLine(singleLine(raw), Math.max(1, width - 4)),
    ...(raw.trim() !== singleLine(raw) || raw.length > Math.max(1, width - 4) ? { body: raw.trim() } : {}),
    id: part.id
  };
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim() || "unexpected error";
}

function humanLabel(value: string): string {
  const normalized = value.replace(/[._-]+/g, " ").trim();
  return normalized || "request";
}

function toolTimelineRowId(turnId: string, providerToolCallId: string): string {
  return `tool:${turnId}:${providerToolCallId}`;
}

function providerToolCallKey(turnId: string, providerToolCallId: string): string {
  return `${turnId}\u0000${providerToolCallId}`;
}

function groupExplorationRows(rows: TimelineRow[]): TimelineRow[] {
  const grouped: TimelineRow[] = [];
  let pending: Extract<TimelineRow, { kind: "tool" }>[] = [];
  let activeTodoRow: Extract<TimelineRow, { kind: "todo_list" }> | undefined;
  const flush = () => {
    if (pending.length === 0) return;
    if (pending.length === 1) grouped.push(pending[0]!);
    else grouped.push(toExplorationRow(pending));
    pending = [];
  };
  for (const row of rows) {
    if (row.kind === "user") activeTodoRow = undefined;
    if (row.kind === "tool" && isTodoTool(row.tool)) {
      flush();
      activeTodoRow = appendTodoRow(grouped, row, activeTodoRow);
      continue;
    }
    if (row.kind === "tool" && isExplorationTool(row.tool)) {
      pending.push(row);
      continue;
    }
    flush();
    grouped.push(row);
  }
  flush();
  return grouped;
}

function appendTodoRow(
  rows: TimelineRow[],
  row: Extract<TimelineRow, { kind: "tool" }>,
  current: Extract<TimelineRow, { kind: "todo_list" }> | undefined
): Extract<TimelineRow, { kind: "todo_list" }> | undefined {
  const items = todoItemsFromToolRow(row);
  if (items.length === 0) {
    rows.push(row);
    return current;
  }
  if (current) {
    for (const item of items) upsertTodoItem(current.items, item);
    return current;
  }
  const next: Extract<TimelineRow, { kind: "todo_list" }> = {
    kind: "todo_list",
    title: "updated plan",
    items,
    id: row.id
  };
  rows.push(next);
  return next;
}

function upsertTodoItem(items: TodoListRowItem[], next: TodoListRowItem): void {
  const index = next.id ? items.findIndex((item) => item.id === next.id) : -1;
  if (index >= 0) items[index] = { ...items[index], ...next };
  else items.push(next);
}

function toExplorationRow(rows: Array<Extract<TimelineRow, { kind: "tool" }>>): Extract<TimelineRow, { kind: "exploration" }> {
  return {
    kind: "exploration",
    status: explorationStatus(rows),
    id: rows.map((row) => row.id).join(":"),
    items: rows.map((row) => ({
      tool: row.tool,
      verb: explorationVerb(row.tool),
      target: summarizeToolArgs(row.tool, row.args, 120) || shortToolName(row.tool),
      status: row.status,
      ...(row.result ? { result: firstResultLine(row.result, 120) } : {}),
      ...(row.fullResult || row.result ? { fullResult: row.fullResult ?? row.result } : {}),
      toolCallId: row.toolCallId
    }))
  };
}

function explorationStatus(rows: Array<Extract<TimelineRow, { kind: "tool" }>>): "running" | "failed" | "done" {
  if (rows.some((row) => row.status === "running" || row.status === "pending")) return "running";
  if (rows.some((row) => row.status === "failed" || row.status === "error")) return "failed";
  return "done";
}

function isExplorationTool(tool: string): boolean {
  return isWorkspaceExplorationTool(tool);
}

function isTodoTool(tool: string): boolean {
  return tool === "todo_add" || tool === "todo_update" || tool === "todo_list";
}

function displayToolResult(tool: string, fallback: string, result: ToolResult | undefined, humanResult?: string): string {
  if (isTodoTool(tool)) return result?.output ?? result?.summary ?? firstResultLine(stripUntrustedMarkers(fallback), 120);
  if (result?.status === "running_background") {
    return [
      result.summary,
      result.output && result.output !== "(no output yet)" ? result.output : "(running; poll with session_poll or stop with session_stop)"
    ].filter(Boolean).join("\n");
  }
  if (humanResult !== undefined) return humanResult;
  if (result) return result.output ?? result.summary ?? stripUntrustedMarkers(fallback);
  return stripUntrustedMarkers(fallback);
}

function fullToolResult(fallback: string, result: ToolResult | undefined): string {
  if (result) return result.output ?? result.summary ?? stripUntrustedMarkers(fallback);
  return stripUntrustedMarkers(fallback);
}

function stripUntrustedMarkers(text: string): string {
  return text
    .replace(/^\[\[\/?UNTRUSTED:[a-z0-9_-]+\]\]\s*$\n?/gim, "")
    .replace(/^output \(untrusted tool output[^)]*\):\s*$\n?/gim, "");
}

function mcpToolRowData(result: ToolResult | undefined): McpToolRowData | undefined {
  const metadata = result?.metadata?.mcp;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const obj = metadata as Record<string, unknown>;
  if (obj.kind !== "mcp_tool_call") return undefined;
  if (typeof obj.server !== "string" || typeof obj.tool !== "string") return undefined;
  return {
    server: obj.server,
    tool: obj.tool,
    result: obj.result,
    ...(typeof obj.durationMs === "number" ? { durationMs: obj.durationMs } : {})
  };
}

function todoItemsFromToolRow(row: Extract<TimelineRow, { kind: "tool" }>): TodoListRowItem[] {
  const parsed = parseTodoPayload(row.result);
  if (parsed.length > 0) return parsed;
  const input = row.args && typeof row.args === "object" && !Array.isArray(row.args) ? row.args as Record<string, unknown> : {};
  if (typeof input.text === "string") {
    return [{
      text: input.text,
      status: normalizeTodoStatus(todoStatusInput(input.status, row.tool)),
      ...(typeof input.priority === "string" ? { priority: input.priority } : {}),
      ...(typeof input.id === "string" ? { id: input.id } : {})
    }];
  }
  if (typeof input.id === "string") {
    return [{ id: input.id, text: input.id, status: normalizeTodoStatus(typeof input.status === "string" ? input.status : "in_progress") }];
  }
  return [];
}

function todoStatusInput(status: unknown, tool: string): string {
  if (typeof status === "string") return status;
  return tool === "todo_update" ? "in_progress" : "pending";
}

function parseTodoPayload(value: string | undefined): TodoListRowItem[] {
  if (!value) return [];
  const json = extractJson(value);
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.map(todoItemFromUnknown).filter((item): item is TodoListRowItem => Boolean(item));
  } catch {
    return [];
  }
}

function extractJson(value: string): string | undefined {
  const outputIndex = value.lastIndexOf("\noutput:");
  const source = outputIndex >= 0 ? value.slice(outputIndex + "\noutput:".length).trim() : value.trim();
  const objectIndex = source.search(/[\[{]/);
  if (objectIndex < 0) return undefined;
  return source.slice(objectIndex).trim();
}

function todoItemFromUnknown(value: unknown): TodoListRowItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.text !== "string") return undefined;
  return {
    text: obj.text,
    status: normalizeTodoStatus(typeof obj.status === "string" ? obj.status : "pending"),
    ...(typeof obj.priority === "string" ? { priority: obj.priority } : {}),
    ...(typeof obj.id === "string" ? { id: obj.id } : {})
  };
}

function normalizeTodoStatus(value: string): TodoListRowItem["status"] {
  if (value === "done" || value === "completed" || value === "cancelled") return "completed";
  if (value === "in_progress" || value === "running" || value === "active") return "in_progress";
  if (value === "blocked") return "blocked";
  return "pending";
}

function firstResultLine(value: string, width: number): string {
  return truncateLine(value.split("\n").find((line) => line.trim()) ?? "(no output)", width);
}

function stripOuterBlankLines(value: string): string {
  return value.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");
}

function safeText(payload: unknown, maxBytes: number): string {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return truncatePayload(payload, maxBytes);
  if (typeof payload === "object" && "text" in (payload as Record<string, unknown>)) {
    const text = (payload as Record<string, unknown>).text;
    if (typeof text === "string") return truncatePayload(text, maxBytes);
  }
  try {
    return truncatePayload(safeStringify(payload), maxBytes);
  } catch {
    return truncatePayload(String(payload), maxBytes);
  }
}

function extractField(payload: unknown, field: string): string | undefined {
  if (payload && typeof payload === "object" && field in (payload as Record<string, unknown>)) {
    const value = (payload as Record<string, unknown>)[field];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function extractObject(payload: unknown, fieldName: string): Record<string, unknown> | undefined {
  const value = field(payload, fieldName);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function field(payload: unknown, fieldName: string): unknown {
  if (!payload || typeof payload !== "object") return undefined;
  return (payload as Record<string, unknown>)[fieldName];
}

function stringField(payload: unknown, fieldName: string): string | undefined {
  const value = field(payload, fieldName);
  return typeof value === "string" ? value : undefined;
}

function appendReasoning(existing: string, next: string): string {
  const value = next.trim();
  if (!value) return existing;
  if (!existing.trim()) return value;
  if (existing.includes(value)) return existing;
  return `${existing.trimEnd()}\n\n${value}`;
}

function toolProgressDetail(payload: unknown, width: number): string {
  const path = extractField(payload, "path");
  const bytes = field(payload, "bytes");
  return truncateLine([
    path ? `saved ${path}` : "output saved",
    typeof bytes === "number" ? `${bytes} bytes` : undefined
  ].filter(Boolean).join(" · "), width);
}

function artifactRow(part: Part, width: number): Extract<TimelineRow, { kind: "artifact" }> {
  const payload = part.payload;
  const kind = extractField(payload, "kind") ?? "artifact";
  if (kind === "background_job_completion") {
    const status = extractField(payload, "status") ?? "completed";
    if (extractField(payload, "mailboxKind") === "agent_completion") {
      const name = extractField(payload, "title") ?? "subagent";
      const summary = extractField(payload, "summary") ?? "background work completed.";
      return {
        kind: "artifact",
        title: status === "succeeded" ? `${name} completed` : `${name} ${status}`,
        detail: truncateLine(singleLine(summary), width),
        body: summary.trim(),
        id: part.id
      };
    }
    const summary = extractField(payload, "summary") ?? "background job completed.";
    return {
      kind: "artifact",
      title: status === "succeeded" ? "background job completed" : `background job ${status}`,
      detail: truncateLine(singleLine(summary), width),
      body: summary.trim(),
      id: part.id
    };
  }
  const note = extractObject(payload, "note");
  const artifact = extractObject(payload, "artifact") ?? extractObject(payload, "outputArtifact");
  const title = artifactTitle(kind, note, artifact);
  const detail = firstSemanticLine(stringField(note, "text"))
    ?? stringField(artifact, "path")
    ?? extractField(payload, "path")
    ?? extractField(payload, "title")
    ?? humanLabel(kind);
  const body = artifactBody(payload, note, artifact);
  return {
    kind: "artifact",
    title,
    detail: truncateLine(singleLine(detail), width),
    ...(body ? { body: truncatePayload(body, width * 40) } : {}),
    id: part.id
  };
}

function artifactBody(
  payload: unknown,
  note: Record<string, unknown> | undefined,
  artifact: Record<string, unknown> | undefined
): string | undefined {
  const candidates = [
    stringField(note, "text"),
    stringField(artifact, "content"),
    stringField(artifact, "body"),
    stringField(artifact, "text"),
    stringField(artifact, "summary"),
    stringField(artifact, "output"),
    extractField(payload, "content"),
    extractField(payload, "body"),
    extractField(payload, "text"),
    extractField(payload, "summary"),
    extractField(payload, "output")
  ];
  return candidates.find((value) => Boolean(value?.trim()))?.trim();
}

function firstSemanticLine(value: string | undefined): string | undefined {
  return value?.split("\n").find((line) => line.trim())?.trim();
}

function mcpInventoryRow(part: Part, width: number): Extract<TimelineRow, { kind: "mcp_inventory" }> {
  const text = extractField(part.payload, "text") ?? safeText(part.payload, width * 8);
  return {
    kind: "mcp_inventory",
    text,
    id: part.id
  };
}

function artifactTitle(
  kind: string,
  note: Record<string, unknown> | undefined,
  artifact: Record<string, unknown> | undefined
): string {
  if (stringField(note, "text")) return "saved note";
  if (stringField(artifact, "path")) return "saved artifact";
  return humanLabel(kind);
}

function looksLikePlanPayload(payload: unknown): boolean {
  return Array.isArray(field(payload, "plan"))
    || typeof field(payload, "plan_markdown") === "string"
    || typeof field(payload, "markdown") === "string"
    || extractField(payload, "kind") === "plan";
}

function planRow(part: Part, width: number, streaming: boolean): Extract<TimelineRow, { kind: "plan" }> {
  const rawPlan = field(part.payload, "plan");
  const items = Array.isArray(rawPlan)
    ? rawPlan.map((item) => {
        const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return {
          step: truncateLine(String(value.step ?? value.text ?? item), width),
          status: normalizePlanStatus(String(value.status ?? "pending"))
        };
      })
    : [];
  const markdown = extractField(part.payload, "plan_markdown") ?? extractField(part.payload, "markdown") ?? extractField(part.payload, "text");
  const explanation = extractField(part.payload, "explanation");
  return {
    kind: "plan",
    title: extractField(part.payload, "title") ?? (streaming ? "proposing plan" : "proposed plan"),
    ...(explanation ? { explanation } : {}),
    items,
    ...(markdown ? { markdown } : {}),
    streaming,
    id: part.id
  };
}

function normalizePlanStatus(value: string): PlanItem["status"] {
  if (value === "completed" || value === "done") return "completed";
  if (value === "in_progress" || value === "running" || value === "active") return "in_progress";
  return "pending";
}

function findingRow(part: Part, width: number): Extract<TimelineRow, { kind: "finding" }> {
  const finding = extractObject(part.payload, "finding") ?? (part.payload && typeof part.payload === "object" ? part.payload as Record<string, unknown> : undefined);
  const title = stringField(finding, "title") ?? "finding";
  const severity = stringField(finding, "severity") ?? "info";
  const target = stringField(finding, "target") ?? "";
  const detail = [
    target,
    firstSemanticLine(stringField(finding, "impact") ?? stringField(finding, "summary"))
  ].filter(Boolean).join(" · ");
  const body = findingDetailBody(finding);
  return {
    kind: "finding",
    title: truncateLine(title, width),
    severity,
    target,
    detail: truncateLine(detail || "details not recorded", width),
    ...(body ? { body } : {}),
    id: part.id
  };
}

function findingDetailBody(finding: Record<string, unknown> | undefined): string | undefined {
  if (!finding) return undefined;
  const sections = [
    semanticField("target", stringField(finding, "target")),
    semanticField("status", stringField(finding, "status")),
    semanticSection("impact", stringField(finding, "impact") ?? stringField(finding, "summary")),
    semanticSection("reproduction", stringField(finding, "reproduction")),
    semanticSection("remediation", stringField(finding, "remediation"))
  ].filter((value): value is string => Boolean(value));
  const evidenceIds = field(finding, "evidenceIds");
  if (Array.isArray(evidenceIds) && evidenceIds.length > 0) {
    sections.push(`evidence: ${evidenceIds.length} linked item${evidenceIds.length === 1 ? "" : "s"}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function semanticField(label: string, value: string | undefined): string | undefined {
  return value?.trim() ? `${label}: ${value.trim()}` : undefined;
}

function semanticSection(label: string, value: string | undefined): string | undefined {
  return value?.trim() ? `## ${label}\n${value.trim()}` : undefined;
}

export function summarizeToolArgs(tool: string, args: unknown, max = 80): string {
  return summarizeToolInput(tool, args, max);
}

export function summarizeToolCallRow(call: ToolCallRecord, width = DEFAULT_WIDTH): string {
  return truncateLine(`${humanLabel(call.tool)} · ${call.status}`, width);
}
