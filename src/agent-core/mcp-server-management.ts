import { authPath, configPath, loadRawConfig, readAuth, removeAuthEntry, writeAuthEntry, writeConfig, type AuthEntry, type ConfigLocation, type FaraiConfig } from "./config";
import { mcpServersFromConfig, type ExternalMcpServer } from "../agent-tools/mcp-adapter";
import { removeMcpCachedCatalog } from "../agent-tools/mcp-cache";
import { isMcpBackboneServer } from "../agent-tools/mcp-builtins";

export type McpTransport = "stdio" | "http";
export type McpCredentialAction = "keep" | "replace" | "remove";

export type McpServerInfo = {
  id: string;
  transport: McpTransport;
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  envVars: string[];
  url?: string;
  auth: "none" | "bearer" | "oauth";
  oauthClientId?: string;
  oauthCallbackUrl?: string;
  oauthScopes: string[];
  runInContainer: boolean;
  enabled: boolean;
  required: boolean;
  autoStart: boolean;
  startupTimeoutSec: number;
  toolTimeoutSec: number;
  bearerTokenEnvVar?: string;
  credentialStored: boolean;
  httpHeaders: Record<string, string>;
  envHttpHeaders: Record<string, string>;
  enabledTools: string[];
  disabledTools: string[];
  location: ConfigLocation;
  backbone: boolean;
  toggleable: boolean;
  removable: boolean;
};

export type SaveMcpServerInput = {
  id: string;
  originalID?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  envVars?: string[];
  url?: string;
  auth?: "none" | "bearer" | "oauth";
  oauthClientId?: string;
  oauthCallbackUrl?: string;
  oauthScopes?: string[];
  runInContainer?: boolean;
  enabled?: boolean;
  required?: boolean;
  autoStart?: boolean;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  bearerTokenEnvVar?: string;
  bearerToken?: string;
  credentialAction?: McpCredentialAction;
  httpHeaders?: Record<string, string>;
  envHttpHeaders?: Record<string, string>;
  enabledTools?: string[];
  disabledTools?: string[];
  location?: ConfigLocation;
};

export type McpServerProbe = {
  ok: boolean;
  latencyMs: number;
  tools: string[];
  resources: number;
  error?: string;
};

const SERVER_ID = /^[a-z0-9][a-z0-9_-]*$/;

export function listConfiguredMcpServers(workspace: string): McpServerInfo[] {
  const global = loadRawConfig(configPath("global")).mcpServers ?? {};
  const project = loadRawConfig(configPath("project", workspace)).mcpServers ?? {};
  const names = [...new Set([...Object.keys(global), ...Object.keys(project)])].sort();
  return names.map((id) => {
    const location: ConfigLocation = id in project ? "project" : "global";
    const entry = location === "project" ? project[id]! : global[id]!;
    const config = normalizeServer(id, entry);
    const credentialStored = Boolean(readAuth(authPath(location, workspace))[mcpAuthEntryName(id)]?.token);
    return toInfo(config, location, credentialStored);
  });
}

export function saveMcpServer(workspace: string, input: SaveMcpServerInput): { id: string; location: ConfigLocation; path: string } {
  const id = normalizeMcpServerID(input.id);
  const originalID = input.originalID ? normalizeMcpServerID(input.originalID) : id;
  if (isMcpBackboneServer(originalID) && originalID !== id) throw new Error(`MCP backbone server ${originalID} cannot be renamed`);
  if (originalID !== id && mcpServerLocation(workspace, id)) throw new Error(`MCP server ${id} is already configured`);
  const location = input.location ?? "global";
  const previousConfig = loadRawConfig(configPath(location, workspace));
  const auth = readAuth(authPath(location, workspace));
  const authNames = [...new Set([
    mcpAuthEntryName(originalID),
    mcpOAuthAuthEntryName(originalID),
    mcpAuthEntryName(id),
    mcpOAuthAuthEntryName(id)
  ])];
  const previousAuth = Object.fromEntries(authNames.map((name) => [name, auth[name]]));
  const bearerToken = input.credentialAction === "replace" ? input.bearerToken?.trim() : undefined;
  if (input.credentialAction === "replace" && !bearerToken) throw new Error("bearer token cannot be empty when replacing a credential");
  const servers = { ...(previousConfig.mcpServers ?? {}) };
  if (originalID !== id) delete servers[originalID];
  servers[id] = serverEntry(input);
  const nextConfig = { ...previousConfig, mcpServers: servers };
  const path = writeConfig(nextConfig, location, workspace);
  try {
    for (const name of authNames) removeAuthEntry(name, location, workspace);
    const authMode = input.transport === "http" ? input.auth ?? "none" : "none";
    if (authMode === "bearer") {
      const kept = previousAuth[mcpAuthEntryName(originalID)];
      const entry = input.credentialAction === "replace"
        ? { token: bearerToken! }
        : input.credentialAction === "remove"
          ? undefined
          : kept;
      if (entry) writeAuthEntry(mcpAuthEntryName(id), entry, location, workspace);
    }
    if (authMode === "oauth") {
      const oauth = previousAuth[mcpOAuthAuthEntryName(originalID)];
      if (oauth) writeAuthEntry(mcpOAuthAuthEntryName(id), oauth, location, workspace);
    }
  } catch (error) {
    writeConfig(previousConfig, location, workspace);
    restoreAuthEntries(previousAuth, location, workspace);
    throw error;
  }
  if (originalID !== id) removeMcpCachedCatalog(originalID);
  removeMcpCachedCatalog(id);
  return { id, location, path };
}

export function removeMcpServer(workspace: string, serverID: string, location?: ConfigLocation): { id: string; location: ConfigLocation; serverRemains: boolean } {
  const id = normalizeMcpServerID(serverID);
  if (isMcpBackboneServer(id)) throw new Error(`MCP backbone server ${id} cannot be removed`);
  const resolvedLocation = location ?? mcpServerLocation(workspace, id);
  if (!resolvedLocation) throw new Error(`MCP server ${id} is not configured`);
  const previous = loadRawConfig(configPath(resolvedLocation, workspace));
  const auth = readAuth(authPath(resolvedLocation, workspace));
  const previousCredentials = {
    [mcpAuthEntryName(id)]: auth[mcpAuthEntryName(id)],
    [mcpOAuthAuthEntryName(id)]: auth[mcpOAuthAuthEntryName(id)]
  };
  const servers = { ...(previous.mcpServers ?? {}) };
  delete servers[id];
  const next: FaraiConfig = { ...previous };
  if (Object.keys(servers).length) next.mcpServers = servers;
  else delete next.mcpServers;
  try {
    writeConfig(next, resolvedLocation, workspace);
    removeAuthEntry(mcpAuthEntryName(id), resolvedLocation, workspace);
    removeAuthEntry(mcpOAuthAuthEntryName(id), resolvedLocation, workspace);
  } catch (error) {
    writeConfig(previous, resolvedLocation, workspace);
    restoreAuthEntries(previousCredentials, resolvedLocation, workspace);
    throw error;
  }
  removeMcpCachedCatalog(id);
  const serverRemains = Boolean(mcpServerLocation(workspace, id));
  return { id, location: resolvedLocation, serverRemains };
}

export function setMcpServerEnabled(workspace: string, serverID: string, enabled: boolean): McpServerInfo {
  const id = normalizeMcpServerID(serverID);
  if (isMcpBackboneServer(id) && !enabled) throw new Error(`MCP backbone server ${id} cannot be disabled`);
  const location = mcpServerLocation(workspace, id);
  if (!location) throw new Error(`MCP server ${id} is not configured`);
  const config = loadRawConfig(configPath(location, workspace));
  const servers = { ...(config.mcpServers ?? {}) };
  servers[id] = { ...(servers[id] ?? {}), enabled };
  writeConfig({ ...config, mcpServers: servers }, location, workspace);
  return listConfiguredMcpServers(workspace).find((server) => server.id === id)!;
}

export function normalizeMcpServerID(value: string): string {
  const normalized = value.trim().replace(/\s+/g, "-").toLowerCase();
  if (!SERVER_ID.test(normalized)) throw new Error("MCP server id must start with a letter or number and contain only lowercase letters, numbers, hyphens, or underscores");
  return normalized;
}

export function mcpServerFromInput(input: SaveMcpServerInput): ExternalMcpServer {
  const id = normalizeMcpServerID(input.id);
  return normalizeServer(id, serverEntry({ ...input, id }));
}

function serverEntry(input: SaveMcpServerInput): Record<string, unknown> {
  const common: Record<string, unknown> = {
    enabled: isMcpBackboneServer(input.id) || input.enabled !== false,
    required: input.required === true,
    auto_start: input.autoStart !== false,
    startup_timeout_sec: positiveSeconds(input.startupTimeoutSec, 10),
    tool_timeout_sec: positiveSeconds(input.toolTimeoutSec, 60)
  };
  const enabledTools = cleanList(input.enabledTools);
  const disabledTools = cleanList(input.disabledTools);
  if (enabledTools.length) common.enabled_tools = enabledTools;
  if (disabledTools.length) common.disabled_tools = disabledTools;
  if (input.transport === "http") {
    common.url = normalizeMcpUrl(input.url ?? "");
    if (input.auth === "oauth") {
      common.auth = "oauth";
      const oauth: Record<string, unknown> = {};
      if (input.oauthClientId?.trim()) oauth.client_id = input.oauthClientId.trim();
      if (input.oauthCallbackUrl?.trim()) oauth.callback_url = normalizeMcpUrl(input.oauthCallbackUrl);
      const scopes = cleanList(input.oauthScopes);
      if (scopes.length) oauth.scopes = scopes;
      if (Object.keys(oauth).length) common.oauth = oauth;
    }
    const bearerTokenEnvVar = input.bearerTokenEnvVar?.trim();
    if (bearerTokenEnvVar) common.bearer_token_env_var = bearerTokenEnvVar;
    const httpHeaders = cleanRecord(input.httpHeaders);
    const envHttpHeaders = cleanRecord(input.envHttpHeaders);
    if (Object.keys(httpHeaders).length) common.http_headers = httpHeaders;
    if (Object.keys(envHttpHeaders).length) common.env_http_headers = envHttpHeaders;
    return common;
  }
  const command = input.command?.trim();
  if (!command) throw new Error("MCP stdio command is required");
  return {
    ...common,
    command,
    args: (input.args ?? []).map((arg) => String(arg)),
    ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
    ...(Object.keys(cleanRecord(input.env)).length ? { env: cleanRecord(input.env) } : {}),
    ...(cleanList(input.envVars).length ? { env_vars: cleanList(input.envVars) } : {}),
    run_in_container: input.runInContainer !== false
  };
}

function normalizeServer(id: string, entry: Record<string, unknown>): ExternalMcpServer {
  return mcpServersFromConfig({ [id]: entry })[0]!;
}

function toInfo(config: ExternalMcpServer, location: ConfigLocation, credentialStored: boolean): McpServerInfo {
  const backbone = isMcpBackboneServer(config.name);
  return {
    id: config.name,
    transport: config.type,
    command: config.command,
    args: [...config.args],
    ...(config.cwd ? { cwd: config.cwd } : {}),
    env: { ...(config.env ?? {}) },
    envVars: [...(config.envVars ?? [])],
    ...(config.url ? { url: config.url } : {}),
    auth: config.auth === "oauth"
      ? "oauth"
      : config.bearerTokenEnvVar || credentialStored || hasAuthorizationHeader(config)
        ? "bearer"
        : "none",
    ...(config.oauth?.clientId ? { oauthClientId: config.oauth.clientId } : {}),
    ...(config.oauth?.callbackUrl ? { oauthCallbackUrl: config.oauth.callbackUrl } : {}),
    oauthScopes: [...(config.oauth?.scopes ?? [])],
    runInContainer: config.runInContainer,
    enabled: config.enabled,
    required: config.required,
    autoStart: config.autoStart,
    startupTimeoutSec: config.startupTimeoutMs / 1_000,
    toolTimeoutSec: config.toolTimeoutMs / 1_000,
    ...(config.bearerTokenEnvVar ? { bearerTokenEnvVar: config.bearerTokenEnvVar } : {}),
    credentialStored,
    httpHeaders: { ...(config.httpHeaders ?? {}) },
    envHttpHeaders: { ...(config.envHttpHeaders ?? {}) },
    enabledTools: [...(config.enabledTools ?? [])],
    disabledTools: [...(config.disabledTools ?? [])],
    location,
    backbone,
    toggleable: !backbone,
    removable: !backbone
  };
}

function mcpServerLocation(workspace: string, id: string): ConfigLocation | undefined {
  if (id in (loadRawConfig(configPath("project", workspace)).mcpServers ?? {})) return "project";
  if (id in (loadRawConfig(configPath("global")).mcpServers ?? {})) return "global";
  return undefined;
}

function normalizeMcpUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw new Error("MCP URL must be a valid HTTP or HTTPS URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("MCP URL must use HTTP or HTTPS");
  if (parsed.username || parsed.password) throw new Error("MCP credentials must not be embedded in the URL");
  return parsed.toString();
}

function positiveSeconds(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function cleanList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function cleanRecord(values: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key.trim(), value.trim()]).filter(([key, value]) => key && value));
}

function restoreAuthEntries(entries: Record<string, AuthEntry | undefined>, location: ConfigLocation, workspace: string): void {
  for (const [name, entry] of Object.entries(entries)) {
    removeAuthEntry(name, location, workspace);
    if (entry) writeAuthEntry(name, entry, location, workspace);
  }
}

function mcpAuthEntryName(serverName: string): string {
  return `mcp:${serverName}`;
}

function mcpOAuthAuthEntryName(serverName: string): string {
  return `mcp:${serverName}:oauth`;
}

function hasAuthorizationHeader(config: ExternalMcpServer): boolean {
  return Object.keys(config.httpHeaders ?? {}).some((name) => name.toLowerCase() === "authorization")
    || Object.keys(config.envHttpHeaders ?? {}).some((name) => name.toLowerCase() === "authorization");
}
