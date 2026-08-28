import type { ModelPricingSnapshot, ToolSchemaSnapshot } from "../../types";

export type ProviderStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "tool_call_complete"; index: number; id: string; name: string; arguments: string }
  | { type: "message_complete"; finishReason?: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number }
  | { type: "error"; message: string; status?: number; retryAfterMs?: number };

export type ProviderMessage =
  | { role: "user"; text: string }
  | { role: "context"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
  | { role: "tool"; toolCallId: string; name: string; text: string };

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
  const payload = {
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    toolChoice: request.toolChoice
  };
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(payload), "utf8") / 3));
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
  onEvent?: (event: ProviderStreamEvent) => void
): Promise<AssembledMessage> {
  let content = "";
  let reasoning = "";
  let finishReason: string | undefined;
  let usage: AssembledMessage["usage"];
  const slots: AssembledToolCall[] = [];
  for await (const event of stream) {
    onEvent?.(event);
    switch (event.type) {
      case "text_delta":
        content += event.delta;
        break;
      case "reasoning_delta":
        reasoning += event.delta;
        break;
      case "tool_call_delta": {
        const slot = (slots[event.index] ??= { name: "", arguments: "" });
        if (event.id) slot.id = event.id;
        if (event.name) slot.name = event.name;
        if (event.argumentsDelta) slot.arguments += event.argumentsDelta;
        break;
      }
      case "tool_call_complete": {
        const slot = (slots[event.index] ??= { name: "", arguments: "" });
        if (event.id) slot.id = event.id;
        if (event.name) slot.name = event.name;
        slot.arguments = event.arguments;
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
  }
  return {
    content,
    reasoning,
    toolCalls: slots.filter((slot): slot is AssembledToolCall => Boolean(slot?.name)),
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {})
  };
}
