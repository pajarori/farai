import type { MessageWithParts, ToolCallRecord } from "../types";
import { canonicalToolName } from "../tool-names";
import type { ConversationEntry } from "./provider";
import { ensureToolResultsPaired, fitToolResultText } from "./loop/history";

export type HistoryProjection = {
  entries: ConversationEntry[];
  estimatedTokens: number;
  fullToolResults: number;
  receiptToolResults: number;
  omittedEntries: number;
};

const TRUNCATED_ENTRY_MARKER = "\n...[history entry truncated to fit the active context budget]...\n";

export function projectConversationHistory(messages: MessageWithParts[], options: {
  maxTokens?: number;
  /** @deprecated Canonical tool results no longer change shape based on recency. */
  recentFullToolResults?: number;
  fullToolResultMaxBytes?: number;
  full?: boolean;
} = {}): HistoryProjection {
  const providerToolCallIds = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool_call") continue;
      const record = (part.payload as { record?: ToolCallRecord }).record;
      if (!record) continue;
      if (record.providerToolCallId) providerToolCallIds.set(record.id, record.providerToolCallId);
    }
  }

  const entries: ConversationEntry[] = [];
  let fullToolResults = 0;
  const receiptToolResults = 0;
  for (const message of messages) {
    if (message.role === "system") {
      for (const part of message.parts) {
        if (part.type !== "provider_context") continue;
        const text = (part.payload as { text?: unknown }).text;
        if (typeof text === "string" && text.trim()) entries.push({ role: "context", text });
      }
      continue;
    }
    if (message.role === "user") {
      for (const part of message.parts) {
        if (part.type !== "text") continue;
        const text = (part.payload as { text?: unknown }).text;
        if (typeof text === "string" && text) entries.push({ role: "user", text });
      }
      continue;
    }
    if (message.role !== "assistant") continue;
    let pendingText: string | undefined;
    let pendingToolCalls: Array<{ id: string; tool: string; args: unknown }> = [];
    let lastText: string | undefined;
    const flush = () => {
      if (pendingText !== undefined || pendingToolCalls.length > 0) {
        entries.push({
          role: "assistant",
          ...(pendingText !== undefined ? { text: pendingText } : {}),
          ...(pendingToolCalls.length ? { toolCalls: pendingToolCalls } : {})
        });
      }
      pendingText = undefined;
      pendingToolCalls = [];
      lastText = undefined;
    };
    for (const part of message.parts) {
      if (part.type === "text") {
        const text = (part.payload as { text?: unknown }).text;
        if (typeof text === "string" && text && text !== lastText) {
          pendingText = pendingText ? `${pendingText}\n${text}` : text;
          lastText = text;
        }
      } else if (part.type === "tool_call") {
        const record = (part.payload as { record?: ToolCallRecord }).record;
        const tool = canonicalToolName(record?.tool);
        if (record && tool) pendingToolCalls.push({ id: record.providerToolCallId ?? record.id, tool, args: record.args });
      } else if (part.type === "tool_result") {
        flush();
        const payload = part.payload as { toolCallId?: string; tool?: unknown; result?: unknown };
        const raw = typeof payload.result === "string" ? payload.result : JSON.stringify(payload.result ?? "");
        const tool = canonicalToolName(payload.tool) || "unknown";
        const text = fitToolResultText(raw, options.fullToolResultMaxBytes ?? 8 * 1024);
        fullToolResults += 1;
        entries.push({
          role: "tool",
          toolCallId: (payload.toolCallId ? providerToolCallIds.get(payload.toolCallId) : undefined) ?? payload.toolCallId ?? tool,
          tool,
          text
        });
      } else if (part.type === "error") {
        const payload = part.payload as { toolCallId?: string; tool?: unknown; error?: string; text?: string };
        const errorText = payload.error ?? payload.text ?? "Tool call failed with an unrecorded error.";
        if (payload.toolCallId) {
          flush();
          entries.push({
            role: "tool",
            toolCallId: providerToolCallIds.get(payload.toolCallId) ?? payload.toolCallId,
            tool: canonicalToolName(payload.tool) || "unknown",
            text: `status: error\nsummary: ${errorText}`
          });
        } else {
          pendingText = pendingText ? `${pendingText}\n${errorText}` : errorText;
        }
      }
    }
    flush();
  }

  const paired = ensureToolResultsPaired(entries);
  const maxTokens = options.full ? Number.MAX_SAFE_INTEGER : options.maxTokens ?? 6_000;
  const fitted = fitConversationEntries(paired, maxTokens);
  return {
    entries: fitted,
    estimatedTokens: estimateTokens(fitted),
    fullToolResults,
    receiptToolResults,
    omittedEntries: Math.max(0, paired.length - fitted.length)
  };
}

export function fitConversationEntries(entries: ConversationEntry[], maxTokens: number): ConversationEntry[] {
  if (maxTokens <= 0 || entries.length === 0) return [];
  let fitted = ensureToolResultsPaired(structuredClone(entries));
  if (estimateTokens(fitted) <= maxTokens) return fitted;

  // Drop complete old user turns first. A single long turn has no later user boundary,
  // so the second phase removes old assistant/tool groups while retaining the request.
  while (estimateTokens(fitted) > maxTokens) {
    const nextUser = fitted.findIndex((entry, index) => index > 0 && entry.role === "user");
    if (nextUser === -1) break;
    fitted.splice(0, nextUser);
  }

  while (estimateTokens(fitted) > maxTokens) {
    const range = oldestAssistantGroup(fitted);
    if (!range) break;
    fitted.splice(range.start, range.count);
  }

  while (estimateTokens(fitted) > maxTokens && fitted.filter((entry) => entry.role === "user").length > 1) {
    const oldestUser = fitted.findIndex((entry) => entry.role === "user");
    if (oldestUser === -1) break;
    fitted.splice(oldestUser, 1);
  }

  fitted = ensureToolResultsPaired(fitted);
  while (estimateTokens(fitted) > maxTokens && fitted.length > 1) {
    const removable = fitted.findIndex((entry) => entry.role !== "user");
    if (removable === -1) fitted.shift();
    else fitted.splice(removable, 1);
    while (fitted[0]?.role === "tool") fitted.shift();
    fitted = ensureToolResultsPaired(fitted);
  }

  if (estimateTokens(fitted) > maxTokens && fitted[0]) {
    fitted[0] = truncateEntryToBudget(fitted[0], maxTokens);
  }
  return estimateTokens(fitted) <= maxTokens ? fitted : [];
}

function oldestAssistantGroup(entries: ConversationEntry[]): { start: number; count: number } | undefined {
  const start = entries.findIndex((entry) => entry.role === "assistant");
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < entries.length && entries[end]?.role === "tool") end += 1;
  return { start, count: end - start };
}

function truncateEntryToBudget(entry: ConversationEntry, maxTokens: number): ConversationEntry {
  if (entry.role === "assistant" && entry.toolCalls?.length) {
    return { role: "assistant", text: "[older tool call details omitted to fit context]" };
  }
  const original = entry.text ?? "";
  const chars = Array.from(original);
  let low = 0;
  let high = chars.length;
  let best = "";
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const head = Math.ceil(keep * 0.6);
    const tail = keep - head;
    const text = keep >= chars.length
      ? original
      : `${chars.slice(0, head).join("")}${TRUNCATED_ENTRY_MARKER}${tail > 0 ? chars.slice(-tail).join("") : ""}`;
    const candidate = entry.role === "user"
      ? { role: "user" as const, text }
      : entry.role === "tool"
        ? { ...entry, text }
        : { ...entry, text };
    if (estimateTokens([candidate]) <= maxTokens) {
      best = text;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  if (entry.role === "user") return { role: "user", text: best };
  if (entry.role === "tool") return { ...entry, text: best };
  return { ...entry, text: best };
}

function estimateTokens(value: unknown): number {
  return Math.max(0, Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4));
}
