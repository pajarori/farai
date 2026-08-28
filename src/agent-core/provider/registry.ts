import { HEURISTIC_MODEL_ID, type ConcreteResolvedModel } from "../model-registry";
import type { ChatProvider, ProviderProtocol } from "./protocol";
import { OpenAiChatProvider } from "./openai-chat";
import { AnthropicMessagesProvider } from "./anthropic-messages";
import { HeuristicProvider } from "./heuristic";

export function createChatProvider(resolved: ConcreteResolvedModel): ChatProvider {
  if (resolved.model === HEURISTIC_MODEL_ID) return new HeuristicProvider();
  const options = {
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    pricing: resolved.pricing,
    contextWindow: resolved.contextWindow,
    maxOutputTokens: resolved.maxOutputTokens
  };
  return resolveProtocol(resolved) === "anthropic-messages"
    ? new AnthropicMessagesProvider(options)
    : new OpenAiChatProvider(options);
}

export function resolveProtocol(resolved: { baseUrl: string; protocol?: string }): ProviderProtocol {
  const explicit = resolved.protocol?.toLowerCase();
  if (explicit === "anthropic" || explicit === "anthropic-messages") return "anthropic-messages";
  if (explicit === "openai" || explicit === "openai-chat") return "openai-chat";
  try {
    if (new URL(resolved.baseUrl).hostname.includes("anthropic.com")) return "anthropic-messages";
  } catch {  }
  return "openai-chat";
}
