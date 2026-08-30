import { loadConfig, localFaraiDir, globalDataDir, debugLogPath, isDebugLoggingEnabled, configPath, ensureDefaultConfig } from "./config";

export { localFaraiDir, globalDataDir, debugLogPath, isDebugLoggingEnabled } from "./config";

export type FaraiGlobalConfig = {
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  maxConcurrentSubagents?: number;
  maxSteps?: number;
  maxTurnSeconds?: number;
};

export function globalConfigDir(): string {
  return localFaraiDir();
}

export function globalConfigPath(): string {
  return configPath("global");
}

export function globalInstructionDirs(): string[] {
  return [globalConfigDir(), globalDataDir()];
}

export function ensureDefaultUserConfig(): void {
  ensureDefaultConfig();
}

export function loadGlobalConfig(): FaraiGlobalConfig {
  const config = loadConfig();
  return {
    ...(config.model ? { model: config.model } : {}),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiKeyEnv ? { apiKeyEnv: config.apiKeyEnv } : {}),
    ...(config.contextWindow ? { contextWindow: config.contextWindow } : {}),
    ...(config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {}),
    ...(config.maxConcurrentSubagents ? { maxConcurrentSubagents: config.maxConcurrentSubagents } : {}),
    ...(config.maxSteps ? { maxSteps: config.maxSteps } : {}),
    ...(config.maxTurnSeconds ? { maxTurnSeconds: config.maxTurnSeconds } : {})
  };
}
