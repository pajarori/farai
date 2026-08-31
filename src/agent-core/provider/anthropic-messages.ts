import { resolveRequestMaxOutputTokens } from "../model-registry";
import { estimateChatRequestInputTokens, type ChatProvider, type ChatRequest, type ProviderMessage, type ProviderStreamEvent, type ProviderToolDef } from "./protocol";
import { createProviderDebugCapture, iterateSseData, logDebugEntry, parseRetryAfterMs, planRequestSignal, providerHttpError, readResponseTextPreview } from "./http";
import { BoundedTextAccumulator, PROVIDER_ERROR_BODY_MAX_BYTES, providerResponseLimits, type ProviderResponseLimits } from "./stream-bounds";
import { canonicalToolName } from "../../tool-names";
import type { ModelPricingSnapshot } from "../../types";
import { materializeToolAttachment } from "../../tool-attachment";
import { ANTHROPIC_REQUEST_LIMITS, prepareProviderMessages, serializeProviderRequestBody } from "./request-bounds";

const ANTHROPIC_VERSION = "2023-06-01";

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[] };

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
    const messages = prepareProviderMessages(request.messages, ANTHROPIC_REQUEST_LIMITS);
    const requestMaxOutputTokens = resolveRequestMaxOutputTokens({
      estimatedInputTokens: estimateChatRequestInputTokens({ ...request, messages }),
      ...(this.options.contextWindow !== undefined ? { contextWindow: this.options.contextWindow } : {}),
      ...(this.options.maxOutputTokens !== undefined ? { modelMaxOutputTokens: this.options.maxOutputTokens } : {}),
      ...(request.maxOutputTokens !== undefined ? { requestedMaxOutputTokens: request.maxOutputTokens } : {})
    });
    const limits = providerResponseLimits(requestMaxOutputTokens);
    const requestBody = {
      model: this.options.model,
      max_tokens: requestMaxOutputTokens,
      temperature: request.temperature ?? 0.2,
      system: toAnthropicSystem(request.system, request.systemBlocks),
      stream: true,
      messages: toAnthropicMessages(messages),
      ...(request.tools.length > 0 ? {
        tools: toAnthropicTools(request.tools),
        ...(request.toolChoice === "none" ? { tool_choice: { type: "none" } } : {})
      } : {})
    };
    const requestJson = serializeProviderRequestBody(requestBody, ANTHROPIC_REQUEST_LIMITS.bodyBytes, "anthropic provider request");
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        ...(this.options.apiKey ? { "x-api-key": this.options.apiKey } : {})
      },
      body: requestJson,
      signal: planRequestSignal(request.signal)
    });
    if (!response.ok) {
      const responseText = await readResponseTextPreview(response, PROVIDER_ERROR_BODY_MAX_BYTES);
      logDebugEntry({ baseUrl: this.options.baseUrl, model: this.options.model, requestBody, responseStatus: response.status, responseText });
      yield { type: "error", message: providerHttpError(response.status, responseText, Boolean(this.options.apiKey)), status: response.status, ...(parseRetryAfterMs(response.headers) !== undefined ? { retryAfterMs: parseRetryAfterMs(response.headers)! } : {}) };
      return;
    }
    yield* this.consume(response, requestBody, limits);
  }

  private async *consume(response: Response, requestBody: unknown, limits: ProviderResponseLimits): AsyncIterable<ProviderStreamEvent> {
    let finishReason: string | undefined;
    const blocks = new Map<number, { type: string; id?: string; name?: string; arguments: BoundedTextAccumulator }>();
    const content = new BoundedTextAccumulator(limits.contentBytes, "provider content", limits.sseEvents);
    const reasoning = new BoundedTextAccumulator(limits.reasoningBytes, "provider reasoning", limits.sseEvents);
    const capture = createProviderDebugCapture();

    const handle = function* (event: { type?: string; index?: number; content_block?: { type?: string; id?: string; name?: string }; delta?: Record<string, unknown>; usage?: AnthropicUsage; message?: { usage?: AnthropicUsage }; error?: { message?: string } }): Iterable<ProviderStreamEvent> {
      switch (event.type) {
        case "message_start":
          if (hasAnthropicUsage(event.message?.usage)) yield anthropicUsageEvent(event.message.usage);
          break;
        case "content_block_start": {
          const idx = event.index ?? 0;
          if (!Number.isInteger(idx) || idx < 0 || idx >= limits.toolCalls) throw new Error(`provider content block index must be between 0 and ${limits.toolCalls - 1}`);
          const block = event.content_block ?? {};
          blocks.set(idx, {
            type: block.type ?? "text",
            ...(block.id ? { id: block.id } : {}),
            ...(block.name ? { name: block.name } : {}),
            arguments: new BoundedTextAccumulator(limits.toolArgumentsBytes, "provider tool arguments", limits.sseEvents)
          });
          break;
        }
        case "content_block_delta": {
          const idx = event.index ?? 0;
          if (!Number.isInteger(idx) || idx < 0 || idx >= limits.toolCalls) throw new Error(`provider content block index must be between 0 and ${limits.toolCalls - 1}`);
          const delta = event.delta ?? {};
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            content.append(delta.text);
            yield { type: "text_delta", delta: delta.text };
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            reasoning.append(delta.thinking);
            yield { type: "reasoning_delta", delta: delta.thinking };
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const slot = blocks.get(idx);
            if (slot) {
              slot.arguments.append(delta.partial_json);
              yield { type: "tool_call_delta", index: idx, ...(slot.id ? { id: slot.id } : {}), ...(slot.name ? { name: slot.name } : {}), argumentsDelta: delta.partial_json };
            }
          }
          break;
        }
        case "content_block_stop": {
          const idx = event.index ?? 0;
          const slot = blocks.get(idx);
          if (slot && slot.type === "tool_use" && slot.name) {
            yield { type: "tool_call_complete", index: idx, id: slot.id ?? slot.name, name: slot.name, arguments: slot.arguments.text() || "{}" };
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

    try {
      for await (const data of iterateSseData(response, limits, capture)) {
        if (!data) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(data); } catch { throw new Error("provider returned malformed sse json"); }
        yield* handle(event as Parameters<typeof handle>[0]);
      }
    } finally {
      logDebugEntry({ baseUrl: this.options.baseUrl, model: this.options.model, requestBody, responseStatus: response.status, responseText: capture?.text() ?? "" });
    }
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
      const blocks: AnthropicContentBlock[] = [{ type: "text", text: entry.text }];
      if (entry.role === "user") blocks.push(...anthropicImages(entry.attachments));
      const last = out[out.length - 1];
      if (last?.role === "user") last.content.push(...blocks);
      else out.push({ role: "user", content: blocks });
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
    const toolContent: string | AnthropicContentBlock[] = entry.attachments?.length
      ? [{ type: "text", text: entry.text }, ...anthropicImages(entry.attachments)]
      : entry.text;
    const block: AnthropicContentBlock = { type: "tool_result", tool_use_id: entry.toolCallId, content: toolContent };
    const last = out[out.length - 1];
    if (last && last.role === "user" && last.content.every((item) => item.type === "tool_result")) {
      last.content.push(block);
    } else {
      out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

function anthropicImages(attachments: import("../../types").ToolAttachment[] | undefined): AnthropicContentBlock[] {
  return (attachments ?? []).map(materializeToolAttachment).map((item) => ({
    type: "image",
    source: { type: "base64", media_type: item.mediaType, data: item.data }
  }));
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
