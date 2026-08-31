import { loadGlobalConfig } from "./global-config";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_STEPS, DEFAULT_MAX_TURN_SECONDS, DEFAULT_MODEL_BASE_URL, DEFAULT_MODEL_ID, DEFAULT_MODEL_PUBLIC_API_KEY } from "./default-model";
import type { ModelPricingSnapshot } from "../types";
import { discardResponseBody, readBoundedResponseJson } from "../http-response";

export const HEURISTIC_MODEL_ID = "heuristic";
const MODEL_DISCOVERY_TIMEOUT_MS = 4_000;
const MODEL_DISCOVERY_MAX_BYTES = 8 * 1024 * 1024;
const MAX_CONTEXT_SAFETY_TOKENS = 13_000;

export type ResolvedModel = {
  name?: string;
  baseUrl: string;
  model?: string;
  apiKey?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  protocol?: string;
  pricing?: ModelPricingSnapshot;
};

export type ConcreteResolvedModel = ResolvedModel & { model: string };

export function resolveDefaultModel(): ResolvedModel {
  return resolveModel({});
}

export function resolveModel(input: { baseUrl?: string; model?: string; apiKey?: string } = {}): ResolvedModel {
  const config = loadGlobalConfig();
  const baseUrl = input.baseUrl ?? config.baseUrl ?? DEFAULT_MODEL_BASE_URL;
  const model = input.model ?? config.model ?? DEFAULT_MODEL_ID;
  const apiKey = input.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined) ?? (baseUrl === DEFAULT_MODEL_BASE_URL ? DEFAULT_MODEL_PUBLIC_API_KEY : undefined);
  return { baseUrl, ...(model ? { model } : {}), ...(apiKey ? { apiKey } : {}) };
}

export function resolveContextWindow(modelContextWindow?: number): number {
  return modelContextWindow ?? loadGlobalConfig().contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

export function resolveMaxOutputTokens(modelMaxOutputTokens?: number): number {
  const requested = loadGlobalConfig().maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.floor(Math.min(requested, positiveTokenCount(modelMaxOutputTokens) ?? requested));
}

export function resolveRequestMaxOutputTokens(input: {
  contextWindow?: number;
  estimatedInputTokens?: number;
  modelMaxOutputTokens?: number;
  requestedMaxOutputTokens?: number;
}): number {
  const contextWindow = resolveContextWindow(input.contextWindow);
  const estimatedInputTokens = Math.floor(positiveTokenCount(input.estimatedInputTokens) ?? 0);
  const modelLimit = positiveTokenCount(input.modelMaxOutputTokens) ?? Number.POSITIVE_INFINITY;
  const requested = positiveTokenCount(input.requestedMaxOutputTokens)
    ?? resolveMaxOutputTokens(input.modelMaxOutputTokens);
  const safety = Math.min(MAX_CONTEXT_SAFETY_TOKENS, Math.max(1, Math.floor(contextWindow * 0.15)));
  const contextAvailable = Math.max(1, contextWindow - estimatedInputTokens - safety);
  return Math.max(1, Math.floor(Math.min(requested, modelLimit, contextAvailable)));
}

export function resolveMaxSteps(configuredMaxSteps?: number): number {
  return Math.floor(configuredMaxSteps ?? DEFAULT_MAX_STEPS);
}

export function resolveMaxTurnMs(configuredMaxTurnSeconds?: number): number {
  return (configuredMaxTurnSeconds ?? DEFAULT_MAX_TURN_SECONDS) * 1_000;
}

export async function fetchAvailableModelIds(
  baseUrl: string,
  apiKey?: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; protocol?: string; signal?: AbortSignal } = {}
): Promise<string[] | undefined> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("model discovery request timed out")),
    Math.max(1, options.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS)
  );
  try {
    const protocol = modelDiscoveryProtocol(baseUrl, options.protocol);
    const response = await (options.fetchImpl ?? globalThis.fetch)(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: protocol === "anthropic-messages"
        ? {
            "anthropic-version": "2023-06-01",
            ...(apiKey ? { "x-api-key": apiKey } : {})
          }
        : apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal
    });
    if (!response.ok) {
      await discardResponseBody(response);
      return undefined;
    }
    return modelIDsFromDiscoveryResponse(await readBoundedResponseJson(response, MODEL_DISCOVERY_MAX_BYTES, "model discovery response"));
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

function modelDiscoveryProtocol(baseUrl: string, configured?: string): "openai-chat" | "anthropic-messages" {
  const explicit = configured?.trim().toLowerCase();
  if (explicit === "anthropic" || explicit === "anthropic-messages") return "anthropic-messages";
  if (explicit === "openai" || explicit === "openai-chat") return "openai-chat";
  try {
    if (new URL(baseUrl).hostname.toLowerCase().includes("anthropic.com")) return "anthropic-messages";
  } catch { }
  return "openai-chat";
}

function modelIDsFromDiscoveryResponse(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { data?: unknown; models?: unknown };
  const entries = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : Array.isArray(value)
        ? value
        : undefined;
  if (!entries) return undefined;
  return [...new Set(entries.flatMap((entry) => {
    if (typeof entry === "string") return entry.trim() ? [entry.trim()] : [];
    if (!entry || typeof entry !== "object") return [];
    const id = (entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  }))];
}

function positiveTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
