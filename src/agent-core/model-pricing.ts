import type { ModelPricingSnapshot } from "../types";
import type { ProviderProtocol } from "./provider/protocol";

export type UsageTokenCounts = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
};

export type NormalizedUsageTokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
};

export function normalizeUsageTokenCounts(usage: UsageTokenCounts, protocol: ProviderProtocol): NormalizedUsageTokenCounts {
  const input = nonNegative(usage.inputTokens ?? 0);
  const output = nonNegative(usage.outputTokens ?? 0);
  const cached = nonNegative(usage.cachedInputTokens ?? 0);
  const cacheWrite = nonNegative(usage.cacheWriteInputTokens ?? 0);
  return {
    inputTokens: protocol === "anthropic-messages" ? input + cached + cacheWrite : input,
    outputTokens: output,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite
  };
}

export function calculateUsageCost(usage: UsageTokenCounts, pricing: ModelPricingSnapshot, protocol: ProviderProtocol): number {
  const input = nonNegative(usage.inputTokens ?? 0);
  const output = nonNegative(usage.outputTokens ?? 0);
  const cached = nonNegative(usage.cachedInputTokens ?? 0);
  const cacheWrite = nonNegative(usage.cacheWriteInputTokens ?? 0);
  const uncached = protocol === "anthropic-messages" ? input : Math.max(0, input - cached - cacheWrite);
  const cacheReadRate = pricing.cacheReadPerMillion ?? pricing.inputPerMillion;
  const cacheWriteRate = pricing.cacheWritePerMillion ?? pricing.inputPerMillion;
  return (
    uncached * pricing.inputPerMillion
    + output * pricing.outputPerMillion
    + cached * cacheReadRate
    + cacheWrite * cacheWriteRate
  ) / pricing.unitTokens;
}

export function estimateMaximumRequestCost(inputTokens: number, outputTokens: number, pricing: ModelPricingSnapshot): number {
  return (
    nonNegative(inputTokens) * pricing.inputPerMillion
    + nonNegative(outputTokens) * pricing.outputPerMillion
  ) / pricing.unitTokens;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
