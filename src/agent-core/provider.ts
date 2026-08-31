import { createHash } from "node:crypto";
import type { Session, ToolAttachment, ToolDefinition } from "../types";
import { getTool } from "../agent-tools/registry";
import { canonicalToolName } from "../tool-names";
import { HEURISTIC_MODEL_ID, resolveDefaultModel, resolveModel, type ConcreteResolvedModel, type ResolvedModel } from "./model-registry";
import { lookupModelsDevPricing, resolveModelSelection } from "./model-catalog";
import { loadModelProfiles, resolveProfile } from "./model-profiles";
import { takeBytes } from "../agent-tools/shared/output-bound";
import type { PlannerContextBlock } from "./context-builder";
import { buildSystemPromptBlocks } from "./provider/system-prompt";
import { assembleStream, ProviderStreamError, type AssembledMessage, type ChatProvider, type ChatRequest, type ProviderMessage, type ProviderStreamEvent, type ProviderToolDef } from "./provider/protocol";
import { providerResponseLimits } from "./provider/stream-bounds";
import { toolAttachmentBytes } from "../tool-attachment";
import { OpenAiChatProvider, parseXmlToolCalls } from "./provider/openai-chat";
import { AnthropicMessagesProvider } from "./provider/anthropic-messages";
import { createChatProvider, resolveProtocol } from "./provider/registry";
import { computeHeuristicActions } from "./provider/heuristic";

export { createChatProvider } from "./provider/registry";

const REASONING_MAX_BYTES = 8 * 1024;

export type PlannerAction =
  | { kind: "respond"; text: string; truncated?: boolean; recoverable?: boolean }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; tool: string; args: unknown; rationale: string; toolCallId?: string }
  | { kind: "tool_parse_error"; tool: string; toolCallId: string; rawArguments: string; error: string };

export type ConversationEntry =
  | { role: "user"; text: string; attachments?: ToolAttachment[] }
  | { role: "context"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: Array<{ id: string; tool: string; args: unknown }> }
  | { role: "tool"; toolCallId: string; tool: string; text: string; attachments?: ToolAttachment[] };

export type PlannerInput = {
  session: Session;
  userText?: string;
  history: ConversationEntry[];
  compactedSummary?: string;
  contextBlocks?: PlannerContextBlock[];
  systemInstruction?: string;
  tools: string[];
  toolCatalog?: ProviderToolDef[];
  toolChoice?: "auto" | "none";
};

export type PlanStreamEvent = { kind: "text" | "reasoning"; delta: string };

export type PlanOptions = {
  signal?: AbortSignal;
  onStreamEvent?: (event: PlanStreamEvent) => void;
};

export interface PlannerProvider {
  name: string;
  compactionMode?: "model" | "deterministic";
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  plan(input: PlannerInput, options?: PlanOptions): Promise<PlannerAction[]>;
}

export class PlannerHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = "PlannerHttpError";
  }
}

export class HeuristicPlanner implements PlannerProvider {
  name = "heuristic";
  compactionMode = "deterministic" as const;

  async plan(input: PlannerInput): Promise<PlannerAction[]> {
    const lastTool = [...input.history].reverse().find((entry): entry is Extract<ConversationEntry, { role: "tool" }> => entry.role === "tool");
    const actions = computeHeuristicActions({
      ...(input.userText ? { userText: input.userText } : {}),
      ...(lastTool ? { lastTool: { tool: lastTool.tool, text: lastTool.text } } : {}),
      ...(input.compactedSummary ? { compactedSummary: input.compactedSummary } : {})
    });
    return actions.map((action): PlannerAction =>
      action.kind === "respond"
        ? { kind: "respond", text: action.text }
        : { kind: "tool", tool: action.tool, args: action.args, rationale: action.rationale }
    );
  }
}

export function buildToolsPayload(toolNames: string[], availableTools?: ToolDefinition[]): ProviderToolDef[] {
  const payload: ProviderToolDef[] = [];
  const available = availableTools ? new Map(availableTools.map((tool) => [tool.name, tool])) : undefined;
  for (const name of [...new Set(toolNames.map(canonicalToolName))].sort()) {
    const tool = available?.get(name) ?? getTool(name);
    if (!tool) continue;
    payload.push({ name: tool.name, description: tool.description, parameters: tool.inputSchema });
  }
  return payload;
}

export class ChatProviderPlanner implements PlannerProvider {
  readonly name: string;
  readonly compactionMode = "model" as const;
  readonly contextWindow: number | undefined;
  readonly maxOutputTokens: number | undefined;

  constructor(protected readonly provider: ChatProvider) {
    this.name = provider.name;
    this.contextWindow = provider.contextWindow;
    this.maxOutputTokens = provider.maxOutputTokens;
  }

  async plan(input: PlannerInput, options?: PlanOptions): Promise<PlannerAction[]> {
    const request = buildChatRequest(input, options?.signal);
    const onEvent = options?.onStreamEvent
      ? (event: ProviderStreamEvent) => {
          if (event.type === "text_delta") options.onStreamEvent!({ kind: "text", delta: event.delta });
          else if (event.type === "reasoning_delta") options.onStreamEvent!({ kind: "reasoning", delta: event.delta });
        }
      : undefined;
    let assembled: AssembledMessage;
    try {
      assembled = await assembleStream(this.provider.stream(request), onEvent, providerResponseLimits(this.provider.maxOutputTokens));
    } catch (error) {
      if (error instanceof ProviderStreamError && error.status !== undefined) {
        throw new PlannerHttpError(error.message, error.status, error.retryAfterMs);
      }
      throw error;
    }
    return actionsFromMessage(assembled);
  }
}

export class OpenAICompatiblePlanner extends ChatProviderPlanner {
  constructor(options: { apiKey?: string; baseUrl: string; model: string; contextWindow?: number; maxOutputTokens?: number }) {
    super(new OpenAiChatProvider({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      baseUrl: options.baseUrl,
      model: options.model,
      ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
      ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {})
    }));
  }
}

export class AnthropicPlanner extends ChatProviderPlanner {
  constructor(options: { apiKey?: string; baseUrl: string; model: string; contextWindow?: number; maxOutputTokens?: number }) {
    super(new AnthropicMessagesProvider({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      baseUrl: options.baseUrl,
      model: options.model,
      ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
      ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {})
    }));
  }
}

export function buildChatRequest(input: PlannerInput, signal?: AbortSignal): ChatRequest {
  const systemBlocks = buildSystemPromptBlocks(input);
  return {
    model: input.session.model ?? "",
    system: systemBlocks.map((block) => block.text).join("\n\n"),
    systemBlocks,
    messages: toProviderMessages(input.history),
    tools: input.toolCatalog ?? buildToolsPayload(input.tools),
    toolChoice: input.toolChoice ?? "auto",
    promptCacheKey: promptCacheKey(input.session),
    sessionId: input.session.id,
    ...(signal ? { signal } : {})
  };
}

export function toProviderMessages(history: ConversationEntry[]): ProviderMessage[] {
  return history.map((entry): ProviderMessage => {
    if (entry.role === "user") return { role: "user", text: entry.text, ...(entry.attachments?.length ? { attachments: entry.attachments } : {}) };
    if (entry.role === "context") return { role: "context", text: entry.text };
    if (entry.role === "tool") {
      return {
        role: "tool",
        toolCallId: entry.toolCallId,
        name: entry.tool,
        text: entry.text,
        ...(entry.attachments?.length ? { attachments: entry.attachments } : {})
      };
    }
    return {
      role: "assistant",
      ...(entry.text !== undefined ? { text: entry.text } : {}),
      ...(entry.toolCalls?.length
        ? { toolCalls: entry.toolCalls.map((call) => ({ id: call.id, name: call.tool, arguments: JSON.stringify(call.args) })) }
        : {})
    };
  });
}

export function estimateProviderMessagesTokens(messages: ProviderMessage[]): number {
  let imageTokens = 0;
  const withoutImageData = messages.map((entry) => {
    if ((entry.role !== "user" && entry.role !== "tool") || !entry.attachments?.length) return entry;
    imageTokens += entry.attachments.reduce((total, attachment) => total + imageTokenEstimate(attachment.detail), 0);
    return {
      ...entry,
      attachments: entry.attachments.map((attachment) => ({
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        ...(attachment.name ? { name: attachment.name } : {}),
        ...(attachment.detail ? { detail: attachment.detail } : {}),
        bytes: toolAttachmentBytes(attachment)
      }))
    };
  });
  return Math.ceil(Buffer.byteLength(JSON.stringify(withoutImageData), "utf8") / 4) + imageTokens;
}

export function estimateConversationEntriesTokens(history: ConversationEntry[]): number {
  return estimateProviderMessagesTokens(toProviderMessages(history));
}

function imageTokenEstimate(detail: ToolAttachment["detail"]): number {
  if (detail === "low") return 85;
  if (detail === "high") return 765;
  return 512;
}

export function promptCacheKey(session: Session): string {
  const workspace = createHash("sha256").update(session.workspace).digest("hex").slice(0, 12);
  const prompt = buildSystemPromptBlocks({ session }).filter((block) => block.cacheable).map((block) => block.text).join("\n\n");
  const promptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
  return `${promptHash}:${workspace}:${session.id}`;
}

export function actionsFromMessage(message: AssembledMessage): PlannerAction[] {
  const finishReason = message.finishReason;
  const actions: PlannerAction[] = [];
  const reasoningText = message.reasoning.trim() ? takeBytes(message.reasoning.trim(), REASONING_MAX_BYTES, "head") : undefined;
  if (reasoningText) actions.push({ kind: "reasoning", text: reasoningText });

  const content = message.content;
  const respondText = content.includes("<function=") ? parseXmlToolCalls(content).prefix : content.trim();
  if (respondText) actions.push({ kind: "respond", text: respondText, ...(finishReason === "length" ? { truncated: true } : {}) });

  for (const call of message.toolCalls) {
    const name = call.name;
    if (!name) continue;
    const raw = call.arguments || "{}";
    try {
      const parsed = JSON.parse(raw) as unknown;
      const args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      actions.push({ kind: "tool", tool: name, args, rationale: "", ...(call.id ? { toolCallId: call.id } : {}) });
    } catch (error) {
      actions.push({
        kind: "tool_parse_error",
        tool: name,
        toolCallId: call.id ?? name,
        rawArguments: raw,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const hasVisibleAction = actions.some((action) => action.kind !== "reasoning");
  if (!hasVisibleAction) {
    if (reasoningText) {
      return [{ kind: "respond", text: reasoningText, recoverable: true, ...(finishReason === "length" ? { truncated: true } : {}) }];
    }
    throw new Error(
      `Planner returned empty output: no content and no tool_calls (finish_reason=${finishReason ?? "unknown"}). ` +
        `Raw message: ${JSON.stringify(message).slice(0, 1000)}`
    );
  }
  return actions;
}

export function createPlannerForSession(session: Session, configWorkspace = session.workspace): PlannerProvider {
  if (!session.model) return createPlannerFromResolved(requireConcreteModel(resolveDefaultModel()));
  const profiles = loadModelProfiles(configWorkspace);
  const profileResolved = resolveProfile(profiles, session.model);
  const resolved = profileResolved ?? resolveModel({ model: session.model });
  return createPlannerFromResolved({ ...requireConcreteModel(resolved), name: session.model });
}

export async function createPlannerForSessionAsync(session: Session, configWorkspace = session.workspace): Promise<PlannerProvider> {
  const resolved = await resolveModelSelection(configWorkspace, session.model);
  return createPlannerFromResolved({ ...resolved, name: session.model ?? resolved.name ?? resolved.model });
}

export async function createChatProviderForSession(session: Session, configWorkspace = session.workspace): Promise<ChatProvider> {
  const resolved = await resolveModelSelection(configWorkspace, session.model);
  const pricing = resolved.pricing ?? await lookupModelsDevPricing(resolved.model, session.provider, resolved.baseUrl);
  const named = { ...resolved, name: session.model ?? resolved.name ?? resolved.model };
  return createChatProvider(pricing ? { ...named, pricing } : named);
}

function createPlannerFromResolved(resolved: ConcreteResolvedModel): PlannerProvider {
  if (resolved.model === HEURISTIC_MODEL_ID) return new HeuristicPlanner();
  const options = {
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    ...(resolved.name ? { name: resolved.name } : {}),
    ...(resolved.contextWindow ? { contextWindow: resolved.contextWindow } : {}),
    ...(resolved.maxOutputTokens ? { maxOutputTokens: resolved.maxOutputTokens } : {})
  };
  return resolveProtocol(resolved) === "anthropic-messages" ? new AnthropicPlanner(options) : new OpenAICompatiblePlanner(options);
}

function requireConcreteModel(resolved: ResolvedModel): ConcreteResolvedModel {
  if (!resolved.model) {
    throw new Error("No planner model configured. Choose one from /model or configure ~/.local/pajarori/farai/config.toml.");
  }
  return resolved as ConcreteResolvedModel;
}
