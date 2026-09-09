import { loadGlobalConfig } from "./global-config";

export const DEFAULT_SOURCE_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_SOURCE_MODEL = "openrouter/free";
export const DEFAULT_SOURCE_CONTEXT_WINDOW = 200_000;

// yes this is the key, i dont care. use it as you want
const DEFAULT_SOURCE_KEY_B64 = "c2stb3ItdjEtODM0NDYyZDI2YWMzODFkMDc5ZWI3N2Q1NTM2YWU0MTc2NWIyMGNhNWFiMzQ1YmEwNTJjNjU4ZTRhOWQ3ZGYzYQ==";

export function defaultSourceKey(): string {
  return Buffer.from(DEFAULT_SOURCE_KEY_B64, "base64").toString("utf8");
}

export function isDefaultMode(): boolean {
  const config = loadGlobalConfig();
  return !config.baseUrl && !config.apiKeyEnv;
}
