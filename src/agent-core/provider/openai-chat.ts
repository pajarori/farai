import { resolveRequestMaxOutputTokens } from "../model-registry";
import { estimateChatRequestInputTokens, type ChatProvider, type ChatRequest, type ProviderMessage, type ProviderStreamEvent, type ProviderToolDef } from "./protocol";
import { assertCanonicalToolName, canonicalToolName } from "../../tool-names";
import { createProviderDebugCapture, iterateSseData, logDebugEntry, parseRetryAfterMs, planRequestSignal, providerHttpError, readResponseTextBounded, readResponseTextPreview } from "./http";
import { BoundedTextAccumulator, PROVIDER_ERROR_BODY_MAX_BYTES, providerResponseLimits, type ProviderResponseLimits } from "./stream-bounds";
import type { ModelPricingSnapshot } from "../../types";
import { materializeToolAttachment } from "../../tool-attachment";
import { OPENAI_REQUEST_LIMITS, prepareProviderMessages, serializeProviderRequestBody } from "./request-bounds";

type OpenAiContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type OpenAiChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OpenAiContentPart[] }
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
    const messages = prepareProviderMessages(request.messages, OPENAI_REQUEST_LIMITS);
    const toolsPayload = toToolsPayload(request.tools);
    const requestMaxOutputTokens = resolveRequestMaxOutputTokens({
      estimatedInputTokens: estimateChatRequestInputTokens({ ...request, messages }),
      ...(this.options.contextWindow !== undefined ? { contextWindow: this.options.contextWindow } : {}),
      ...(this.options.maxOutputTokens !== undefined ? { modelMaxOutputTokens: this.options.maxOutputTokens } : {}),
      ...(request.maxOutputTokens !== undefined ? { requestedMaxOutputTokens: request.maxOutputTokens } : {})
    });
    const limits = providerResponseLimits(requestMaxOutputTokens);
    const requestBody = {
      model: this.options.model,
      temperature: request.temperature ?? 0.2,
      max_tokens: requestMaxOutputTokens,
      user: request.sessionId,
      stream: true,
      stream_options: { include_usage: true },
      ...(supportsPromptCacheKey(this.options.baseUrl) && request.promptCacheKey ? { prompt_cache_key: request.promptCacheKey } : {}),
      ...(toolsPayload.length > 0 ? { tools: toolsPayload, tool_choice: request.toolChoice ?? "auto" } : {}),
      messages: [
        { role: "system", content: request.system },
        ...toOpenAiMessages(messages)
      ]
    };
    const requestJson = serializeProviderRequestBody(requestBody, OPENAI_REQUEST_LIMITS.bodyBytes, "openai-compatible provider request");
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {})
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
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      yield* this.streamSse(response, requestBody, limits);
    } else {
      yield* this.streamBuffered(response, requestBody, limits);
    }
  }

  private async *streamBuffered(response: Response, requestBody: unknown, limits: ProviderResponseLimits): AsyncIterable<ProviderStreamEvent> {
    const rawText = await readResponseTextBounded(response, limits.bufferedBodyBytes, "provider buffered response");
    logDebugEntry({ baseUrl: this.options.baseUrl, model: this.options.model, requestBody, responseStatus: response.status, responseText: rawText });
    let json: { choices?: Array<{ message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>; usage?: OpenAiUsage };
    try { json = JSON.parse(rawText); } catch { yield { type: "error", message: `Planner provider returned non-JSON body: ${rawText.slice(0, 500)}` }; return; }
    if (hasUsage(json.usage)) {
      yield usageEvent(json.usage);
    }
    const choice = json.choices?.[0];
    const message = choice?.message;
    const reasoning = typeof message?.reasoning === "string" ? message.reasoning : typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
    if (reasoning) {
      new BoundedTextAccumulator(limits.reasoningBytes, "provider reasoning").append(reasoning);
      yield { type: "reasoning_delta", delta: reasoning };
    }
    const content = typeof message?.content === "string" ? message.content : "";
    if (content) {
      new BoundedTextAccumulator(limits.contentBytes, "provider content").append(content);
      yield { type: "text_delta", delta: content };
    }
    const nativeCalls = message?.tool_calls ?? [];
    if (nativeCalls.length > limits.toolCalls) throw new Error(`provider response exceeded the ${limits.toolCalls}-tool-call limit`);
    let index = 0;
    if (nativeCalls.length > 0) {
      for (const call of nativeCalls) {
        const name = call.function?.name;
        if (!name) continue;
        const argumentsText = call.function?.arguments ?? "{}";
        new BoundedTextAccumulator(limits.toolArgumentsBytes, "provider tool arguments").append(argumentsText);
        yield { type: "tool_call_complete", index: index++, id: call.id ?? "", name, arguments: argumentsText };
      }
    } else if (content.includes("<function=")) {
      for (const call of parseXmlToolCalls(content).calls) {
        yield { type: "tool_call_complete", index: index++, id: "", name: call.name, arguments: JSON.stringify(coerceXmlArgs(call.args)) };
      }
    }
    yield { type: "message_complete", ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}) };
  }

  private async *streamSse(response: Response, requestBody: unknown, limits: ProviderResponseLimits): AsyncIterable<ProviderStreamEvent> {
    const fullContent = new BoundedTextAccumulator(limits.contentBytes, "provider content", limits.sseEvents);
    const reasoning = new BoundedTextAccumulator(limits.reasoningBytes, "provider reasoning", limits.sseEvents);
    let suppressText = false;
    let xmlProbe = "";
    let finishReason: string | undefined;
    const slots: Array<{ id?: string; name: string; arguments: BoundedTextAccumulator; emitted?: boolean }> = [];
    let activeIndex = -1;
    const capture = createProviderDebugCapture();

    const emitComplete = function* (idx: number): Iterable<ProviderStreamEvent> {
      const slot = slots[idx];
      if (!slot || slot.emitted || !slot.name) return;
      slot.emitted = true;
      yield { type: "tool_call_complete", index: idx, id: slot.id ?? "", name: slot.name, arguments: slot.arguments.text() || "{}" };
    };

    try {
      for await (const data of iterateSseData(response, limits, capture)) {
        if (!data) continue;
        if (data === "[DONE]") break;
        let chunk: { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>; usage?: OpenAiUsage };
        try { chunk = JSON.parse(data); } catch { throw new Error("provider returned malformed sse json"); }
        if (hasUsage(chunk.usage)) {
          yield usageEvent(chunk.usage);
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) {
          fullContent.append(delta.content);
          xmlProbe = `${xmlProbe}${delta.content}`.slice(-64);
          if (!suppressText && xmlProbe.includes("<function=")) suppressText = true;
          else if (!suppressText) yield { type: "text_delta", delta: delta.content };
        }
        const reasoningDelta = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
        if (reasoningDelta) {
          reasoning.append(reasoningDelta);
          yield { type: "reasoning_delta", delta: reasoningDelta };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const rawCall of delta.tool_calls) {
            const call = rawCall as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
            const idx = typeof call.index === "number" ? call.index : slots.length ? slots.length - 1 : 0;
            if (!Number.isInteger(idx) || idx < 0 || idx >= limits.toolCalls) throw new Error(`provider tool call index must be between 0 and ${limits.toolCalls - 1}`);
            if (idx !== activeIndex && activeIndex >= 0) yield* emitComplete(activeIndex);
            activeIndex = idx;
            const slot = (slots[idx] ??= { name: "", arguments: new BoundedTextAccumulator(limits.toolArgumentsBytes, "provider tool arguments", limits.sseEvents) });
            if (call.id) slot.id = call.id;
            if (call.function?.name) slot.name = call.function.name;
            const argChunk = call.function?.arguments;
            if (typeof argChunk === "string") {
              slot.arguments.append(argChunk);
              yield { type: "tool_call_delta", index: idx, ...(call.id ? { id: call.id } : {}), ...(call.function?.name ? { name: call.function.name } : {}), argumentsDelta: argChunk };
            } else if (call.id || call.function?.name) {
              yield { type: "tool_call_delta", index: idx, ...(call.id ? { id: call.id } : {}), ...(call.function?.name ? { name: call.function.name } : {}) };
            }
          }
        }
      }
    } finally {
      logDebugEntry({ baseUrl: this.options.baseUrl, model: this.options.model, requestBody, responseStatus: response.status, responseText: capture?.text() ?? "" });
    }

    for (let i = 0; i < slots.length; i++) yield* emitComplete(i);
    const content = fullContent.text();
    if (slots.length === 0 && content.includes("<function=")) {
      let index = 0;
      for (const call of parseXmlToolCalls(content).calls) {
        if (index >= limits.toolCalls) throw new Error(`provider response exceeded the ${limits.toolCalls}-tool-call limit`);
        yield { type: "tool_call_complete", index: index++, id: "", name: call.name, arguments: JSON.stringify(coerceXmlArgs(call.args)) };
      }
    }
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
  const out: OpenAiChatMessage[] = [];
  const pendingToolImages: import("../../types").ToolAttachment[] = [];
  const flushToolImages = (): void => {
    if (!pendingToolImages.length) return;
    out.push({ role: "user", content: openAiUserContent("images returned by the preceding tools", pendingToolImages.splice(0)) });
  };
  for (const entry of messages) {
    if (entry.role === "user") {
      flushToolImages();
      out.push({ role: "user", content: openAiUserContent(entry.text, entry.attachments) });
      continue;
    }
    if (entry.role === "context") {
      flushToolImages();
      out.push({ role: "system", content: entry.text });
      continue;
    }
    if (entry.role === "tool") {
      out.push({ role: "tool", tool_call_id: entry.toolCallId, content: entry.text });
      if (entry.attachments?.length) pendingToolImages.push(...entry.attachments);
      continue;
    }
    flushToolImages();
    const toolCalls = (entry.toolCalls ?? []).flatMap((call) => {
      const name = canonicalToolName(call.name);
      return name ? [{ id: call.id, type: "function" as const, function: { name, arguments: call.arguments } }] : [];
    });
    out.push({
      role: "assistant",
      content: entry.text ?? null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    });
  }
  flushToolImages();
  return out;
}

function openAiUserContent(text: string, attachments: import("../../types").ToolAttachment[] | undefined): string | OpenAiContentPart[] {
  if (!attachments?.length) return text;
  return [
    { type: "text", text },
    ...attachments.map(materializeToolAttachment).map((item): OpenAiContentPart => ({
      type: "image_url",
      image_url: {
        url: `data:${item.mediaType};base64,${item.data}`,
        ...(item.detail ? { detail: item.detail } : {})
      }
    }))
  ];
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
