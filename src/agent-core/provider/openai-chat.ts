import { resolveRequestMaxOutputTokens } from "../model-registry";
import { estimateChatRequestInputTokens, type ChatProvider, type ChatRequest, type ProviderMessage, type ProviderStreamEvent, type ProviderToolDef } from "./protocol";
import { assertCanonicalToolName, canonicalToolName } from "../../tool-names";
import { logDebugEntry, parseRetryAfterMs, planRequestSignal } from "./http";
import type { ModelPricingSnapshot } from "../../types";

type OpenAiChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

const XML_FUNCTION_PATTERN = /<function=([^>]+)>([\s\S]*?)<\/function>/g;
const XML_PARAMETER_PATTERN = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;

export class OpenAiChatProvider implements ChatProvider {
  readonly name: string;
  readonly protocol = "openai-chat" as const;
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
    this.name = options.name ?? "openai-compatible";
    this.model = options.model;
    this.pricing = options.pricing;
    this.contextWindow = options.contextWindow;
    this.maxOutputTokens = options.maxOutputTokens;
  }

  async *stream(request: ChatRequest): AsyncIterable<ProviderStreamEvent> {
    const toolsPayload = toToolsPayload(request.tools);
    const requestBody = {
      model: this.options.model,
      temperature: request.temperature ?? 0.2,
      max_tokens: resolveRequestMaxOutputTokens({
        estimatedInputTokens: estimateChatRequestInputTokens(request),
        ...(this.options.contextWindow !== undefined ? { contextWindow: this.options.contextWindow } : {}),
        ...(this.options.maxOutputTokens !== undefined ? { modelMaxOutputTokens: this.options.maxOutputTokens } : {}),
        ...(request.maxOutputTokens !== undefined ? { requestedMaxOutputTokens: request.maxOutputTokens } : {})
      }),
      user: request.sessionId,
      stream: true,
      stream_options: { include_usage: true },
      ...(supportsPromptCacheKey(this.options.baseUrl) && request.promptCacheKey ? { prompt_cache_key: request.promptCacheKey } : {}),
      ...(toolsPayload.length > 0 ? { tools: toolsPayload, tool_choice: request.toolChoice ?? "auto" } : {}),
      messages: [
        { role: "system", content: request.system },
        ...toOpenAiMessages(request.messages)
      ]
    };
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {})
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
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      yield* this.streamSse(response, requestBody);
    } else {
      yield* this.streamBuffered(response, requestBody);
    }
  }

  private async *streamBuffered(response: Response, requestBody: unknown): AsyncIterable<ProviderStreamEvent> {
    const rawText = await response.text();
    logDebugEntry({ baseUrl: this.options.baseUrl, model: this.options.model, requestBody, responseStatus: response.status, responseText: rawText });
    let json: { choices?: Array<{ message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>; usage?: OpenAiUsage };
    try { json = JSON.parse(rawText); } catch { yield { type: "error", message: `Planner provider returned non-JSON body: ${rawText.slice(0, 500)}` }; return; }
    if (hasUsage(json.usage)) {
      yield usageEvent(json.usage);
    }
    const choice = json.choices?.[0];
    const message = choice?.message;
    const reasoning = typeof message?.reasoning === "string" ? message.reasoning : typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
    if (reasoning) yield { type: "reasoning_delta", delta: reasoning };
    const content = typeof message?.content === "string" ? message.content : "";
    if (content) yield { type: "text_delta", delta: content };
    const nativeCalls = message?.tool_calls ?? [];
    let index = 0;
    if (nativeCalls.length > 0) {
      for (const call of nativeCalls) {
        const name = call.function?.name;
        if (!name) continue;
        yield { type: "tool_call_complete", index: index++, id: call.id ?? "", name, arguments: call.function?.arguments ?? "{}" };
      }
    } else if (content.includes("<function=")) {
      for (const call of parseXmlToolCalls(content).calls) {
        yield { type: "tool_call_complete", index: index++, id: "", name: call.name, arguments: JSON.stringify(coerceXmlArgs(call.args)) };
      }
    }
    yield { type: "message_complete", ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}) };
  }

  private async *streamSse(response: Response, requestBody: unknown): AsyncIterable<ProviderStreamEvent> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullContent = "";
    let suppressText = false;
    let finishReason: string | undefined;
    const slots: Array<{ id?: string; name: string; arguments: string; emitted?: boolean }> = [];
    let activeIndex = -1;
    const raw: string[] = [];

    const emitComplete = function* (idx: number): Iterable<ProviderStreamEvent> {
      const slot = slots[idx];
      if (!slot || slot.emitted || !slot.name) return;
      slot.emitted = true;
      yield { type: "tool_call_complete", index: idx, id: slot.id ?? "", name: slot.name, arguments: slot.arguments || "{}" };
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
        if (!data || data === "[DONE]") continue;
        raw.push(data);
        let chunk: { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>; usage?: OpenAiUsage };
        try { chunk = JSON.parse(data); } catch { continue; }
        if (hasUsage(chunk.usage)) {
          yield usageEvent(chunk.usage);
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) {
          fullContent += delta.content;
          if (!suppressText && fullContent.includes("<function=")) suppressText = true;
          else if (!suppressText) yield { type: "text_delta", delta: delta.content };
        }
        const reasoningDelta = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
        if (reasoningDelta) yield { type: "reasoning_delta", delta: reasoningDelta };
        if (Array.isArray(delta.tool_calls)) {
          for (const rawCall of delta.tool_calls) {
            const call = rawCall as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
            const idx = typeof call.index === "number" ? call.index : slots.length ? slots.length - 1 : 0;
            if (idx !== activeIndex && activeIndex >= 0) yield* emitComplete(activeIndex);
            activeIndex = idx;
            const slot = (slots[idx] ??= { name: "", arguments: "" });
            if (call.id) slot.id = call.id;
            if (call.function?.name) slot.name = call.function.name;
            const argChunk = call.function?.arguments;
            if (typeof argChunk === "string") {
              slot.arguments += argChunk;
              yield { type: "tool_call_delta", index: idx, ...(call.id ? { id: call.id } : {}), ...(call.function?.name ? { name: call.function.name } : {}), argumentsDelta: argChunk };
            } else if (call.id || call.function?.name) {
              yield { type: "tool_call_delta", index: idx, ...(call.id ? { id: call.id } : {}), ...(call.function?.name ? { name: call.function.name } : {}) };
            }
          }
        }
      }
    }

    for (let i = 0; i < slots.length; i++) yield* emitComplete(i);
    if (slots.length === 0 && fullContent.includes("<function=")) {
      let index = 0;
      for (const call of parseXmlToolCalls(fullContent).calls) {
        yield { type: "tool_call_complete", index: index++, id: "", name: call.name, arguments: JSON.stringify(coerceXmlArgs(call.args)) };
      }
    }
    logDebugEntry({ baseUrl: this.options.baseUrl, model: this.options.model, requestBody, responseStatus: response.status, responseText: raw.join("\n") });
    yield { type: "message_complete", ...(finishReason ? { finishReason } : {}) };
  }
}

function toToolsPayload(tools: ProviderToolDef[]): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map((tool) => {
    assertCanonicalToolName(tool.name);
    return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
  });
}

function toOpenAiMessages(messages: ProviderMessage[]): OpenAiChatMessage[] {
  return messages.map((entry): OpenAiChatMessage => {
    if (entry.role === "user") return { role: "user", content: entry.text };
    if (entry.role === "context") return { role: "system", content: entry.text };
    if (entry.role === "tool") return { role: "tool", tool_call_id: entry.toolCallId, content: entry.text };
    const toolCalls = (entry.toolCalls ?? []).flatMap((call) => {
      const name = canonicalToolName(call.name);
      return name ? [{ id: call.id, type: "function" as const, function: { name, arguments: call.arguments } }] : [];
    });
    return {
      role: "assistant",
      content: entry.text ?? null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    };
  });
}

type OpenAiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
};

function usageEvent(usage: OpenAiUsage): Extract<ProviderStreamEvent, { type: "usage" }> {
  return {
    type: "usage",
    ...(usage.prompt_tokens !== undefined ? { inputTokens: usage.prompt_tokens } : {}),
    ...(usage.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
    ...(usage.prompt_tokens_details?.cached_tokens !== undefined ? { cachedInputTokens: usage.prompt_tokens_details.cached_tokens } : {}),
    ...(usage.prompt_tokens_details?.cache_write_tokens !== undefined ? { cacheWriteInputTokens: usage.prompt_tokens_details.cache_write_tokens } : {})
  };
}

function hasUsage(usage: OpenAiUsage | undefined): usage is OpenAiUsage {
  return usage?.prompt_tokens !== undefined
    || usage?.completion_tokens !== undefined
    || usage?.prompt_tokens_details?.cached_tokens !== undefined
    || usage?.prompt_tokens_details?.cache_write_tokens !== undefined;
}

function supportsPromptCacheKey(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

export function parseXmlToolCalls(content: string): { prefix: string; calls: Array<{ name: string; args: Record<string, string> }> } {
  const tagIndex = content.indexOf("<function=");
  const beforeTag = tagIndex >= 0 ? content.slice(0, tagIndex) : content;
  const prefix = beforeTag.replace(/<\/?tool_call>/g, "").trim();
  const calls: Array<{ name: string; args: Record<string, string> }> = [];
  for (const functionMatch of content.matchAll(XML_FUNCTION_PATTERN)) {
    const name = functionMatch[1]?.trim();
    if (!name) continue;
    const body = functionMatch[2] ?? "";
    const args: Record<string, string> = {};
    for (const paramMatch of body.matchAll(XML_PARAMETER_PATTERN)) {
      const key = paramMatch[1]?.trim();
      if (!key) continue;
      args[key] = (paramMatch[2] ?? "").trim();
    }
    calls.push({ name, args });
  }
  return { prefix, calls };
}

export function coerceXmlArgs(args: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = coerceXmlArgValue(value);
  return out;
}

function coerceXmlArgValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try { return JSON.parse(trimmed); } catch { return value; }
  }
  return value;
}
