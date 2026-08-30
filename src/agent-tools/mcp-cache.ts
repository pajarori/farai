import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { globalDataDir } from "../agent-core/config";
import type { ExternalMcpServer, McpPromptDescriptor, McpResourceDescriptor, McpResourceTemplateDescriptor, McpToolDescriptor } from "./mcp-adapter";

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
  migrateLegacyCache();
  const signature = mcpCatalogSignature(config);
  const entry = readEntry(cacheEntryPath(config.name, signature));
  return entry?.server === config.name && entry.catalog.signature === signature
    ? { ...entry.catalog, prompts: entry.catalog.prompts ?? [] }
    : undefined;
}

export function saveMcpCachedCatalog(config: ExternalMcpServer, catalog: Omit<McpCachedCatalog, "signature" | "cachedAt">): void {
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
  migrateLegacyCache();
  const directory = cacheDirectory();
  if (!existsSync(directory)) return;
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
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== 2 || typeof parsed.server !== "string" || !isCatalog(parsed.catalog)) return undefined;
    return parsed as McpCacheEntryFile;
  } catch {
    return undefined;
  }
}

function writeEntry(path: string, entry: McpCacheEntryFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

function migrateLegacyCache(): void {
  const legacyPath = legacyCachePath();
  if (!existsSync(legacyPath)) return;
  let legacy: LegacyMcpCacheFile | undefined;
  try {
    const parsed = JSON.parse(readFileSync(legacyPath, "utf8")) as unknown;
    if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.servers)) legacy = parsed as LegacyMcpCacheFile;
  } catch {}
  if (legacy) {
    for (const [server, catalog] of Object.entries(legacy.servers)) {
      if (!isCatalog(catalog)) continue;
      const path = cacheEntryPath(server, catalog.signature);
      if (!existsSync(path)) writeEntry(path, { version: 2, server, catalog });
    }
  }
  try { unlinkSync(legacyPath); } catch {}
}

function isCatalog(value: unknown): value is McpCachedCatalog {
  if (!isRecord(value)) return false;
  return typeof value.signature === "string"
    && typeof value.cachedAt === "string"
    && Array.isArray(value.tools)
    && (value.prompts === undefined || Array.isArray(value.prompts))
    && Array.isArray(value.resources)
    && Array.isArray(value.resourceTemplates);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
