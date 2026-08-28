import type { FaraiLspConfig } from "../agent-core/config";
import { LSP_SERVER_DEFINITIONS } from "./registry";
import type { LspServerId } from "./types";

export type ResolvedLspConfig = {
  enabled: boolean;
  waitTimeoutMs: number;
  servers: Record<LspServerId, { enabled: boolean; command: string[]; env: Record<string, string> }>;
};

export function resolveLspConfig(config?: FaraiLspConfig): ResolvedLspConfig {
  const servers = {} as ResolvedLspConfig["servers"];
  for (const id of Object.keys(LSP_SERVER_DEFINITIONS) as LspServerId[]) {
    const override = config?.servers?.[id];
    servers[id] = {
      enabled: override?.enabled !== false,
      command: override?.command?.length ? [...override.command] : [...LSP_SERVER_DEFINITIONS[id].command],
      env: { ...override?.env }
    };
  }
  return {
    enabled: config?.enabled !== false,
    waitTimeoutMs: config?.waitTimeoutMs ?? 3_000,
    servers
  };
}
