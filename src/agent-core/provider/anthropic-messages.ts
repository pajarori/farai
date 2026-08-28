import { resolveRequestMaxOutputTokens } from "../model-registry";
import { estimateChatRequestInputTokens, type ChatProvider, type ChatRequest, type ProviderMessage, type ProviderStreamEvent, type ProviderToolDef } from "./protocol";
import { logDebugEntry, parseRetryAfterMs, planRequestSignal } from "./http";
import { canonicalToolName } from "../../tool-names";
import type { ModelPricingSnapshot } from "../../types";

const ANTHROPIC_VERSION = "2023-06-01";

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicContentBlock[] };

type AnthropicCacheControl = { type: "ephemeral" };
type AnthropicSystemBlock = { type: "text"; text: string; cache_control?: AnthropicCacheControl };
type AnthropicToolDef = { name: string; description: string; input_schema: Record<string, unknown>; cache_control?: AnthropicCacheControl };

export class AnthropicMessagesProvider implements ChatProvider {
  readonly name: string;
  readonly protocol = "anthropic-messages" as const;
  readonly model: string;
  readonly pricing: ModelPricingSnapshot | undefined;
  readonly contextWindow: number | undefined;
  readonly maxOutputTokens: number | undefined;

  constructor(
    private readonly options: {
      apiKey?: string | undefined;
      baseUrl: string;
      model: string;
      name?: string;
      pricing?: ModelPricingSnapshot | undefined;
      contextWindow?: number | undefined;
      maxOutputTokens?: number | undefined;
    }
  ) {
    this.name = options.name ?? "anthropic";
    this.model = options.model;
    this.pricing = options.pricing;
    this.contextWindow = options.contextWindow;
    this.maxOutputTokens = options.maxOutputTokens;
  }

  async *stream(request: ChatRequest): AsyncIterable<ProviderStreamEvent> {
    const requestBody = {
      model: this.options.model,
      max_tokens: resolveRequestMaxOutputTokens({
        estimatedInputTokens: estimateChatRequestInputTokens(request),
        ...(this.options.contextWindow !== undefined ? { contextWindow: this.options.contextWindow } : {}),
        ...(this.options.maxOutputTokens !== undefined ? { modelMaxOutputTokens: this.options.maxOutputTokens } : {}),
        ...(request.maxOutputTokens !== undefined ? { requestedMaxOutputTokens: request.maxOutputTokens } : {})
      }),
      temperature: request.temperature ?? 0.2,
      system: toAnthropicSystem(request.system, request.systemBlocks),
      stream: true,
      messages: toAnthropicMessages(request.messages),
      ...(request.tools.length > 0 ? {
        tools: toAnthropicTools(request.tools),
        ...(request.toolChoice === "none" ? { tool_choice: { type: "none" } } : {})
      } : {})
    };
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        ...(this.options.apiKey ? { "x-api-key": this.options.apiKey } : {})
      },
      body: JSON.stringify(requestBody),
      signal: planRequestSignal(request.signal)
    });
    if (!response.ok) {
      const responseText = await response.text();
      logDebugEntry({ baseUrl: this.options.baseUrl, model: this.options.model, requestBody, responseStatus: response.status, responseText });
      yield { type: "error", message: `Planner provider failed: ${response.status} ${responseText}`, status: response.status, ...(parseRetryAfterMs(response.headers) !== undefined ? { retryAfterMs: parseRetryAfterMs(response.headers)! } : {}) };
      return;
    }
    yield* this.consume(response, requestBody);
  }

  private async *consume(response: Response, requestBody: unknown): AsyncIterable<ProviderStreamEvent> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finishReason: string | undefined;
    const blocks = new Map<number, { type: string; id?: string; name?: string; arguments: string }>();
    const raw: string[] = [];

    const handle = function* (event: { type?: string; index?: number; content_block?: { type?: string; id?: string; name?: string }; delta?: Record<string, unknown>; usage?: AnthropicUsage; message?: { usage?: AnthropicUsage }; error?: { message?: string } }): Iterable<ProviderStreamEvent> {
      switch (event.type) {
        case "message_start":
          if (hasAnthropicUsage(event.message?.usage)) yield anthropicUsageEvent(event.message.usage);
          break;
        case "content_block_start": {
          const idx = event.index ?? 0;
          const block = event.content_block ?? {};
          blocks.set(idx, { type: block.type ?? "text", ...(block.id ? { id: block.id } : {}), ...(block.name ? { name: block.name } : {}), arguments: "" });
          break;
        }
        case "content_block_delta": {
          const idx = event.index ?? 0;
          const delta = event.delta ?? {};
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            yield { type: "text_delta", delta: delta.text };
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            yield { type: "reasoning_delta", delta: delta.thinking };
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const slot = blocks.get(idx);
            if (slot) {
              slot.arguments += delta.partial_json;
              yield { type: "tool_call_delta", index: idx, ...(slot.id ? { id: slot.id } : {}), ...(slot.name ? { name: slot.name } : {}), argumentsDelta: delta.partial_json };
            }
          }
          break;
        }
        case "content_block_stop": {
          const idx = event.index ?? 0;
          const slot = blocks.get(idx);
          if (slot && slot.type === "tool_use" && slot.name) {
            yield { type: "tool_call_complete", index: idx, id: slot.id ?? slot.name, name: slot.name, arguments: slot.arguments || "{}" };
          }
          break;
        }
        case "message_delta": {
          const stop = (event.delta as { stop_reason?: string } | undefined)?.stop_reason;
          if (stop) finishReason = stop === "max_tokens" ? "length" : stop;
          if (hasAnthropicUsage(event.usage)) yield anthropicUsageEvent(event.usage);
          break;
        }
        case "error":
          yield { type: "error", message: event.error?.message ?? "anthropic stream error" };
          break;
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        raw.push(data);
        let event: Record<string, unknown>;
        try { event = JSON.parse(data); } catch { continue; }
        yield* handle(event as Parameters<typeof handle>[0]);
      }
    }
    logDebugEntry({ baseUrl: this.options.baseUrl, model: this.options.model, requestBody, responseStatus: response.status, responseText: raw.join("\n") });
    yield { type: "message_complete", ...(finishReason ? { finishReason } : {}) };
  }
}

function toAnthropicSystem(flat: string, blocks?: Array<{ text: string; cacheable: boolean }>): string | AnthropicSystemBlock[] {
  if (!blocks?.length) return flat;
  return blocks
    .filter((block) => block.text.trim())
    .map((block): AnthropicSystemBlock => ({
      type: "text",
      text: block.text,
      ...(block.cacheable ? { cache_control: { type: "ephemeral" } } : {})
    }));
}

function toAnthropicTools(tools: ProviderToolDef[]): AnthropicToolDef[] {
  return tools.map((tool, index): AnthropicToolDef => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    ...(index === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {})
  }));
}

function toAnthropicMessages(messages: ProviderMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const entry of messages) {
    if (entry.role === "user" || entry.role === "context") {
      const block: AnthropicContentBlock = { type: "text", text: entry.text };
      const last = out[out.length - 1];
      if (last?.role === "user") last.content.push(block);
      else out.push({ role: "user", content: [block] });
      continue;
    }
    if (entry.role === "assistant") {
      const content: AnthropicContentBlock[] = [];
      if (entry.text) content.push({ type: "text", text: entry.text });
      for (const call of entry.toolCalls ?? []) {
        const name = canonicalToolName(call.name);
        if (name) content.push({ type: "tool_use", id: call.id, name, input: safeJsonParse(call.arguments) });
      }
      if (content.length === 0) content.push({ type: "text", text: "" });
      out.push({ role: "assistant", content });
      continue;
    }
    const block: AnthropicContentBlock = { type: "tool_result", tool_use_id: entry.toolCallId, content: entry.text };
    const last = out[out.length - 1];
    if (last && last.role === "user" && last.content.every((item) => item.type === "tool_result")) {
      last.content.push(block);
    } else {
      out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

function hasAnthropicUsage(usage: AnthropicUsage | undefined): usage is AnthropicUsage {
  return usage?.input_tokens !== undefined
    || usage?.output_tokens !== undefined
    || usage?.cache_read_input_tokens !== undefined
    || usage?.cache_creation_input_tokens !== undefined;
}

function anthropicUsageEvent(usage: AnthropicUsage): Extract<ProviderStreamEvent, { type: "usage" }> {
  return {
    type: "usage",
    ...(usage.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
    ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
    ...(usage.cache_read_input_tokens !== undefined ? { cachedInputTokens: usage.cache_read_input_tokens } : {}),
    ...(usage.cache_creation_input_tokens !== undefined ? { cacheWriteInputTokens: usage.cache_creation_input_tokens } : {})
  };
}

function safeJsonParse(text: string): unknown {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
