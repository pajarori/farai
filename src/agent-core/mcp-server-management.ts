import { configPath, loadRawConfig, writeConfig, type ConfigLocation, type FaraiConfig } from "./config";
import { deleteCredential, legacyCredentialConfigured, readCredential, writeCredential, type CredentialKind } from "./credential-store";
import { emptyMcpSecretFields, isSensitiveMcpField, normalizeMcpSecretFields, readMcpSecretFields, writeMcpSecretFields, type McpSecretFields } from "./mcp-secret-fields";
import { mcpServersFromConfig, type ExternalMcpServer } from "../agent-tools/mcp-adapter";
import { removeMcpCachedCatalog } from "../agent-tools/mcp-cache";
import { isMcpBackboneServer } from "../agent-tools/mcp-builtins";
import { deleteMcpHeader, mergeMcpHeaders, normalizeMcpHeaderNames } from "./mcp-headers";

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
  secretEnvVars?: string[];
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
  secretHttpHeaders?: string[];
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
  secretEnv?: Record<string, string>;
  retainedSecretEnv?: string[];
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
  secretHttpHeaders?: Record<string, string>;
  retainedSecretHttpHeaders?: string[];
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

export async function listConfiguredMcpServers(workspace: string): Promise<McpServerInfo[]> {
  await migrateInlineMcpSecretFields(workspace);
  const global = loadRawConfig(configPath("global")).mcpServers ?? {};
  const project = loadRawConfig(configPath("project", workspace)).mcpServers ?? {};
  const names = [...new Set([...Object.keys(global), ...Object.keys(project)])].sort();
  return await Promise.all(names.map(async (id) => {
    const location: ConfigLocation = id in project ? "project" : "global";
    const entry = location === "project" ? project[id]! : global[id]!;
    const config = normalizeServer(id, entry);
    const credentialStored = Boolean(entry.credential_configured === true
      || config.bearerToken
      || await readCredential("mcp-bearer", id, location, workspace).catch(() => undefined));
    return toInfo(redactInlineMcpSecrets(config), location, credentialStored);
  }));
}

export async function saveMcpServer(workspace: string, input: SaveMcpServerInput): Promise<{ id: string; location: ConfigLocation; path: string }> {
  const id = normalizeMcpServerID(input.id);
  const originalID = input.originalID ? normalizeMcpServerID(input.originalID) : id;
  if (isMcpBackboneServer(originalID) && originalID !== id) throw new Error(`MCP backbone server ${originalID} cannot be renamed`);
  if (originalID !== id && mcpServerLocation(workspace, id)) throw new Error(`MCP server ${id} is already configured`);
  const location = input.location ?? "global";
  const normalizedInput: SaveMcpServerInput = { ...input, id, originalID, location };
  const previousConfig = loadRawConfig(configPath(location, workspace));
  const originalEntry = (previousConfig.mcpServers ?? {})[originalID];
  const originalConfig = originalEntry ? normalizeServer(originalID, originalEntry) : undefined;
  const previousFieldCredential = originalConfig && hasMcpSecretFieldState(originalConfig)
    ? await readCredential("mcp-fields", originalID, location, workspace)
    : undefined;
  const previousFields = originalConfig
    ? mergeMcpSecretFields(
        previousFieldCredential ? parseMcpSecretFields(previousFieldCredential) : emptyMcpSecretFields(),
        inlineSensitiveMcpFields(originalConfig)
      )
    : emptyMcpSecretFields();
  if (originalConfig) assertMcpStoredFields(originalConfig, previousFields);
  const nextFields = nextMcpSecretFields(normalizedInput, previousFields);
  const configInput = publicMcpServerInput(normalizedInput);
  const inlineBearer = originalConfig?.bearerToken;
  const bearerConfigured = Boolean(originalEntry?.credential_configured === true
    || inlineBearer
    || legacyCredentialConfigured("mcp-bearer", originalID, location, workspace));
  const oauthPossible = Boolean(originalEntry?.oauth_configured === true
    || originalConfig?.auth === "oauth"
    || legacyCredentialConfigured("mcp-oauth", originalID, location, workspace));
  const previousCredentials: Record<string, string | undefined> = {};
  if (bearerConfigured) {
    previousCredentials[credentialSnapshotKey("mcp-bearer", originalID)] = inlineBearer
      ?? await readCredential("mcp-bearer", originalID, location, workspace);
  }
  if (oauthPossible) {
    const oauth = await readCredential("mcp-oauth", originalID, location, workspace);
    if (oauth) previousCredentials[credentialSnapshotKey("mcp-oauth", originalID)] = oauth;
  }
  if (previousFieldCredential) previousCredentials[credentialSnapshotKey("mcp-fields", originalID)] = previousFieldCredential;
  const bearerToken = normalizedInput.credentialAction === "replace" ? normalizedInput.bearerToken?.trim() : undefined;
  if (normalizedInput.credentialAction === "replace" && !bearerToken) throw new Error("bearer token cannot be empty when replacing a credential");
  const servers = { ...(previousConfig.mcpServers ?? {}) };
  if (originalID !== id) delete servers[originalID];
  servers[id] = serverEntry(configInput, nextFields);
  const keptBearer = previousCredentials[credentialSnapshotKey("mcp-bearer", originalID)];
  const keptOAuth = previousCredentials[credentialSnapshotKey("mcp-oauth", originalID)];
  const authMode = normalizedInput.transport === "http" ? normalizedInput.auth ?? "none" : "none";
  if (authMode === "bearer" && (normalizedInput.credentialAction === "replace" || normalizedInput.credentialAction !== "remove" && keptBearer)) {
    servers[id]!.credential_configured = true;
  } else {
    delete servers[id]!.credential_configured;
  }
  if (authMode === "oauth" && keptOAuth) servers[id]!.oauth_configured = true;
  else delete servers[id]!.oauth_configured;
  const nextConfig = { ...previousConfig, mcpServers: servers };
  const path = writeConfig(nextConfig, location, workspace);
  const touched = new Set<string>();
  try {
    if (originalID !== id) {
      if (keptBearer) await removeManagedCredential("mcp-bearer", originalID, location, workspace, touched);
      if (keptOAuth) await removeManagedCredential("mcp-oauth", originalID, location, workspace, touched);
      if (previousFieldCredential) await removeManagedCredential("mcp-fields", originalID, location, workspace, touched);
    } else if (authMode === "bearer") {
      if (keptOAuth) await removeManagedCredential("mcp-oauth", id, location, workspace, touched);
      if (normalizedInput.credentialAction === "remove" && keptBearer) await removeManagedCredential("mcp-bearer", id, location, workspace, touched);
    } else if (authMode === "oauth") {
      if (keptBearer) await removeManagedCredential("mcp-bearer", id, location, workspace, touched);
    } else {
      if (keptBearer) await removeManagedCredential("mcp-bearer", id, location, workspace, touched);
      if (keptOAuth) await removeManagedCredential("mcp-oauth", id, location, workspace, touched);
    }
    if (authMode === "bearer") {
      const kept = keptBearer;
      const value = normalizedInput.credentialAction === "replace"
        ? bearerToken!
        : normalizedInput.credentialAction === "remove"
          ? undefined
          : kept;
      if (value && (originalID !== id || normalizedInput.credentialAction === "replace")) {
        touched.add(credentialSnapshotKey("mcp-bearer", id));
        await writeCredential("mcp-bearer", id, value, location, workspace);
      }
    }
    if (authMode === "oauth") {
      if (keptOAuth && originalID !== id) {
        touched.add(credentialSnapshotKey("mcp-oauth", id));
        await writeCredential("mcp-oauth", id, keptOAuth, location, workspace);
      }
    }
    if (hasMcpSecretFields(nextFields)) {
      touched.add(credentialSnapshotKey("mcp-fields", id));
      await writeMcpSecretFields(id, nextFields, location, workspace);
    } else if (originalID === id && previousFieldCredential) {
      await removeManagedCredential("mcp-fields", id, location, workspace, touched);
    }
  } catch (error) {
    writeConfig(previousConfig, location, workspace);
    const rollbackErrors = await restoreCredentials(previousCredentials, touched, location, workspace);
    throw rollbackErrors.length ? new Error(`${errorMessage(error)} · rollback: ${rollbackErrors.join("; ")}`) : error;
  }
  if (originalID !== id) removeMcpCachedCatalog(originalID);
  removeMcpCachedCatalog(id);
  return { id, location, path };
}

export async function removeMcpServer(workspace: string, serverID: string, location?: ConfigLocation): Promise<{ id: string; location: ConfigLocation; serverRemains: boolean }> {
  const id = normalizeMcpServerID(serverID);
  if (isMcpBackboneServer(id)) throw new Error(`MCP backbone server ${id} cannot be removed`);
  const resolvedLocation = location ?? mcpServerLocation(workspace, id);
  if (!resolvedLocation) throw new Error(`MCP server ${id} is not configured`);
  const previous = loadRawConfig(configPath(resolvedLocation, workspace));
  const previousEntry = (previous.mcpServers ?? {})[id]!;
  const previousServer = normalizeServer(id, previousEntry);
  const previousCredentials: Record<string, string | undefined> = {};
  const bearerConfigured = Boolean(previousEntry.credential_configured === true
    || previousServer.bearerToken
    || legacyCredentialConfigured("mcp-bearer", id, resolvedLocation, workspace));
  const oauthPossible = Boolean(previousEntry.oauth_configured === true
    || previousServer.auth === "oauth"
    || legacyCredentialConfigured("mcp-oauth", id, resolvedLocation, workspace));
  if (bearerConfigured) {
    previousCredentials[credentialSnapshotKey("mcp-bearer", id)] = previousServer.bearerToken
      ?? await readCredential("mcp-bearer", id, resolvedLocation, workspace);
  }
  if (oauthPossible) {
    const oauth = await readCredential("mcp-oauth", id, resolvedLocation, workspace);
    if (oauth) previousCredentials[credentialSnapshotKey("mcp-oauth", id)] = oauth;
  }
  const fieldCredential = hasMcpSecretFieldState(previousServer)
    ? await readCredential("mcp-fields", id, resolvedLocation, workspace)
    : undefined;
  if (fieldCredential) previousCredentials[credentialSnapshotKey("mcp-fields", id)] = fieldCredential;
  const servers = { ...(previous.mcpServers ?? {}) };
  delete servers[id];
  const next: FaraiConfig = { ...previous };
  if (Object.keys(servers).length) next.mcpServers = servers;
  else delete next.mcpServers;
  const touched = new Set<string>();
  try {
    writeConfig(next, resolvedLocation, workspace);
    if (previousCredentials[credentialSnapshotKey("mcp-bearer", id)]) await removeManagedCredential("mcp-bearer", id, resolvedLocation, workspace, touched);
    if (previousCredentials[credentialSnapshotKey("mcp-oauth", id)]) await removeManagedCredential("mcp-oauth", id, resolvedLocation, workspace, touched);
    if (fieldCredential) await removeManagedCredential("mcp-fields", id, resolvedLocation, workspace, touched);
  } catch (error) {
    writeConfig(previous, resolvedLocation, workspace);
    const rollbackErrors = await restoreCredentials(previousCredentials, touched, resolvedLocation, workspace);
    throw rollbackErrors.length ? new Error(`${errorMessage(error)} · rollback: ${rollbackErrors.join("; ")}`) : error;
  }
  removeMcpCachedCatalog(id);
  const serverRemains = Boolean(mcpServerLocation(workspace, id));
  return { id, location: resolvedLocation, serverRemains };
}

export async function setMcpServerEnabled(workspace: string, serverID: string, enabled: boolean): Promise<McpServerInfo> {
  const id = normalizeMcpServerID(serverID);
  if (isMcpBackboneServer(id) && !enabled) throw new Error(`MCP backbone server ${id} cannot be disabled`);
  const location = mcpServerLocation(workspace, id);
  if (!location) throw new Error(`MCP server ${id} is not configured`);
  const config = loadRawConfig(configPath(location, workspace));
  const servers = { ...(config.mcpServers ?? {}) };
  servers[id] = { ...(servers[id] ?? {}), enabled };
  writeConfig({ ...config, mcpServers: servers }, location, workspace);
  return (await listConfiguredMcpServers(workspace)).find((server) => server.id === id)!;
}

export function normalizeMcpServerID(value: string): string {
  const normalized = value.trim().replace(/\s+/g, "-").toLowerCase();
  if (!SERVER_ID.test(normalized)) throw new Error("MCP server id must start with a letter or number and contain only lowercase letters, numbers, hyphens, or underscores");
  return normalized;
}

export function mcpServerFromInput(input: SaveMcpServerInput): ExternalMcpServer {
  const id = normalizeMcpServerID(input.id);
  const fields = nextMcpSecretFields({ ...input, id }, emptyMcpSecretFields());
  const materialized = publicMcpServerInput({ ...input, id });
  if (input.transport === "stdio") materialized.env = { ...(materialized.env ?? {}), ...fields.env };
  else materialized.httpHeaders = { ...(materialized.httpHeaders ?? {}), ...fields.httpHeaders };
  return normalizeServer(id, serverEntry(materialized));
}

function serverEntry(input: SaveMcpServerInput, secretFields?: McpSecretFields): Record<string, unknown> {
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
    const httpHeaders = cleanHttpHeaders(input.httpHeaders);
    const envHttpHeaders = cleanHttpHeaders(input.envHttpHeaders);
    if (Object.keys(httpHeaders).length) common.http_headers = httpHeaders;
    if (Object.keys(envHttpHeaders).length) common.env_http_headers = envHttpHeaders;
    const secretHttpHeaders = normalizeMcpHeaderNames(Object.keys(secretFields?.httpHeaders ?? {}));
    if (secretHttpHeaders.length) common.secret_http_headers = secretHttpHeaders;
    return common;
  }
  const command = input.command?.trim();
  if (!command) throw new Error("MCP stdio command is required");
  const secretEnv = cleanList(Object.keys(secretFields?.env ?? {}));
  return {
    ...common,
    command,
    args: (input.args ?? []).map((arg) => String(arg)),
    ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
    ...(Object.keys(cleanRecord(input.env)).length ? { env: cleanRecord(input.env) } : {}),
    ...(cleanList(input.envVars).length ? { env_vars: cleanList(input.envVars) } : {}),
    ...(secretEnv.length ? { secret_env: secretEnv } : {}),
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
    secretEnvVars: [...(config.secretEnvVars ?? [])],
    ...(config.url ? { url: config.url } : {}),
    auth: config.auth === "oauth"
      ? "oauth"
      : config.bearerToken || config.bearerTokenEnvVar || credentialStored || hasAuthorizationHeader(config)
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
    httpHeaders: mergeMcpHeaders(config.httpHeaders),
    envHttpHeaders: mergeMcpHeaders(config.envHttpHeaders),
    secretHttpHeaders: normalizeMcpHeaderNames(config.secretHttpHeaders ?? []),
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

function cleanHttpHeaders(values: Record<string, string> | undefined): Record<string, string> {
  return mergeMcpHeaders(cleanRecord(values));
}

function publicMcpServerInput(input: SaveMcpServerInput): SaveMcpServerInput {
  const next = { ...input };
  if (input.transport === "stdio") {
    next.env = partitionMcpValues(input.env, input.secretEnv, "env").publicValues;
  } else {
    next.httpHeaders = partitionMcpValues(input.httpHeaders, input.secretHttpHeaders, "http-header").publicValues;
  }
  delete next.secretEnv;
  delete next.retainedSecretEnv;
  delete next.secretHttpHeaders;
  delete next.retainedSecretHttpHeaders;
  return next;
}

function nextMcpSecretFields(input: SaveMcpServerInput, previous: McpSecretFields): McpSecretFields {
  if (input.transport === "stdio") {
    const partitioned = partitionMcpValues(input.env, input.secretEnv, "env");
    const retained = input.retainedSecretEnv ?? (input.originalID ? Object.keys(previous.env) : []);
    const env = selectRecord(previous.env, retained);
    for (const name of Object.keys(partitioned.publicValues)) delete env[name];
    for (const name of input.envVars ?? []) delete env[name];
    return normalizeMcpSecretFields({ env: { ...env, ...partitioned.secretValues }, httpHeaders: {} });
  }
  const partitioned = partitionMcpValues(input.httpHeaders, input.secretHttpHeaders, "http-header");
  const retained = input.retainedSecretHttpHeaders ?? (input.originalID ? Object.keys(previous.httpHeaders) : []);
  const httpHeaders = selectRecord(previous.httpHeaders, retained);
  for (const name of Object.keys(partitioned.publicValues)) deleteRecordKeyCaseInsensitive(httpHeaders, name);
  for (const name of Object.keys(input.envHttpHeaders ?? {})) deleteRecordKeyCaseInsensitive(httpHeaders, name);
  return normalizeMcpSecretFields({ env: {}, httpHeaders: mergeMcpHeaders(httpHeaders, partitioned.secretValues) });
}

function partitionMcpValues(
  values: Record<string, string> | undefined,
  explicitSecrets: Record<string, string> | undefined,
  kind: "env" | "http-header"
): { publicValues: Record<string, string>; secretValues: Record<string, string> } {
  const publicValues: Record<string, string> = {};
  const secretValues: Record<string, string> = {};
  const cleanedValues = kind === "http-header" ? cleanHttpHeaders(values) : cleanRecord(values);
  const cleanedSecrets = kind === "http-header" ? cleanHttpHeaders(explicitSecrets) : cleanRecord(explicitSecrets);
  for (const [name, value] of Object.entries(cleanedValues)) {
    if (isSensitiveMcpField(kind, name)) secretValues[name] = value;
    else publicValues[name] = value;
  }
  for (const [name, value] of Object.entries(cleanedSecrets)) {
    if (kind === "http-header") deleteRecordKeyCaseInsensitive(publicValues, name);
    else delete publicValues[name];
    secretValues[name] = value;
  }
  return { publicValues, secretValues };
}

function inlineSensitiveMcpFields(server: ExternalMcpServer): McpSecretFields {
  const envMarkers = new Set(server.secretEnvVars ?? []);
  const headerMarkers = new Set((server.secretHttpHeaders ?? []).map((name) => name.toLowerCase()));
  return normalizeMcpSecretFields({
    env: Object.fromEntries(Object.entries(server.env ?? {}).filter(([name]) => envMarkers.has(name) || isSensitiveMcpField("env", name))),
    httpHeaders: Object.fromEntries(Object.entries(server.httpHeaders ?? {}).filter(([name]) => headerMarkers.has(name.toLowerCase()) || isSensitiveMcpField("http-header", name)))
  });
}

function redactInlineMcpSecrets(server: ExternalMcpServer): ExternalMcpServer {
  const inline = inlineSensitiveMcpFields(server);
  if (!hasMcpSecretFields(inline)) return server;
  if (server.type === "stdio") {
    const env = { ...(server.env ?? {}) };
    for (const name of Object.keys(inline.env)) delete env[name];
    const { env: _inlineEnv, ...rest } = server;
    return {
      ...rest,
      ...(Object.keys(env).length ? { env } : {}),
      secretEnvVars: cleanList([...(server.secretEnvVars ?? []), ...Object.keys(inline.env)])
    };
  }
  const httpHeaders = mergeMcpHeaders(server.httpHeaders);
  for (const name of Object.keys(inline.httpHeaders)) deleteMcpHeader(httpHeaders, name);
  const { httpHeaders: _inlineHeaders, ...rest } = server;
  return {
    ...rest,
    ...(Object.keys(httpHeaders).length ? { httpHeaders } : {}),
    secretHttpHeaders: normalizeMcpHeaderNames([...(server.secretHttpHeaders ?? []), ...Object.keys(inline.httpHeaders)])
  };
}

function mergeMcpSecretFields(base: McpSecretFields, over: McpSecretFields): McpSecretFields {
  return normalizeMcpSecretFields({ env: { ...base.env, ...over.env }, httpHeaders: mergeMcpHeaders(base.httpHeaders, over.httpHeaders) });
}

function hasMcpSecretFields(fields: McpSecretFields): boolean {
  return Object.keys(fields.env).length > 0 || Object.keys(fields.httpHeaders).length > 0;
}

function hasMcpSecretFieldState(server: ExternalMcpServer): boolean {
  return Boolean(server.secretEnvVars?.length || server.secretHttpHeaders?.length || hasMcpSecretFields(inlineSensitiveMcpFields(server)));
}

function assertMcpStoredFields(server: ExternalMcpServer, fields: McpSecretFields): void {
  const missingEnv = (server.secretEnvVars ?? []).filter((name) => fields.env[name] === undefined);
  const missingHeaders = (server.secretHttpHeaders ?? []).filter((name) => !Object.keys(fields.httpHeaders).some((key) => key.toLowerCase() === name.toLowerCase()));
  if (!missingEnv.length && !missingHeaders.length) return;
  const missing = [...missingEnv.map((name) => `env ${name}`), ...missingHeaders.map((name) => `header ${name}`)].join(", ");
  throw new Error(`MCP server ${server.name} is missing stored secret values for ${missing}`);
}

function parseMcpSecretFields(serialized: string): McpSecretFields {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyMcpSecretFields();
    const record = parsed as Record<string, unknown>;
    return normalizeMcpSecretFields({
      env: stringRecord(record.env),
      httpHeaders: stringRecord(record.httpHeaders ?? record.http_headers)
    });
  } catch {
    return emptyMcpSecretFields();
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function selectRecord(values: Record<string, string>, names: string[]): Record<string, string> {
  return Object.fromEntries(names.filter((name) => values[name] !== undefined).map((name) => [name, values[name]!]));
}

function deleteRecordKeyCaseInsensitive(values: Record<string, string>, name: string): void {
  deleteMcpHeader(values, name);
}

async function migrateInlineMcpSecretFields(workspace: string): Promise<void> {
  for (const location of ["global", "project"] as const) {
    const path = configPath(location, workspace);
    const config = loadRawConfig(path);
    const servers = { ...(config.mcpServers ?? {}) };
    let changed = false;
    for (const [id, entry] of Object.entries(servers)) {
      const server = normalizeServer(id, entry);
      const inline = inlineSensitiveMcpFields(server);
      if (!hasMcpSecretFields(inline)) continue;
      try {
        const stored = await readMcpSecretFields(id, location, workspace);
        const merged = mergeMcpSecretFields(stored, inline);
        await writeMcpSecretFields(id, merged, location, workspace);
        servers[id] = mcpEntryWithoutInlineSecrets(entry, inline, merged);
        changed = true;
      } catch {
      }
    }
    if (changed) {
      try { writeConfig({ ...config, mcpServers: servers }, location, workspace); } catch {
      }
    }
  }
}

function mcpEntryWithoutInlineSecrets(entry: Record<string, unknown>, inline: McpSecretFields, stored: McpSecretFields): Record<string, unknown> {
  const next = { ...entry };
  const env = stringRecord(entry.env);
  for (const name of Object.keys(inline.env)) delete env[name];
  if (Object.keys(env).length) next.env = env;
  else delete next.env;
  const headers = stringRecord(entry.http_headers ?? entry.httpHeaders);
  for (const name of Object.keys(inline.httpHeaders)) deleteRecordKeyCaseInsensitive(headers, name);
  delete next.httpHeaders;
  if (Object.keys(headers).length) next.http_headers = headers;
  else delete next.http_headers;
  const secretEnv = cleanList(Object.keys(stored.env));
  const secretHeaders = normalizeMcpHeaderNames(Object.keys(stored.httpHeaders));
  if (secretEnv.length) next.secret_env = secretEnv;
  else delete next.secret_env;
  if (secretHeaders.length) next.secret_http_headers = secretHeaders;
  else delete next.secret_http_headers;
  return next;
}

async function restoreCredentials(entries: Record<string, string | undefined>, touched: Set<string>, location: ConfigLocation, workspace: string): Promise<string[]> {
  const errors: string[] = [];
  for (const key of touched) {
    const [kind, resourceID] = parseCredentialSnapshotKey(key);
    try {
      const value = entries[key];
      if (value) await writeCredential(kind, resourceID, value, location, workspace);
      else await deleteCredential(kind, resourceID, location, workspace);
    } catch (error) {
      errors.push(`${kind}/${resourceID}: ${errorMessage(error)}`);
    }
  }
  return errors;
}

async function removeManagedCredential(kind: CredentialKind, id: string, location: ConfigLocation, workspace: string, touched: Set<string>): Promise<void> {
  touched.add(credentialSnapshotKey(kind, id));
  await deleteCredential(kind, id, location, workspace);
}

function credentialSnapshotKey(kind: CredentialKind, id: string): string {
  return `${kind}\u0000${id}`;
}

function parseCredentialSnapshotKey(value: string): [CredentialKind, string] {
  const index = value.indexOf("\u0000");
  return [value.slice(0, index) as CredentialKind, value.slice(index + 1)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasAuthorizationHeader(config: ExternalMcpServer): boolean {
  return Object.keys(config.httpHeaders ?? {}).some((name) => name.toLowerCase() === "authorization")
    || Object.keys(config.envHttpHeaders ?? {}).some((name) => name.toLowerCase() === "authorization")
    || (config.secretHttpHeaders ?? []).some((name) => name.toLowerCase() === "authorization");
}
