import { createHash } from "node:crypto";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { globalDataDir } from "../agent-core/config";
import { mcpCatalogLimits, normalizeMcpPrompt, normalizeMcpResource, normalizeMcpResourceTemplate, sanitizeMcpTool, type ExternalMcpServer, type McpPromptDescriptor, type McpResourceDescriptor, type McpResourceTemplateDescriptor, type McpToolDescriptor } from "./mcp-adapter";
import { readBoundedFileTextSyncNoFollow } from "../file-read";
import { atomicWriteFile } from "../agent-core/atomic-file";
import { takeBytes } from "./shared/output-bound";
import { ensurePrivateDirectory, ensurePrivateRegularFileIfExists } from "../agent-core/private-path";

const MCP_CACHE_ENTRY_MAX_BYTES = 64 * 1024 * 1024;
const MCP_LEGACY_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const MCP_CACHE_IDENTIFIER_MAX_BYTES = 1_024;
const MCP_CACHE_METADATA_MAX_BYTES = 2 * 1024;

export type McpCachedCatalog = {
  signature: string;
  cachedAt: string;
  tools: McpToolDescriptor[];
  prompts: McpPromptDescriptor[];
  resources: McpResourceDescriptor[];
  resourceTemplates: McpResourceTemplateDescriptor[];
  serverInfo?: { name?: string; version?: string; instructions?: string };
};

type LegacyMcpCacheFile = {
  version: 1;
  servers: Record<string, McpCachedCatalog>;
};

type McpCacheEntryFile = {
  version: 2;
  server: string;
  catalog: McpCachedCatalog;
};

export function loadMcpCachedCatalog(config: ExternalMcpServer): McpCachedCatalog | undefined {
  ensurePrivateDirectory(globalDataDir(), "farai home directory");
  migrateLegacyCache();
  const signature = mcpCatalogSignature(config);
  const entry = readEntry(cacheEntryPath(config.name, signature));
  return entry?.server === config.name && entry.catalog.signature === signature
    ? { ...entry.catalog, prompts: entry.catalog.prompts ?? [] }
    : undefined;
}

export function saveMcpCachedCatalog(config: ExternalMcpServer, catalog: Omit<McpCachedCatalog, "signature" | "cachedAt">): void {
  ensurePrivateDirectory(globalDataDir(), "farai home directory");
  migrateLegacyCache();
  const signature = mcpCatalogSignature(config);
  writeEntry(cacheEntryPath(config.name, signature), {
    version: 2,
    server: config.name,
    catalog: {
      signature,
      cachedAt: new Date().toISOString(),
      tools: catalog.tools,
      prompts: catalog.prompts,
      resources: catalog.resources,
      resourceTemplates: catalog.resourceTemplates,
      ...(catalog.serverInfo ? { serverInfo: catalog.serverInfo } : {})
    }
  });
}

export function removeMcpCachedCatalog(serverName: string): void {
  ensurePrivateDirectory(globalDataDir(), "farai home directory");
  migrateLegacyCache();
  const directory = cacheDirectory();
  if (!existsSync(directory)) return;
  ensurePrivateDirectory(directory, "mcp cache directory");
  const prefix = `${serverCacheKey(serverName)}-`;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const path = join(directory, name);
    const entry = readEntry(path);
    if (entry?.server !== serverName) continue;
    try { unlinkSync(path); } catch {}
  }
}

export function mcpCatalogSignature(config: ExternalMcpServer): string {
  return Bun.hash(JSON.stringify({
    type: config.type,
    command: config.command,
    args: config.args,
    url: config.url,
    cwd: config.cwd,
    env: config.env,
    envVars: config.envVars,
    runInContainer: config.runInContainer,
    auth: config.auth,
    oauth: config.oauth,
    bearerTokenEnvVar: config.bearerTokenEnvVar,
    bearerToken: config.bearerToken ? Bun.hash(config.bearerToken).toString(36) : undefined,
    httpHeaders: config.httpHeaders ? Object.fromEntries(Object.entries(config.httpHeaders).map(([name, value]) => [name, Bun.hash(value).toString(36)])) : undefined,
    envHttpHeaders: config.envHttpHeaders,
    enabledTools: config.enabledTools,
    disabledTools: config.disabledTools
  })).toString(36);
}

function cacheDirectory(): string {
  return join(globalDataDir(), "mcp-tool-cache");
}

function legacyCachePath(): string {
  return join(globalDataDir(), "mcp-tool-cache.json");
}

function cacheEntryPath(serverName: string, signature: string): string {
  return join(cacheDirectory(), `${serverCacheKey(serverName)}-${signature}.json`);
}

function serverCacheKey(serverName: string): string {
  return createHash("sha256").update(serverName).digest("hex").slice(0, 24);
}

function readEntry(path: string): McpCacheEntryFile | undefined {
  try {
    ensurePrivateRegularFileIfExists(path, "mcp cache entry");
    const parsed = JSON.parse(readBoundedFileTextSyncNoFollow(path, MCP_CACHE_ENTRY_MAX_BYTES, "mcp cache entry")) as unknown;
    return normalizeCacheEntry(parsed);
  } catch {
    return undefined;
  }
}

function writeEntry(path: string, entry: McpCacheEntryFile): void {
  const normalized = normalizeCacheEntry(entry, entry.server);
  if (!normalized) throw new Error("mcp cache entry is invalid");
  const serialized = `${JSON.stringify(normalized)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MCP_CACHE_ENTRY_MAX_BYTES) throw new Error(`mcp cache entry exceeded ${MCP_CACHE_ENTRY_MAX_BYTES} bytes`);
  ensurePrivateDirectory(dirname(path), "mcp cache directory");
  ensurePrivateRegularFileIfExists(path, "mcp cache entry");
  atomicWriteFile(path, serialized, 0o600);
}

function migrateLegacyCache(): void {
  const legacyPath = legacyCachePath();
  if (!existsSync(legacyPath)) return;
  let legacy: LegacyMcpCacheFile | undefined;
  try {
    ensurePrivateRegularFileIfExists(legacyPath, "legacy mcp cache");
    const parsed = JSON.parse(readBoundedFileTextSyncNoFollow(legacyPath, MCP_LEGACY_CACHE_MAX_BYTES, "legacy mcp cache")) as unknown;
    if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.servers)) legacy = parsed as LegacyMcpCacheFile;
  } catch {}
  if (legacy) {
    for (const [server, catalog] of Object.entries(legacy.servers)) {
      const normalized = normalizeCatalog(catalog, server);
      if (!normalized) continue;
      const path = cacheEntryPath(server, catalog.signature);
      if (!existsSync(path)) writeEntry(path, { version: 2, server, catalog: normalized });
    }
  }
  try { unlinkSync(legacyPath); } catch {}
}

function normalizeCacheEntry(value: unknown, expectedServer?: string): McpCacheEntryFile | undefined {
  if (!isRecord(value) || value.version !== 2 || typeof value.server !== "string") return undefined;
  const server = boundedIdentifier(value.server);
  if (!server || (expectedServer !== undefined && server !== expectedServer)) return undefined;
  const catalog = normalizeCatalog(value.catalog, server);
  return catalog ? { version: 2, server, catalog } : undefined;
}

function normalizeCatalog(value: unknown, server: string): McpCachedCatalog | undefined {
  if (!isRecord(value) || typeof value.signature !== "string" || typeof value.cachedAt !== "string") return undefined;
  if (!boundedIdentifier(value.signature) || !Number.isFinite(Date.parse(value.cachedAt))) return undefined;
  const rawTools = boundedCatalogArray(value.tools, "tools/list");
  const rawPrompts = boundedCatalogArray(value.prompts ?? [], "prompts/list");
  const rawResources = boundedCatalogArray(value.resources, "resources/list");
  const rawTemplates = boundedCatalogArray(value.resourceTemplates, "resources/templates/list");
  if (!rawTools || !rawPrompts || !rawResources || !rawTemplates) return undefined;
  try {
    const tools = rawTools.map((tool) => normalizeCachedTool(tool, server));
    const prompts = rawPrompts.map(normalizeCachedPrompt);
    const resources = rawResources.map(normalizeCachedResource);
    const resourceTemplates = rawTemplates.map(normalizeCachedResourceTemplate);
    const serverInfo = normalizeCachedServerInfo(value.serverInfo);
    return {
      signature: value.signature,
      cachedAt: value.cachedAt,
      tools,
      prompts,
      resources,
      resourceTemplates,
      ...(serverInfo ? { serverInfo } : {})
    };
  } catch {
    return undefined;
  }
}

function boundedCatalogArray(value: unknown, method: string): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const limits = mcpCatalogLimits(method);
  if (value.length > limits.items) return undefined;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > limits.bytes) return undefined;
  return value;
}

function normalizeCachedTool(value: unknown, server: string): McpToolDescriptor {
  if (!isRecord(value) || value.server !== server || typeof value.name !== "string" || typeof value.mutates !== "boolean") throw new Error("invalid cached mcp tool");
  const normalized = sanitizeMcpTool(server, {
    name: value.name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(isRecord(value.inputSchema) ? { inputSchema: value.inputSchema } : {})
  });
  return { ...normalized, mutates: value.mutates };
}

function normalizeCachedPrompt(value: unknown): McpPromptDescriptor {
  if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.arguments)) throw new Error("invalid cached mcp prompt");
  const args = value.arguments.map((argument) => {
    if (!isRecord(argument) || typeof argument.name !== "string" || typeof argument.required !== "boolean") throw new Error("invalid cached mcp prompt argument");
    if (argument.description !== undefined && typeof argument.description !== "string") throw new Error("invalid cached mcp prompt argument description");
    return {
      name: argument.name,
      ...(typeof argument.description === "string" ? { description: argument.description } : {}),
      required: argument.required
    };
  });
  if (value.title !== undefined && typeof value.title !== "string") throw new Error("invalid cached mcp prompt title");
  if (value.description !== undefined && typeof value.description !== "string") throw new Error("invalid cached mcp prompt description");
  return normalizeMcpPrompt({
    name: value.name,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    arguments: args
  });
}

function normalizeCachedResource(value: unknown): McpResourceDescriptor {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.uri !== "string") throw new Error("invalid cached mcp resource");
  return normalizeMcpResource(value as { name: string; uri: string; title?: unknown; description?: unknown; mimeType?: unknown });
}

function normalizeCachedResourceTemplate(value: unknown): McpResourceTemplateDescriptor {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.uriTemplate !== "string") throw new Error("invalid cached mcp resource template");
  return normalizeMcpResourceTemplate(value as { name: string; uriTemplate: string; title?: unknown; description?: unknown; mimeType?: unknown });
}

function normalizeCachedServerInfo(value: unknown): McpCachedCatalog["serverInfo"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("invalid cached mcp server info");
  const name = value.name === undefined ? undefined : typeof value.name === "string" ? boundedIdentifier(value.name) : undefined;
  const version = value.version === undefined ? undefined : typeof value.version === "string" ? boundedIdentifier(value.version) : undefined;
  if ((value.name !== undefined && !name) || (value.version !== undefined && !version)) throw new Error("invalid cached mcp server identity");
  if (value.instructions !== undefined && typeof value.instructions !== "string") throw new Error("invalid cached mcp server instructions");
  const instructions = typeof value.instructions === "string" ? boundedMetadata(value.instructions) : undefined;
  return name || version || instructions ? { ...(name ? { name } : {}), ...(version ? { version } : {}), ...(instructions ? { instructions } : {}) } : undefined;
}

function boundedIdentifier(value: string): string | undefined {
  if (!value || Buffer.byteLength(value, "utf8") > MCP_CACHE_IDENTIFIER_MAX_BYTES) return undefined;
  return value;
}

function boundedMetadata(value: string): string {
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, "utf8") <= MCP_CACHE_METADATA_MAX_BYTES) return trimmed;
  return `${takeBytes(trimmed, MCP_CACHE_METADATA_MAX_BYTES - 32, "head")}\n[truncated by farai]`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
