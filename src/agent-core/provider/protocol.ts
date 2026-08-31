import type { ModelPricingSnapshot, ToolAttachment, ToolSchemaSnapshot } from "../../types";
import { BoundedTextAccumulator, providerResponseLimits, type ProviderResponseLimits } from "./stream-bounds";

export type ProviderStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "tool_call_complete"; index: number; id: string; name: string; arguments: string }
  | { type: "message_complete"; finishReason?: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number }
  | { type: "error"; message: string; status?: number; retryAfterMs?: number };

export type ProviderMessage =
  | { role: "user"; text: string; attachments?: ToolAttachment[] }
  | { role: "context"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
  | { role: "tool"; toolCallId: string; name: string; text: string; attachments?: ToolAttachment[] };

export type ProviderToolDef = ToolSchemaSnapshot;

export type ChatRequest = {
  model: string;
  system: string;
  systemBlocks?: Array<{ text: string; cacheable: boolean }>;
  messages: ProviderMessage[];
  tools: ProviderToolDef[];
  toolChoice?: "auto" | "none";
  promptCacheKey?: string;
  temperature?: number;
  maxOutputTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  sessionId: string;
};

export function estimateChatRequestInputTokens(request: ChatRequest): number {
  let imageTokens = 0;
  const messages = request.messages.map((entry) => {
    if ((entry.role !== "user" && entry.role !== "tool") || !entry.attachments?.length) return entry;
    imageTokens += entry.attachments.reduce((total, attachment) => total + (attachment.detail === "low" ? 85 : attachment.detail === "high" ? 765 : 512), 0);
    return {
      ...entry,
      attachments: entry.attachments.map((attachment) => ({
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        ...(attachment.name ? { name: attachment.name } : {}),
        ...(attachment.detail ? { detail: attachment.detail } : {})
      }))
    };
  });
  const payload = {
    system: request.system,
    messages,
    tools: request.tools,
    toolChoice: request.toolChoice
  };
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(payload), "utf8") / 3) + imageTokens);
}

export type ProviderProtocol = "openai-chat" | "anthropic-messages" | "heuristic";

export interface ChatProvider {
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly model?: string | undefined;
  readonly pricing?: ModelPricingSnapshot | undefined;
  readonly contextWindow?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  stream(request: ChatRequest): AsyncIterable<ProviderStreamEvent>;
}

export type AssembledToolCall = { id?: string; name: string; arguments: string };

export type AssembledMessage = {
  content: string;
  reasoning: string;
  toolCalls: AssembledToolCall[];
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number };
};

export class ProviderStreamError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = "ProviderStreamError";
  }
}

export async function assembleStream(
  stream: AsyncIterable<ProviderStreamEvent>,
  onEvent?: (event: ProviderStreamEvent) => void,
  limits: ProviderResponseLimits = providerResponseLimits()
): Promise<AssembledMessage> {
  const content = new BoundedTextAccumulator(limits.contentBytes, "provider content", limits.sseEvents);
  const reasoning = new BoundedTextAccumulator(limits.reasoningBytes, "provider reasoning", limits.sseEvents);
  let finishReason: string | undefined;
  let usage: AssembledMessage["usage"];
  const slots: Array<{ id?: string; name: string; arguments: BoundedTextAccumulator; completeArguments?: string }> = [];
  let events = 0;
  for await (const event of stream) {
    events += 1;
    if (events > limits.sseEvents) throw new Error(`provider stream exceeded the ${limits.sseEvents}-event limit`);
    switch (event.type) {
      case "text_delta":
        content.append(event.delta);
        break;
      case "reasoning_delta":
        reasoning.append(event.delta);
        break;
      case "tool_call_delta": {
        assertProviderToolIndex(event.index, limits.toolCalls);
        const slot = (slots[event.index] ??= {
          name: "",
          arguments: new BoundedTextAccumulator(limits.toolArgumentsBytes, "provider tool arguments", limits.sseEvents)
        });
        if (event.id) slot.id = event.id;
        if (event.name) slot.name = event.name;
        if (event.argumentsDelta) slot.arguments.append(event.argumentsDelta);
        break;
      }
      case "tool_call_complete": {
        assertProviderToolIndex(event.index, limits.toolCalls);
        assertTextWithinLimit(event.arguments, limits.toolArgumentsBytes, "provider tool arguments");
        const slot = (slots[event.index] ??= {
          name: "",
          arguments: new BoundedTextAccumulator(limits.toolArgumentsBytes, "provider tool arguments", limits.sseEvents)
        });
        if (event.id) slot.id = event.id;
        if (event.name) slot.name = event.name;
        slot.completeArguments = event.arguments;
        slot.arguments.clear();
        break;
      }
      case "message_complete":
        if (event.finishReason) finishReason = event.finishReason;
        break;
      case "usage":
        usage = {
          ...(usage ?? {}),
          ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
          ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
          ...(event.cachedInputTokens !== undefined ? { cachedInputTokens: event.cachedInputTokens } : {}),
          ...(event.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: event.cacheWriteInputTokens } : {})
        };
        break;
      case "error":
        throw new ProviderStreamError(event.message, event.status, event.retryAfterMs);
    }
    onEvent?.(event);
  }
  return {
    content: content.text(),
    reasoning: reasoning.text(),
    toolCalls: slots.flatMap((slot): AssembledToolCall[] => slot?.name ? [{
      ...(slot.id ? { id: slot.id } : {}),
      name: slot.name,
      arguments: slot.completeArguments ?? slot.arguments.text()
    }] : []),
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {})
  };
}

function assertProviderToolIndex(index: number, max: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= max) throw new Error(`provider tool call index must be between 0 and ${max - 1}`);
}

function assertTextWithinLimit(value: string, max: number, label: string): void {
  if (Buffer.byteLength(value, "utf8") > max) throw new Error(`${label} exceeded the ${max}-byte provider response limit`);
}
