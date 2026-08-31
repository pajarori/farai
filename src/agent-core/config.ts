import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { MCP_BACKBONE_SERVER_IDS } from "../agent-tools/mcp-builtins";
import { readCredentialForWorkspaceSync } from "./credential-store";
import { atomicWriteFile } from "./atomic-file";
import { configPath, localFaraiDir, type ConfigLocation } from "./paths";
import { isEnvironmentVariableName } from "./model-provider-validation";

export { authPath, configPath, debugLogPath, globalDataDir, localFaraiDir } from "./paths";
export type { ConfigLocation } from "./paths";
export { loadAuth, readAuth, removeAuthEntry, writeAuthEntry } from "./legacy-auth";
export type { AuthEntry, FaraiAuth } from "./legacy-auth";

export type FaraiConfig = {
  configVersion?: number;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  maxConcurrentSubagents?: number;
  maxSteps?: number;
  maxTurnSeconds?: number;
  maxCostUsd?: number;
  recentModels?: string[];
  modelLimits?: Record<string, FaraiModelLimitConfig>;
  modelProviders?: Record<string, Record<string, unknown>>;
  mcpServers?: Record<string, Record<string, unknown>>;
  emailAccounts?: Record<string, Record<string, unknown>>;
  proxy?: FaraiProxyConfig;
  context?: FaraiContextConfig;
  lsp?: FaraiLspConfig;
  web?: FaraiWebConfig;
};

export type FaraiWebConfig = {
  searchBackend?: "auto" | "duckduckgo" | "yahoo" | "bing" | "searxng";
  searxngUrl?: string;
};

export type FaraiModelLimitConfig = {
  contextWindow?: number;
  maxOutputTokens?: number;
  source?: string;
  canonicalModel?: string;
};

export type FaraiLspServerId = "typescript" | "pyright" | "gopls" | "rust-analyzer";

export type FaraiLspServerConfig = {
  enabled?: boolean;
  command?: string[];
  env?: Record<string, string>;
};

export type FaraiLspConfig = {
  enabled?: boolean;
  waitTimeoutMs?: number;
  servers?: Partial<Record<FaraiLspServerId, FaraiLspServerConfig>>;
};

export type FaraiContextConfig = {
  maxInputTokens?: number;
};

export type FaraiProxyConfig = {
  transparent?: boolean;
  ports?: number[];
};

export const DEFAULT_TRANSPARENT_PROXY_PORTS = [80, 443, 3000, 5000, 8000, 8008, 8080, 8081, 8443, 8888, 9000];

export function isDebugLoggingEnabled(): boolean {
  return process.env.FARAI_DEBUG === "1" || process.env.FARAI_DEBUG === "true";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function providerMap(value: unknown): Record<string, Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(value)) if (isRecord(entry)) out[name] = entry;
  return Object.keys(out).length ? out : undefined;
}

function modelLimitMap(value: unknown): Record<string, FaraiModelLimitConfig> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, FaraiModelLimitConfig> = {};
  for (const [selection, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const contextWindow = positiveNumber(raw.context_window ?? raw.contextWindow);
    const maxOutputTokens = positiveNumber(raw.max_output_tokens ?? raw.maxOutputTokens);
    const source = typeof raw.source === "string" && raw.source ? raw.source : undefined;
    const canonicalModel = typeof raw.canonical_model === "string" && raw.canonical_model
      ? raw.canonical_model
      : typeof raw.canonicalModel === "string" && raw.canonicalModel
        ? raw.canonicalModel
        : undefined;
    const limit: FaraiModelLimitConfig = {
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(source ? { source } : {}),
      ...(canonicalModel ? { canonicalModel } : {})
    };
    if (Object.keys(limit).length) out[selection] = limit;
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeConfig(raw: unknown): FaraiConfig {
  if (!isRecord(raw)) return {};
  const configuredApiKeyEnv = typeof raw.env_key === "string"
    ? raw.env_key
    : typeof raw.apiKeyEnv === "string"
      ? raw.apiKeyEnv
      : undefined;
  const apiKeyEnv = configuredApiKeyEnv && isEnvironmentVariableName(configuredApiKeyEnv) ? configuredApiKeyEnv : undefined;
  const providers = providerMap(raw.model_providers ?? raw.modelProviders);
  const mcp = providerMap(raw.mcp_servers ?? raw.mcpServers);
  const email = providerMap(raw.email_accounts ?? raw.emailAccounts);
  const modelLimits = modelLimitMap(raw.model_limits ?? raw.modelLimits);
  const recent = raw.recent_models ?? raw.recentModels;
  const proxy = proxyConfig(raw.proxy);
  const context = contextConfig(raw.context);
  const lsp = lspConfig(raw.lsp);
  const web = webConfig(raw.web);
  return {
    ...(positiveInteger(raw.config_version ?? raw.configVersion) !== undefined ? { configVersion: positiveInteger(raw.config_version ?? raw.configVersion)! } : {}),
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(typeof raw.base_url === "string" ? { baseUrl: raw.base_url } : typeof raw.baseUrl === "string" ? { baseUrl: raw.baseUrl } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(positiveNumber(raw.context_window ?? raw.contextWindow) ? { contextWindow: positiveNumber(raw.context_window ?? raw.contextWindow)! } : {}),
    ...(positiveNumber(raw.max_output_tokens ?? raw.maxOutputTokens) ? { maxOutputTokens: positiveNumber(raw.max_output_tokens ?? raw.maxOutputTokens)! } : {}),
    ...(positiveNumber(raw.max_concurrent_subagents ?? raw.maxConcurrentSubagents) ? { maxConcurrentSubagents: Math.floor(positiveNumber(raw.max_concurrent_subagents ?? raw.maxConcurrentSubagents)!) } : {}),
    ...(positiveNumber(raw.max_steps ?? raw.maxSteps) ? { maxSteps: positiveNumber(raw.max_steps ?? raw.maxSteps)! } : {}),
    ...(positiveNumber(raw.max_turn_seconds ?? raw.maxTurnSeconds) ? { maxTurnSeconds: positiveNumber(raw.max_turn_seconds ?? raw.maxTurnSeconds)! } : {}),
    ...(positiveNumber(raw.max_cost_usd ?? raw.maxCostUsd) ? { maxCostUsd: positiveNumber(raw.max_cost_usd ?? raw.maxCostUsd)! } : {}),
    ...(Array.isArray(recent) ? { recentModels: recent.filter((item): item is string => typeof item === "string") } : {}),
    ...(modelLimits ? { modelLimits } : {}),
    ...(providers ? { modelProviders: providers } : {}),
    ...(mcp ? { mcpServers: mcp } : {}),
    ...(email ? { emailAccounts: email } : {}),
    ...(proxy ? { proxy } : {}),
    ...(context ? { context } : {}),
    ...(lsp ? { lsp } : {}),
    ...(web ? { web } : {})
  };
}

function webConfig(value: unknown): FaraiWebConfig | undefined {
  if (!isRecord(value)) return undefined;
  const backend = value.search_backend ?? value.searchBackend;
  const searchBackend = backend === "auto" || backend === "duckduckgo" || backend === "yahoo" || backend === "bing" || backend === "searxng" ? backend : undefined;
  const searxngUrl = typeof (value.searxng_url ?? value.searxngUrl) === "string" ? String(value.searxng_url ?? value.searxngUrl) : undefined;
  return searchBackend || searxngUrl ? { ...(searchBackend ? { searchBackend } : {}), ...(searxngUrl ? { searxngUrl } : {}) } : undefined;
}

const LSP_SERVER_IDS: FaraiLspServerId[] = ["typescript", "pyright", "gopls", "rust-analyzer"];

function lspConfig(value: unknown): FaraiLspConfig | undefined {
  if (!isRecord(value)) return undefined;
  const rawServers = isRecord(value.servers) ? value.servers : undefined;
  const servers: Partial<Record<FaraiLspServerId, FaraiLspServerConfig>> = {};
  for (const id of LSP_SERVER_IDS) {
    const raw = rawServers?.[id];
    if (!isRecord(raw)) continue;
    const command = Array.isArray(raw.command) && raw.command.every((item) => typeof item === "string" && item.length > 0)
      ? raw.command as string[]
      : undefined;
    const rawEnv = isRecord(raw.env) ? raw.env : undefined;
    const env = rawEnv
      ? Object.fromEntries(Object.entries(rawEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : undefined;
    const server: FaraiLspServerConfig = {
      ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
      ...(command?.length ? { command } : {}),
      ...(env && Object.keys(env).length ? { env } : {})
    };
    if (Object.keys(server).length) servers[id] = server;
  }
  const waitTimeoutMs = positiveNumber(value.wait_timeout_ms ?? value.waitTimeoutMs);
  const config: FaraiLspConfig = {
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(waitTimeoutMs ? { waitTimeoutMs } : {}),
    ...(Object.keys(servers).length ? { servers } : {})
  };
  return Object.keys(config).length ? config : undefined;
}

function contextConfig(value: unknown): FaraiContextConfig | undefined {
  if (!isRecord(value)) return undefined;
  const maxInputTokens = positiveNumber(value.max_input_tokens ?? value.maxInputTokens);
  return maxInputTokens ? { maxInputTokens } : undefined;
}

function proxyConfig(value: unknown): FaraiProxyConfig | undefined {
  if (!isRecord(value)) return undefined;
  const ports = Array.isArray(value.ports)
    ? value.ports.filter((port): port is number => typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65_536)
    : undefined;
  const config: FaraiProxyConfig = {
    ...(typeof value.transparent === "boolean" ? { transparent: value.transparent } : {}),
    ...(ports?.length ? { ports } : {})
  };
  return Object.keys(config).length ? config : undefined;
}

export function resolveProxyConfig(config: FaraiConfig): { transparent: boolean; ports: number[] } {
  return {
    transparent: config.proxy?.transparent !== false,
    ports: config.proxy?.ports?.length ? config.proxy.ports : DEFAULT_TRANSPARENT_PROXY_PORTS
  };
}

export function loadRawConfig(path: string): FaraiConfig {
  try {
    if (!existsSync(path)) return {};
    return normalizeConfig(Bun.TOML.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

function shouldReadGlobal(): boolean {
  if (process.env.NODE_ENV !== "test") return true;
  return (process.env.HOME ?? "").startsWith(tmpdir());
}

export function loadConfig(workspace?: string): FaraiConfig {
  const global = shouldReadGlobal() ? loadRawConfig(configPath("global")) : {};
  const project = workspace ? loadRawConfig(configPath("project", workspace)) : {};
  return mergeConfig(global, project);
}

export function mergeConfig(base: FaraiConfig, over: FaraiConfig): FaraiConfig {
  return {
    ...base,
    ...over,
    ...(over.model ?? base.model ? { model: over.model ?? base.model } : {}),
    ...(over.recentModels ?? base.recentModels ? { recentModels: over.recentModels ?? base.recentModels } : {}),
    ...(base.modelLimits || over.modelLimits ? { modelLimits: { ...base.modelLimits, ...over.modelLimits } } : {}),
    ...(base.modelProviders || over.modelProviders ? { modelProviders: { ...base.modelProviders, ...over.modelProviders } } : {}),
    ...(base.mcpServers || over.mcpServers ? { mcpServers: { ...base.mcpServers, ...over.mcpServers } } : {}),
    ...(base.emailAccounts || over.emailAccounts ? { emailAccounts: { ...base.emailAccounts, ...over.emailAccounts } } : {}),
    ...(base.proxy || over.proxy ? { proxy: { ...base.proxy, ...over.proxy } } : {}),
    ...(base.context || over.context ? { context: { ...base.context, ...over.context } } : {}),
    ...(base.lsp || over.lsp ? {
      lsp: {
        ...base.lsp,
        ...over.lsp,
        ...(base.lsp?.servers || over.lsp?.servers ? {
          servers: Object.fromEntries(LSP_SERVER_IDS.map((id) => [
            id,
            { ...base.lsp?.servers?.[id], ...over.lsp?.servers?.[id] }
          ]).filter(([, value]) => Object.keys(value as object).length))
        } : {})
      }
    } : {}),
    ...(base.web || over.web ? { web: { ...base.web, ...over.web } } : {})
  };
}

export function resolveApiKey(name: string, options: { apiKeyEnv?: string; inlineApiKey?: string; workspace?: string } = {}): string | undefined {
  const stored = readCredentialForWorkspaceSync("model-provider", name, options.workspace)?.value;
  if (stored) return stored;
  if (options.apiKeyEnv) {
    if (isEnvironmentVariableName(options.apiKeyEnv) && process.env[options.apiKeyEnv]) return process.env[options.apiKeyEnv];
  }
  if (options.inlineApiKey) return options.inlineApiKey;
  return undefined;
}

export function serializeConfigToml(config: FaraiConfig): string {
  const lines: string[] = [];
  if (config.configVersion !== undefined) lines.push(`config_version = ${config.configVersion}`);
  if (config.model) lines.push(`model = ${tomlString(config.model)}`);
  if (config.recentModels?.length) lines.push(`recent_models = ${tomlArray(config.recentModels)}`);
  if (config.contextWindow) lines.push(`context_window = ${config.contextWindow}`);
  if (config.maxOutputTokens) lines.push(`max_output_tokens = ${config.maxOutputTokens}`);
  if (config.maxSteps) lines.push(`max_steps = ${config.maxSteps}`);
  if (config.maxTurnSeconds) lines.push(`max_turn_seconds = ${config.maxTurnSeconds}`);
  if (config.maxCostUsd) lines.push(`max_cost_usd = ${config.maxCostUsd}`);
  if (config.maxConcurrentSubagents) lines.push(`max_concurrent_subagents = ${config.maxConcurrentSubagents}`);
  if (config.baseUrl) lines.push(`base_url = ${tomlString(config.baseUrl)}`);
  if (config.apiKeyEnv && isEnvironmentVariableName(config.apiKeyEnv)) lines.push(`env_key = ${tomlString(config.apiKeyEnv)}`);
  if (config.proxy && Object.keys(config.proxy).length) emitTable(lines, ["proxy"], config.proxy as Record<string, unknown>);
  if (config.context?.maxInputTokens) emitTable(lines, ["context"], { max_input_tokens: config.context.maxInputTokens });
  if (config.web && Object.keys(config.web).length) emitTable(lines, ["web"], {
    ...(config.web.searchBackend ? { search_backend: config.web.searchBackend } : {}),
    ...(config.web.searxngUrl ? { searxng_url: config.web.searxngUrl } : {})
  });
  for (const [selection, limit] of Object.entries(config.modelLimits ?? {})) {
    emitTable(lines, ["model_limits", selection], {
      ...(limit.contextWindow ? { context_window: limit.contextWindow } : {}),
      ...(limit.maxOutputTokens ? { max_output_tokens: limit.maxOutputTokens } : {}),
      ...(limit.source ? { source: limit.source } : {}),
      ...(limit.canonicalModel ? { canonical_model: limit.canonicalModel } : {})
    });
  }
  if (config.lsp && Object.keys(config.lsp).length) {
    emitTable(lines, ["lsp"], {
      ...(config.lsp.enabled === undefined ? {} : { enabled: config.lsp.enabled }),
      ...(config.lsp.waitTimeoutMs === undefined ? {} : { wait_timeout_ms: config.lsp.waitTimeoutMs })
    });
    for (const id of LSP_SERVER_IDS) {
      const server = config.lsp.servers?.[id];
      if (!server || !Object.keys(server).length) continue;
      emitTable(lines, ["lsp", "servers", id], {
        ...(server.enabled === undefined ? {} : { enabled: server.enabled }),
        ...(server.command?.length ? { command: server.command } : {}),
        ...(server.env && Object.keys(server.env).length ? { env: server.env } : {})
      });
    }
  }
  for (const [name, entry] of Object.entries(config.modelProviders ?? {})) emitTable(lines, ["model_providers", name], entry);
  for (const [name, entry] of Object.entries(config.mcpServers ?? {})) emitTable(lines, ["mcp_servers", name], entry);
  for (const [name, entry] of Object.entries(config.emailAccounts ?? {})) emitTable(lines, ["email_accounts", name], entry);
  return `${lines.join("\n").replace(/^\n+/, "")}\n`;
}

function emitTable(lines: string[], path: string[], obj: Record<string, unknown>): void {
  const scalars: Array<[string, unknown]> = [];
  const tables: Array<[string, Record<string, unknown>]> = [];
  for (const [key, value] of Object.entries(obj)) {
    if (isRecord(value)) tables.push([key, value]);
    else scalars.push([key, value]);
  }
  lines.push("");
  lines.push(`[${path.map(tomlKey).join(".")}]`);
  for (const [key, value] of scalars) lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
  for (const [key, value] of tables) emitTable(lines, [...path, key], value);
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return tomlArray(value);
  return tomlString(String(value));
}

function tomlArray(values: unknown[]): string {
  return `[${values.map(tomlValue).join(", ")}]`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
}

export function writeConfig(config: FaraiConfig, location: ConfigLocation = "global", workspace?: string): string {
  const path = configPath(location, workspace);
  atomicWriteFile(path, serializeConfigToml(config), 0o600);
  return path;
}

export function updateConfig(mutator: (config: FaraiConfig) => FaraiConfig, location: ConfigLocation = "global", workspace?: string): string {
  const current = loadRawConfig(configPath(location, workspace));
  return writeConfig(mutator(current), location, workspace);
}

export function ensureDefaultConfig(): string {
  const path = configPath("global");
  mkdirSync(localFaraiDir(), { recursive: true });
  if (!existsSync(path)) {
    atomicWriteFile(path, DEFAULT_CONFIG_TEMPLATE, 0o600);
    return path;
  }
  let current: FaraiConfig;
  try {
    current = normalizeConfig(Bun.TOML.parse(readFileSync(path, "utf8")));
  } catch {
    return path;
  }
  const defaults = defaultMcpServers();
  const missingBackbone = MCP_BACKBONE_SERVER_IDS.filter((id) => !(id in (current.mcpServers ?? {})));
  const needsMigration = (current.configVersion ?? 0) < CURRENT_CONFIG_VERSION;
  if (missingBackbone.length || needsMigration) {
    const servers = { ...(current.mcpServers ?? {}) };
    for (const id of missingBackbone) servers[id] = defaults[id]!;
    if (needsMigration && isLegacyPwnoMcpDefault(servers["pwno-mcp"])) delete servers["pwno-mcp"];
    writeConfig({ ...current, configVersion: CURRENT_CONFIG_VERSION, mcpServers: servers });
  }
  return path;
}

export function defaultMcpServers(): Record<string, Record<string, unknown>> {
  return normalizeConfig(Bun.TOML.parse(DEFAULT_CONFIG_TEMPLATE)).mcpServers ?? {};
}

const CURRENT_CONFIG_VERSION = 3;

function isLegacyPwnoMcpDefault(entry: Record<string, unknown> | undefined): boolean {
  if (!entry || entry.command !== "docker" || !Array.isArray(entry.args)) return false;
  return entry.args.includes("ghcr.io/pwno-io/pwno-mcp:v0.2.1") && entry.args.includes("--stdio");
}

const DEFAULT_CONFIG_TEMPLATE = `config_version = ${CURRENT_CONFIG_VERSION}
model = "big-pickle"

[proxy]
transparent = true

[mcp_servers.mitmproxy-mcp]
command = "mitmproxy-mcp"
args = []
run_in_container = true
enabled = true
required = false
startup_timeout_sec = 60
tool_timeout_sec = 120
[mcp_servers.mitmproxy-mcp.mitmproxy]
autoStartProxy = true
port = 31337

[mcp_servers.playwright]
command = "playwright-mcp"
args = ["--headless", "--browser", "chromium", "--executable-path", "/usr/bin/chromium", "--no-sandbox", "--ignore-https-errors", "--isolated"]
run_in_container = true
enabled = true
required = false
startup_timeout_sec = 60
tool_timeout_sec = 120

`;

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
