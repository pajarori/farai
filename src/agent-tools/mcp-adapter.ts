import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { ElicitRequestSchema, GetPromptResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { isMcpBackboneServer } from "./mcp-builtins";
import { takeBytes } from "./shared/output-bound";
import { FARAI_VERSION } from "../version";
import { deleteMcpHeader, mergeMcpHeaders } from "../agent-core/mcp-headers";
import { BoundedOutputBuffer } from "./backends/output-buffer";
import { isolatedProcessGroup, terminateProcessTree } from "./backends/process-tree";
import { readBoundedFileText } from "../file-read";
import { ResponseSizeLimitError } from "../http-response";

type ExternalMcpServerCommon = {
  name: string;
  enabled: boolean;
  required: boolean;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  autoStart: boolean;
  enabledTools?: string[];
  disabledTools?: string[];
  mitmproxy?: {
    autoStartProxy: boolean;
    port: number;
    dumpFile?: string;
    upstreamProxy?: string;
  };
};

export type ExternalMcpServer = ExternalMcpServerCommon & {
  type: "stdio" | "http";
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  envVars?: string[];
  secretEnvVars?: string[];
  runInContainer: boolean;
  url?: string;
  auth?: "none" | "oauth";
  oauth?: {
    clientId?: string;
    callbackUrl?: string;
    scopes?: string[];
  };
  bearerTokenEnvVar?: string;
  bearerToken?: string;
  httpHeaders?: Record<string, string>;
  envHttpHeaders?: Record<string, string>;
  secretHttpHeaders?: string[];
};

export type ExternalMcpHttpServer = ExternalMcpServer & { type: "http"; url: string };

export type McpOAuthState = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokensExpiresAt?: string;
  codeVerifier?: string;
};

export type McpOAuthStore = {
  load(): McpOAuthState;
  save(state: McpOAuthState): void;
};

export function mcpOAuthStateAuthenticated(state: McpOAuthState, now = Date.now()): boolean {
  if (!state.tokens?.access_token) return false;
  if (state.tokens.refresh_token) return true;
  if (!state.tokensExpiresAt) return true;
  const expiresAt = Date.parse(state.tokensExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export type McpToolDescriptor = {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  mutates: boolean;
};

export type McpResourceDescriptor = {
  name: string;
  title?: string;
  uri: string;
  mimeType?: string;
  description?: string;
};

export type McpResourceTemplateDescriptor = {
  name: string;
  title?: string;
  uriTemplate: string;
  mimeType?: string;
  description?: string;
};

export type McpPromptArgumentDescriptor = {
  name: string;
  description?: string;
  required: boolean;
};

export type McpPromptDescriptor = {
  name: string;
  title?: string;
  description?: string;
  arguments: McpPromptArgumentDescriptor[];
};

export type McpPromptResult = {
  description?: string;
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
};

export type McpFormElicitationRequest = {
  mode: "form";
  message: string;
  requestedSchema: Record<string, unknown>;
};

export type McpElicitationResult = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

export type McpElicitationHandler = (request: McpFormElicitationRequest, signal?: AbortSignal) => Promise<McpElicitationResult>;

export type McpCatalogChange = "tools" | "prompts" | "resources";

type RawMcpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
};

type RawMcpResource = {
  name: string;
  title?: string;
  uri: string;
  mimeType?: string;
  mime_type?: string;
  description?: string;
};

type RawMcpResourceTemplate = {
  name: string;
  title?: string;
  uriTemplate?: string;
  uri_template?: string;
  mimeType?: string;
  mime_type?: string;
  description?: string;
};

type RawMcpPrompt = {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{
    name?: string;
    description?: string;
    required?: boolean;
  }>;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const DEFAULT_MITMPROXY_PORT = 31_337;
const MAX_TCP_PORT = 65_535;
const MAX_STDIO_BUFFER_BYTES = 10 * 1024 * 1024;
const MCP_CONFIG_MAX_BYTES = 4 * 1024 * 1024;
const MCP_MODEL_METADATA_MAX_BYTES = 2 * 1024;
const MCP_SCHEMA_MAX_BYTES = 256 * 1024;
const MCP_SCHEMA_MAX_DEPTH = 32;
const MCP_SCHEMA_MAX_NODES = 20_000;
const MCP_SCHEMA_MAX_ITEMS = 1_000;
const MCP_PROMPT_RESULT_MAX_BYTES = 8 * 1024 * 1024;
const MCP_PROMPT_MESSAGE_MAX_COUNT = 256;
const MCP_HTTP_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const MCP_HTTP_SSE_MAX_BYTES = 256 * 1024 * 1024;
const MCP_MAX_CURSOR_BYTES = 64 * 1024;
const STDIO_CLOSE_GRACE_MS = 250;
const STDIO_TERM_GRACE_MS = 500;
const STDIO_KILL_GRACE_MS = 1_000;
const HTTP_TERMINATE_GRACE_MS = 250;
export const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";
const MCP_LEGACY_PROTOCOL_VERSIONS = [MCP_LEGACY_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"] as const;

type McpProcessState = {
  proc: ChildProcessWithoutNullStreams;
  buffer: Buffer;
  stderr: BoundedOutputBuffer;
  closing: boolean;
  ended: boolean;
  closed: boolean;
  exitPromise: Promise<void>;
  closePromise: Promise<void>;
  resolveExit: () => void;
  resolveClose: () => void;
  serverRequests: Map<string | number, AbortController>;
  failure?: Error;
};

type PendingMcpRequest = {
  state: McpProcessState;
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
};

class McpPaginationGuard {
  private readonly seen = new Set<string>();
  private pages = 0;
  private items = 0;
  private bytes = 0;

  constructor(private readonly limits: { pages: number; items: number; bytes: number }) {}

  next(value: unknown, addedItems: number, addedBytes: number, method: string): string | undefined {
    this.pages += 1;
    this.items += addedItems;
    this.bytes += addedBytes;
    if (this.items > this.limits.items) throw new Error(`MCP ${method} exceeded ${this.limits.items} items`);
    if (this.bytes > this.limits.bytes) throw new Error(`MCP ${method} exceeded ${this.limits.bytes} bytes`);
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") throw new Error(`MCP ${method} returned an invalid cursor`);
    if (Buffer.byteLength(value, "utf8") > MCP_MAX_CURSOR_BYTES) throw new Error(`MCP ${method} cursor exceeded ${MCP_MAX_CURSOR_BYTES} bytes`);
    if (this.seen.has(value)) throw new Error(`MCP ${method} repeated a pagination cursor`);
    if (this.pages >= this.limits.pages) throw new Error(`MCP ${method} exceeded ${this.limits.pages} pages`);
    this.seen.add(value);
    return value;
  }
}

export function mcpCatalogLimits(method: string): { pages: number; items: number; bytes: number } {
  if (method === "tools/list") return { pages: 25, items: 512, bytes: 8 * 1024 * 1024 };
  if (method === "prompts/list") return { pages: 25, items: 1_024, bytes: 8 * 1024 * 1024 };
  return { pages: 50, items: 4_096, bytes: 16 * 1024 * 1024 };
}

function mcpCatalogPageBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export interface McpClientTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  lastError(): string | undefined;
  initialize(signal?: AbortSignal): Promise<unknown>;
  listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  listResources(signal?: AbortSignal): Promise<McpResourceDescriptor[]>;
  listResourceTemplates(signal?: AbortSignal): Promise<McpResourceTemplateDescriptor[]>;
  readResource(uri: string, signal?: AbortSignal): Promise<unknown>;
  listPrompts(signal?: AbortSignal): Promise<McpPromptDescriptor[]>;
  getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<McpPromptResult>;
  setElicitationHandler(handler: McpElicitationHandler | undefined): void;
  serverInfo(): { name?: string; version?: string; instructions?: string };
  setCatalogChangeHandler(handler: ((change: McpCatalogChange) => void) | undefined): void;
}

export function normalizeMcpServerEntry(entry: Record<string, unknown>): ExternalMcpServer {
  const obj = entry;
  const url = typeof obj.url === "string" ? normalizeMcpUrl(obj.url) : undefined;
  const common = {
    name: String(obj.name),
    enabled: isMcpBackboneServer(String(obj.name ?? "")) || obj.enabled !== false,
    required: (obj.required ?? false) === true,
    startupTimeoutMs: secondsOrMs(obj.startup_timeout_sec, obj.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS),
    toolTimeoutMs: secondsOrMs(obj.tool_timeout_sec, obj.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS),
    autoStart: (obj.auto_start ?? obj.autoStart) !== false,
    ...(Array.isArray(obj.enabled_tools) ? { enabledTools: obj.enabled_tools.map(String) } : {}),
    ...(Array.isArray(obj.enabledTools) ? { enabledTools: obj.enabledTools.map(String) } : {}),
    ...(Array.isArray(obj.disabled_tools) ? { disabledTools: obj.disabled_tools.map(String) } : {}),
    ...(Array.isArray(obj.disabledTools) ? { disabledTools: obj.disabledTools.map(String) } : {}),
    ...(isRecord(obj.mitmproxy) ? { mitmproxy: normalizeMitmproxyConfig(obj.mitmproxy) } : {})
  } satisfies ExternalMcpServerCommon;
  if (url) {
    const httpHeaders = mergeMcpHeaders(stringRecord(obj.http_headers ?? obj.httpHeaders));
    const envHttpHeaders = mergeMcpHeaders(stringRecord(obj.env_http_headers ?? obj.envHttpHeaders));
    const secretHttpHeaders = stringArray(obj.secret_http_headers ?? obj.secretHttpHeaders);
    return {
      ...common,
      type: "http",
      command: "",
      args: [],
      url,
      runInContainer: false,
      auth: (obj.auth === "oauth" || isRecord(obj.oauth)) ? "oauth" : "none",
      ...(isRecord(obj.oauth) ? { oauth: normalizeOAuthConfig(obj.oauth) } : {}),
      ...(typeof (obj.bearer_token_env_var ?? obj.bearerTokenEnvVar) === "string"
        ? { bearerTokenEnvVar: String(obj.bearer_token_env_var ?? obj.bearerTokenEnvVar) }
        : {}),
      ...(typeof (obj.bearer_token ?? obj.bearerToken) === "string"
        ? { bearerToken: String(obj.bearer_token ?? obj.bearerToken) }
        : {}),
      ...(Object.keys(httpHeaders).length ? { httpHeaders } : {}),
      ...(Object.keys(envHttpHeaders).length ? { envHttpHeaders } : {}),
      ...(secretHttpHeaders.length ? { secretHttpHeaders } : {})
    };
  }
  const env = isRecord(obj.env)
    ? Object.fromEntries(Object.entries(obj.env).filter((item): item is [string, string] => typeof item[1] === "string"))
    : undefined;
  const envVars = obj.env_vars ?? obj.envVars;
  const secretEnvVars = stringArray(obj.secret_env ?? obj.secretEnv);
  return {
    ...common,
    type: "stdio",
    command: String(obj.command),
    args: Array.isArray(obj.args) ? obj.args.map(String) : [],
    ...(typeof obj.cwd === "string" ? { cwd: obj.cwd } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...(Array.isArray(envVars) ? { envVars: envVars.map(String) } : {}),
    ...(secretEnvVars.length ? { secretEnvVars } : {}),
    runInContainer: (obj.run_in_container ?? obj.runInContainer) !== false
  };
}

export function mcpServersFromConfig(servers: Record<string, Record<string, unknown>>): ExternalMcpServer[] {
  return Object.entries(servers).map(([name, entry]) => normalizeMcpServerEntry({ name, ...entry }));
}

export async function loadExternalMcpConfig(path = ".farai/mcp.json"): Promise<ExternalMcpServer[]> {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(await readBoundedFileText(path, MCP_CONFIG_MAX_BYTES, "mcp config")) as unknown;
  return normalizeMcpConfigEntries(parsed).map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid MCP server config");
    return normalizeMcpServerEntry(entry as Record<string, unknown>);
  });
}

export function sanitizeMcpTool(
  server: string,
  tool: RawMcpTool
): McpToolDescriptor {
  const text = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  const mutates = (tool.annotations?.readOnlyHint === true ? false : undefined) ?? /add|append|click|create|delete|edit|fill|patch|press|remove|save|select|set|submit|type|update|upload|write|run/.test(text);
  return {
    server,
    name: boundedMcpIdentifier(tool.name, "mcp tool name"),
    ...(typeof tool.description === "string" && tool.description ? { description: boundedMcpMetadata(tool.description) } : {}),
    ...(tool.inputSchema ? { inputSchema: boundedMcpInputSchema(tool.inputSchema) } : {}),
    mutates
  };
}

export async function boundedMcpFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return boundMcpHttpResponse(await fetch(input, init));
}

export function boundMcpHttpResponse(response: Response, overrideMaxBytes?: number): Response {
  const maxBytes = overrideMaxBytes ?? ((response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")
    ? MCP_HTTP_SSE_MAX_BYTES
    : MCP_HTTP_RESPONSE_MAX_BYTES);
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new ResponseSizeLimitError("mcp http response", maxBytes);
    }
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let observed = 0;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          release();
          controller.close();
          return;
        }
        observed += next.value.byteLength;
        if (observed > maxBytes) {
          const error = new ResponseSizeLimitError("mcp http response", maxBytes);
          await reader.cancel(error).catch(() => undefined);
          release();
          controller.error(error);
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      release();
    }
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

function boundedMcpInputSchema(value: unknown): Record<string, unknown> {
  const cloned = cloneBoundedMcpJson(value, "mcp tool input schema", {
    bytes: MCP_SCHEMA_MAX_BYTES,
    depth: MCP_SCHEMA_MAX_DEPTH,
    nodes: MCP_SCHEMA_MAX_NODES,
    items: MCP_SCHEMA_MAX_ITEMS
  });
  if (!isRecord(cloned)) throw new Error("mcp tool input schema must be an object");
  return cloned;
}

function cloneBoundedMcpJson(
  value: unknown,
  label: string,
  limits: { bytes: number; depth: number; nodes: number; items: number }
): unknown {
  const cloned = cloneMcpJsonValue(value, 0, { nodes: 0, seen: new WeakSet<object>() }, label, limits);
  const bytes = Buffer.byteLength(JSON.stringify(cloned), "utf8");
  if (bytes > limits.bytes) throw new Error(`${label} exceeded ${limits.bytes} bytes`);
  return cloned;
}

function cloneMcpJsonValue(
  value: unknown,
  depth: number,
  state: { nodes: number; seen: WeakSet<object> },
  label: string,
  limits: { bytes: number; depth: number; nodes: number; items: number }
): unknown {
  state.nodes += 1;
  if (state.nodes > limits.nodes) throw new Error(`${label} exceeded ${limits.nodes} nodes`);
  if (depth > limits.depth) throw new Error(`${label} exceeded depth ${limits.depth}`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (!value || typeof value !== "object") throw new Error(`${label} contains a non-json value`);
  if (state.seen.has(value)) throw new Error(`${label} contains a cycle`);
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > limits.items) throw new Error(`${label} array exceeded ${limits.items} items`);
    const cloned = value.map((item) => cloneMcpJsonValue(item, depth + 1, state, label, limits));
    state.seen.delete(value);
    return cloned;
  }
  const entries = Object.entries(value);
  if (entries.length > limits.items) throw new Error(`${label} object exceeded ${limits.items} properties`);
  const cloned = Object.fromEntries(entries.map(([key, child]) => [key, cloneMcpJsonValue(child, depth + 1, state, label, limits)]));
  state.seen.delete(value);
  return cloned;
}

export function normalizeMcpPrompt(prompt: RawMcpPrompt): McpPromptDescriptor {
  return {
    name: boundedMcpIdentifier(prompt.name, "mcp prompt name"),
    ...(typeof prompt.title === "string" && prompt.title ? { title: boundedMcpMetadata(prompt.title) } : {}),
    ...(typeof prompt.description === "string" && prompt.description ? { description: boundedMcpMetadata(prompt.description) } : {}),
    arguments: Array.isArray(prompt.arguments)
      ? prompt.arguments
        .filter((argument): argument is NonNullable<RawMcpPrompt["arguments"]>[number] & { name: string } => Boolean(argument) && typeof argument.name === "string")
        .map((argument) => ({
          name: boundedMcpIdentifier(argument.name, "mcp prompt argument name"),
          ...(typeof argument.description === "string" && argument.description ? { description: boundedMcpMetadata(argument.description) } : {}),
          required: argument.required === true
        }))
      : []
  };
}

export function normalizeMcpPromptResult(value: unknown): McpPromptResult {
  const cloned = cloneBoundedMcpJson(value, "mcp prompt result", {
    bytes: MCP_PROMPT_RESULT_MAX_BYTES,
    depth: 32,
    nodes: 100_000,
    items: 4_096
  });
  const parsed = GetPromptResultSchema.safeParse(cloned);
  if (!parsed.success) throw new Error("MCP server returned an invalid prompt result");
  if (parsed.data.messages.length > MCP_PROMPT_MESSAGE_MAX_COUNT) {
    throw new Error(`MCP prompt result exceeded ${MCP_PROMPT_MESSAGE_MAX_COUNT} messages`);
  }
  return {
    ...(typeof parsed.data.description === "string" ? { description: boundedMcpMetadata(parsed.data.description) } : {}),
    messages: parsed.data.messages.map((message) => ({ role: message.role, content: message.content }))
  };
}

export function normalizeMcpFormElicitationRequest(value: unknown): McpFormElicitationRequest {
  if (!isRecord(value)) throw new Error("invalid MCP elicitation request");
  const mode = value.mode ?? "form";
  if (mode !== "form") throw new Error(`unsupported MCP elicitation mode: ${String(mode)}`);
  if (typeof value.message !== "string" || !value.message.trim()) throw new Error("MCP elicitation message is required");
  if (!isRecord(value.requestedSchema)) throw new Error("MCP elicitation requestedSchema is required");
  return { mode: "form", message: boundedMcpMetadata(value.message), requestedSchema: boundedMcpInputSchema(value.requestedSchema) };
}

export class McpStdioClient implements McpClientTransport {
  private active: McpProcessState | undefined;
  private startTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private initializedState: McpProcessState | undefined;
  private initializeTask: { state: McpProcessState; task: Promise<unknown> } | undefined;
  private nextId = 1;
  private pending = new Map<number, PendingMcpRequest>();
  private lastFailure: string | undefined;
  private initializedInfo: { name?: string; version?: string; instructions?: string } = {};
  private serverCapabilities = { tools: false, prompts: false, resources: false };
  private listChangedCapabilities = { tools: false, prompts: false, resources: false };
  private catalogChangeHandler: ((change: McpCatalogChange) => void) | undefined;
  private elicitationHandler: McpElicitationHandler | undefined;

  constructor(private readonly server: ExternalMcpServer) {}

  async start(): Promise<void> {
    for (;;) {
      if (this.stopTask) {
        await this.stopTask;
        continue;
      }
      if (this.isRunning()) return;
      if (this.startTask) return await this.startTask;
      const task = this.spawnProcess();
      this.startTask = task;
      try {
        return await task;
      } finally {
        if (this.startTask === task) this.startTask = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopTask) return await this.stopTask;
    const task = this.stopProcess();
    this.stopTask = task;
    try {
      await task;
    } finally {
      if (this.stopTask === task) this.stopTask = undefined;
    }
  }

  isRunning(): boolean {
    const state = this.active;
    return Boolean(state && !state.ended && !state.closed && state.proc.exitCode === null && state.proc.signalCode === null);
  }

  lastError(): string | undefined {
    return this.lastFailure;
  }

  serverInfo(): { name?: string; version?: string; instructions?: string } {
    return this.initializedInfo;
  }

  setCatalogChangeHandler(handler: ((change: McpCatalogChange) => void) | undefined): void {
    this.catalogChangeHandler = handler;
  }

  setElicitationHandler(handler: McpElicitationHandler | undefined): void {
    this.elicitationHandler = handler;
  }

  async initialize(signal?: AbortSignal): Promise<unknown> {
    return await this.ensureInitialized(signal);
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    const state = await this.ensureInitializedState(signal);
    if (!this.serverCapabilities.tools) return [];
    const tools = await this.listPagesOnState(state, "tools/list", "tools", this.server.startupTimeoutMs, signal);
    return tools
      .filter((tool): tool is RawMcpTool => isRecord(tool) && typeof tool.name === "string")
      .map((tool) => sanitizeMcpTool(this.server.name, tool));
  }

  async listResources(signal?: AbortSignal): Promise<McpResourceDescriptor[]> {
    const state = await this.ensureInitializedState(signal);
    if (!this.serverCapabilities.resources) return [];
    const resources = await this.listPagesOnState(state, "resources/list", "resources", this.server.startupTimeoutMs, signal);
    return resources
      .filter((resource): resource is RawMcpResource => isRecord(resource) && typeof resource.name === "string" && typeof resource.uri === "string")
      .map((resource) => normalizeMcpResource({
        name: resource.name,
        uri: resource.uri,
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType ?? resource.mime_type
      }));
  }

  async listResourceTemplates(signal?: AbortSignal): Promise<McpResourceTemplateDescriptor[]> {
    const state = await this.ensureInitializedState(signal);
    if (!this.serverCapabilities.resources) return [];
    const templates = await this.listPagesOnState(state, "resources/templates/list", "resourceTemplates", this.server.startupTimeoutMs, signal);
    return templates
      .filter((template): template is RawMcpResourceTemplate => {
        if (!isRecord(template) || typeof template.name !== "string") return false;
        return typeof template.uriTemplate === "string" || typeof template.uri_template === "string";
      })
      .map((template) => normalizeMcpResourceTemplate({
        name: template.name,
        uriTemplate: template.uriTemplate ?? template.uri_template!,
        title: template.title,
        description: template.description,
        mimeType: template.mimeType ?? template.mime_type
      }));
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<unknown> {
    const state = await this.ensureInitializedState(signal);
    return await this.requestOnState(state, "resources/read", { uri }, this.server.toolTimeoutMs, signal);
  }

  async listPrompts(signal?: AbortSignal): Promise<McpPromptDescriptor[]> {
    const state = await this.ensureInitializedState(signal);
    if (!this.serverCapabilities.prompts) return [];
    const prompts = await this.listPagesOnState(state, "prompts/list", "prompts", this.server.startupTimeoutMs, signal);
    return prompts
      .filter((prompt): prompt is RawMcpPrompt => isRecord(prompt) && typeof prompt.name === "string")
      .map(normalizeMcpPrompt);
  }

  async getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<McpPromptResult> {
    const state = await this.ensureInitializedState(signal);
    if (!this.serverCapabilities.prompts) throw new Error(`MCP server does not provide prompts: ${this.server.name}`);
    return normalizeMcpPromptResult(await this.requestOnState(
      state,
      "prompts/get",
      { name, arguments: args },
      this.server.toolTimeoutMs,
      signal
    ));
  }

  async callTool(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const state = await this.ensureInitializedState(signal);
    return await this.requestOnState(state, "tools/call", { name, arguments: args }, this.server.toolTimeoutMs, signal);
  }

  private async spawnProcess(): Promise<void> {
    const proc = spawn(this.server.command, this.server.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: process.platform === "win32",
      ...(this.server.cwd ? { cwd: this.server.cwd } : {}),
      env: { ...defaultMcpEnvironment(), ...forwardedMcpEnvironment(this.server.envVars), ...(this.server.env ?? {}) },
      detached: isolatedProcessGroup()
    });
    let resolveExit = () => {};
    let resolveClose = () => {};
    const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });
    const closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });
    const state: McpProcessState = {
      proc,
      buffer: Buffer.alloc(0),
      stderr: new BoundedOutputBuffer(8_000, 0),
      closing: false,
      ended: false,
      closed: false,
      exitPromise,
      closePromise,
      resolveExit,
      resolveClose,
      serverRequests: new Map()
    };
    this.active = state;
    proc.stdout.on("data", (chunk: Buffer) => this.onStdout(state, chunk));
    proc.stdout.on("error", (error) => this.failProcess(state, error));
    proc.stdin.on("error", (error) => this.failProcess(state, error));
    proc.stderr.on("data", (chunk: Buffer) => {
      state.stderr.push(chunk);
    });
    proc.on("exit", (code, signal) => this.onProcessExit(state, code, signal));
    proc.on("close", (code, signal) => this.onProcessClose(state, code, signal));
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      proc.on("error", (error) => {
        const failure = this.processError(state, error);
        this.failProcess(state, failure);
        if (settled) return;
        settled = true;
        reject(failure);
      });
      proc.once("spawn", () => {
        if (settled) return;
        settled = true;
        this.lastFailure = undefined;
        resolve();
      });
    });
  }

  private async stopProcess(): Promise<void> {
    if (this.startTask) await this.startTask.catch(() => {});
    const state = this.active;
    if (!state) return;
    await this.closeProcessState(state, new Error(`MCP client stopped: ${this.server.name}`));
  }

  private async closeProcessState(state: McpProcessState, error: Error): Promise<void> {
    state.closing = true;
    if (this.active === state) this.active = undefined;
    if (this.initializedState === state) this.initializedState = undefined;
    this.initializedInfo = {};
    this.serverCapabilities = { tools: false, prompts: false, resources: false };
    this.listChangedCapabilities = { tools: false, prompts: false, resources: false };
    if (this.initializeTask?.state === state) this.initializeTask = undefined;
    this.abortServerRequests(state, error);
    this.rejectPending(state, error);
    try { state.proc.stdin.end(); } catch { }
    await this.waitForExit(state, STDIO_CLOSE_GRACE_MS);
    await terminateProcessTree(state.proc, Promise.race([state.exitPromise, state.closePromise]), STDIO_TERM_GRACE_MS);
    await this.waitForExit(state, STDIO_KILL_GRACE_MS);
    this.destroyProcessStreams(state);
  }

  private async ensureInitializedState(signal?: AbortSignal): Promise<McpProcessState> {
    await this.ensureInitialized(signal);
    const state = this.initializedState;
    if (!state || state.closing || state.ended || state.closed) throw new Error(`MCP client stopped: ${this.server.name}`);
    return state;
  }

  private async ensureInitialized(signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw mcpAbortError("initialize", signal);
    await this.start();
    const state = this.active;
    if (!state || state.ended || state.closed) throw new Error(`MCP process not started: ${this.server.name}`);
    if (this.initializedState === state) return undefined;
    if (this.initializeTask?.state === state) return await waitForMcpAbort(this.initializeTask.task, "initialize", signal);
    const task = (async () => {
      try {
        const result = await this.requestOnState(state, "initialize", {
          protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
          capabilities: this.elicitationHandler ? { elicitation: { form: { applyDefaults: true } } } : {},
          clientInfo: { name: "farai", version: FARAI_VERSION }
        }, this.server.startupTimeoutMs, signal);
        if (!isRecord(result) || typeof result.protocolVersion !== "string") {
          throw new Error(`MCP server sent an invalid initialize result: ${this.server.name}`);
        }
        if (!MCP_LEGACY_PROTOCOL_VERSIONS.includes(result.protocolVersion as typeof MCP_LEGACY_PROTOCOL_VERSIONS[number])) {
          throw new Error(`MCP server selected an unsupported protocol version: ${result.protocolVersion}`);
        }
        const capabilities = isRecord(result.capabilities) ? result.capabilities : {};
        const tools = isRecord(capabilities.tools) ? capabilities.tools : {};
        const prompts = isRecord(capabilities.prompts) ? capabilities.prompts : {};
        const resources = isRecord(capabilities.resources) ? capabilities.resources : {};
        this.serverCapabilities = {
          tools: isRecord(capabilities.tools),
          prompts: isRecord(capabilities.prompts),
          resources: isRecord(capabilities.resources)
        };
        this.listChangedCapabilities = {
          tools: tools.listChanged === true,
          prompts: prompts.listChanged === true,
          resources: resources.listChanged === true
        };
        const serverInfo = isRecord(result.serverInfo) ? result.serverInfo : {};
        this.initializedInfo = {
          ...(typeof serverInfo.name === "string" ? { name: boundedMcpIdentifier(serverInfo.name, "mcp server name") } : {}),
          ...(typeof serverInfo.version === "string" ? { version: boundedMcpIdentifier(serverInfo.version, "mcp server version") } : {}),
          ...(typeof result.instructions === "string" ? { instructions: boundedMcpMetadata(result.instructions) } : {})
        };
        this.initializedState = state;
        await this.notifyOnState(state, "notifications/initialized", {});
        if (state.ended || state.closed) throw state.failure ?? new Error(`MCP process exited during initialization: ${this.server.name}`);
        return result;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.failProcess(state, failure);
        await this.closeProcessState(state, failure);
        throw failure;
      }
    })();
    this.initializeTask = { state, task };
    try {
      return await waitForMcpAbort(task, "initialize", signal);
    } finally {
      if (this.initializeTask?.task === task) this.initializeTask = undefined;
    }
  }

  private async requestOnState(state: McpProcessState, method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    if (state.closing) throw new Error(`MCP client stopped: ${this.server.name}`);
    if (state.ended || state.closed || state.proc.stdin.destroyed || !state.proc.stdin.writable) {
      throw state.failure ?? new Error(`MCP process is not writable: ${this.server.name}`);
    }
    if (signal?.aborted) throw mcpAbortError(method, signal);
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending || pending.state !== state) return;
        this.clearPending(id, pending);
        pending.reject(new Error(`MCP request timed out: ${method}`));
        void this.writeMessage(state, JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: `request timed out: ${method}` }
        })).catch(() => {});
      }, timeoutMs);
      const pending: PendingMcpRequest = { state, method, resolve, reject, timeout };
      if (signal) {
        const abort = () => {
          const current = this.pending.get(id);
          if (!current || current.state !== state) return;
          this.clearPending(id, current);
          current.reject(mcpAbortError(method, signal));
          void this.writeMessage(state, JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id, reason: `request cancelled: ${method}` }
          })).catch(() => {});
        };
        signal.addEventListener("abort", abort, { once: true });
        pending.removeAbort = () => signal.removeEventListener("abort", abort);
        this.pending.set(id, pending);
        if (signal.aborted) abort();
      } else {
        this.pending.set(id, pending);
      }
    });
    if (!this.pending.has(id)) return await response;
    void this.writeMessage(state, payload).catch((error) => {
      const pending = this.pending.get(id);
      if (!pending || pending.state !== state) return;
      this.clearPending(id, pending);
      const failure = this.processError(state, error);
      pending.reject(failure);
      this.failProcess(state, failure);
    });
    return await response;
  }

  private async listPagesOnState(
    state: McpProcessState,
    method: string,
    resultKey: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    const guard = new McpPaginationGuard(mcpCatalogLimits(method));
    let cursor: string | undefined;
    do {
      const result = await this.requestOnState(state, method, cursor ? { cursor } : {}, timeoutMs, signal);
      if (!isRecord(result)) break;
      const page = result[resultKey];
      const pageItems = Array.isArray(page) ? page : [];
      cursor = guard.next(result.nextCursor, pageItems.length, mcpCatalogPageBytes(pageItems), method);
      items.push(...pageItems);
    } while (cursor);
    return items;
  }

  private async notifyOnState(state: McpProcessState, method: string, params: unknown): Promise<void> {
    await this.writeMessage(state, JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private onStdout(state: McpProcessState, chunk: Buffer): void {
    if (state.closed) return;
    if (state.buffer.length + chunk.length > MAX_STDIO_BUFFER_BYTES) {
      state.buffer = Buffer.alloc(0);
      this.failProcess(state, new Error(`MCP stdout exceeded ${MAX_STDIO_BUFFER_BYTES} bytes without a complete message`));
      void terminateProcessTree(state.proc, Promise.race([state.exitPromise, state.closePromise]), STDIO_TERM_GRACE_MS);
      return;
    }
    state.buffer = state.buffer.length === 0 ? chunk : Buffer.concat([state.buffer, chunk]);
    for (;;) {
      if (startsWithContentLength(state.buffer)) {
        const headerEnd = state.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = state.buffer.subarray(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          state.buffer = state.buffer.subarray(headerEnd + 4);
          continue;
        }
        const length = Number(match[1]);
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_STDIO_BUFFER_BYTES) {
          state.buffer = Buffer.alloc(0);
          this.failProcess(state, new Error(`MCP Content-Length exceeds ${MAX_STDIO_BUFFER_BYTES} bytes`));
          void terminateProcessTree(state.proc, Promise.race([state.exitPromise, state.closePromise]), STDIO_TERM_GRACE_MS);
          return;
        }
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + length;
        if (state.buffer.length < bodyEnd) return;
        const body = state.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
        state.buffer = state.buffer.subarray(bodyEnd);
        this.handleMessage(state, body);
        continue;
      }
      const newline = state.buffer.indexOf(0x0a);
      if (newline === -1) return;
      const line = state.buffer.subarray(0, newline).toString("utf8").trim();
      state.buffer = state.buffer.subarray(newline + 1);
      if (!line) continue;
      this.handleMessage(state, line);
    }
  }

  private async writeMessage(state: McpProcessState, payload: string): Promise<void> {
    if (state.closing) throw new Error(`MCP client stopped: ${this.server.name}`);
    if (state.ended || state.closed || state.proc.stdin.destroyed || !state.proc.stdin.writable) {
      throw state.failure ?? new Error(`MCP process is not writable: ${this.server.name}`);
    }
    await new Promise<void>((resolve, reject) => {
      try {
        state.proc.stdin.write(`${payload}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleMessage(state: McpProcessState, raw: string): void {
    let message: { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.method === "string") {
      if (message.id === undefined && state === this.initializedState && !state.closing && !state.ended && !state.closed) {
        if (message.method === "notifications/tools/list_changed" && this.listChangedCapabilities.tools) this.catalogChangeHandler?.("tools");
        if (message.method === "notifications/prompts/list_changed" && this.listChangedCapabilities.prompts) this.catalogChangeHandler?.("prompts");
        if (message.method === "notifications/resources/list_changed" && this.listChangedCapabilities.resources) this.catalogChangeHandler?.("resources");
        if (message.method === "notifications/cancelled" && isRecord(message.params)) {
          const requestId = message.params.requestId;
          if (typeof requestId === "string" || typeof requestId === "number") state.serverRequests.get(requestId)?.abort("MCP server cancelled elicitation");
        }
      }
      if ((typeof message.id === "string" || typeof message.id === "number") && !state.ended && !state.closed) {
        void this.handleServerRequest(state, message.id, message.method, message.params);
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending || pending.state !== state) return;
    this.clearPending(message.id, pending);
    if (message.error) pending.reject(new Error(`MCP error: ${JSON.stringify(message.error)}`));
    else pending.resolve(message.result);
  }

  private async handleServerRequest(state: McpProcessState, id: string | number, method: string, params: unknown): Promise<void> {
    if (method !== "elicitation/create" || !this.elicitationHandler || state !== this.initializedState) {
      await this.writeMessage(state, JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })).catch(() => {});
      return;
    }
    const controller = new AbortController();
    state.serverRequests.set(id, controller);
    try {
      const request = normalizeMcpFormElicitationRequest(params);
      const result = await this.elicitationHandler(request, controller.signal);
      if (state.closing || state.ended || state.closed || state.serverRequests.get(id) !== controller) return;
      await this.writeMessage(state, JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch (error) {
      if (state.closing || state.ended || state.closed || state.serverRequests.get(id) !== controller) return;
      const cancelled = controller.signal.aborted;
      await this.writeMessage(state, JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: cancelled ? -32800 : -32602,
          message: error instanceof Error ? error.message : String(error)
        }
      })).catch(() => {});
    } finally {
      if (state.serverRequests.get(id) === controller) state.serverRequests.delete(id);
    }
  }

  private onProcessExit(state: McpProcessState, code: number | null, signal: NodeJS.Signals | null): void {
    if (!state.ended) {
      state.ended = true;
      state.resolveExit();
    }
    if (this.active === state) this.active = undefined;
    if (this.initializedState === state) this.initializedState = undefined;
    this.initializedInfo = {};
    this.serverCapabilities = { tools: false, prompts: false, resources: false };
    this.listChangedCapabilities = { tools: false, prompts: false, resources: false };
    if (this.initializeTask?.state === state) this.initializeTask = undefined;
    this.abortServerRequests(state, this.exitError(state, code, signal));
    if (!state.closing) this.failProcess(state, this.exitError(state, code, signal));
  }

  private onProcessClose(state: McpProcessState, code: number | null, signal: NodeJS.Signals | null): void {
    if (!state.closed) {
      state.closed = true;
      state.resolveClose();
    }
    if (!state.ended) {
      state.ended = true;
      state.resolveExit();
    }
    if (this.active === state) this.active = undefined;
    if (this.initializedState === state) this.initializedState = undefined;
    this.initializedInfo = {};
    this.serverCapabilities = { tools: false, prompts: false, resources: false };
    this.listChangedCapabilities = { tools: false, prompts: false, resources: false };
    if (this.initializeTask?.state === state) this.initializeTask = undefined;
    this.abortServerRequests(state, this.exitError(state, code, signal));
    if (!state.closing) this.failProcess(state, this.exitError(state, code, signal));
    this.destroyProcessStreams(state);
  }

  private failProcess(state: McpProcessState, error: unknown): void {
    if (state.closing) {
      this.rejectPending(state, new Error(`MCP client stopped: ${this.server.name}`));
      return;
    }
    const failure = this.processError(state, error);
    state.failure ??= failure;
    this.lastFailure = state.failure.message;
    if (this.active === state) this.active = undefined;
    if (this.initializedState === state) this.initializedState = undefined;
    this.initializedInfo = {};
    this.serverCapabilities = { tools: false, prompts: false, resources: false };
    this.listChangedCapabilities = { tools: false, prompts: false, resources: false };
    if (this.initializeTask?.state === state) this.initializeTask = undefined;
    this.abortServerRequests(state, state.failure);
    this.rejectPending(state, state.failure);
  }

  private abortServerRequests(state: McpProcessState, reason: Error): void {
    for (const controller of state.serverRequests.values()) controller.abort(reason);
    state.serverRequests.clear();
  }

  private rejectPending(state: McpProcessState, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.state !== state) continue;
      this.clearPending(id, pending);
      pending.reject(error);
    }
  }

  private clearPending(id: number, pending: PendingMcpRequest): void {
    clearTimeout(pending.timeout);
    pending.removeAbort?.();
    this.pending.delete(id);
  }

  private processError(state: McpProcessState, error: unknown): Error {
    if (error instanceof Error && error.message.startsWith("MCP ")) return error;
    const message = error instanceof Error ? error.message : String(error);
    const stderr = state.stderr.text().trim();
    return new Error(`MCP ${this.server.name} transport error: ${message}${stderr ? `: ${stderr}` : ""}`);
  }

  private exitError(state: McpProcessState, code: number | null, signal: NodeJS.Signals | null): Error {
    if (state.failure) return state.failure;
    const status = code !== null ? ` with code ${code}` : signal ? ` from ${signal}` : "";
    const stderr = state.stderr.text().trim();
    return new Error(`MCP process exited${status}${stderr ? `: ${stderr}` : ""}`);
  }

  private async waitForExit(state: McpProcessState, timeoutMs: number): Promise<boolean> {
    if (state.ended || state.closed || state.proc.exitCode !== null || state.proc.signalCode !== null) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const exited = Promise.race([state.exitPromise, state.closePromise]).then(() => true as const);
    try {
      return await Promise.race([exited, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private destroyProcessStreams(state: McpProcessState): void {
    try { state.proc.stdout.destroy(); } catch { }
    try { state.proc.stdin.destroy(); } catch { }
    try { state.proc.stderr.destroy(); } catch { }
    state.buffer = Buffer.alloc(0);
    state.stderr.clear();
  }
}

export class McpHttpClient implements McpClientTransport {
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private connectingClient: Client | undefined;
  private connectingTransport: StreamableHTTPClientTransport | undefined;
  private startTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private startController: AbortController | undefined;
  private generation = 0;
  private running = false;
  private failure: string | undefined;
  private catalogChangeHandler: ((change: McpCatalogChange) => void) | undefined;
  private elicitationHandler: McpElicitationHandler | undefined;

  constructor(private readonly server: ExternalMcpHttpServer, private readonly oauthStore?: McpOAuthStore) {}

  async start(): Promise<void> {
    await this.initialize();
  }

  async stop(): Promise<void> {
    if (this.stopTask) return await this.stopTask;
    const task = this.stopConnection();
    this.stopTask = task;
    try {
      await task;
    } finally {
      if (this.stopTask === task) this.stopTask = undefined;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  lastError(): string | undefined {
    return this.failure;
  }

  setCatalogChangeHandler(handler: ((change: McpCatalogChange) => void) | undefined): void {
    this.catalogChangeHandler = handler;
  }

  setElicitationHandler(handler: McpElicitationHandler | undefined): void {
    this.elicitationHandler = handler;
  }

  async initialize(signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw mcpAbortError("initialize", signal);
    if (this.stopTask) await this.stopTask;
    if (this.running && this.client) return this.client.getServerVersion();
    if (this.startTask) {
      await waitForMcpAbort(this.startTask, "initialize", signal);
      return this.client?.getServerVersion();
    }
    const generation = ++this.generation;
    const controller = new AbortController();
    const removeAbort = forwardMcpAbort(signal, controller);
    const task = this.connect(generation, controller.signal);
    this.startTask = task;
    this.startController = controller;
    try {
      await waitForMcpAbort(task, "initialize", signal);
      return this.client?.getServerVersion();
    } finally {
      removeAbort?.();
      if (this.startTask === task) this.startTask = undefined;
      if (this.startController === controller) this.startController = undefined;
    }
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    const client = await this.readyClient(signal);
    const tools: McpToolDescriptor[] = [];
    const guard = new McpPaginationGuard(mcpCatalogLimits("tools/list"));
    let cursor: string | undefined;
    do {
      if (signal?.aborted) throw mcpAbortError("tools/list", signal);
      const result = await client.listTools(cursor ? { cursor } : undefined, {
        ...(signal ? { signal } : {}),
        timeout: this.server.toolTimeoutMs
      });
      cursor = guard.next(result.nextCursor, result.tools.length, mcpCatalogPageBytes(result.tools), "tools/list");
      tools.push(...result.tools.map((tool) => {
        const annotations = tool.annotations ? {
          ...(typeof tool.annotations.readOnlyHint === "boolean" ? { readOnlyHint: tool.annotations.readOnlyHint } : {}),
          ...(typeof tool.annotations.destructiveHint === "boolean" ? { destructiveHint: tool.annotations.destructiveHint } : {})
        } : undefined;
        return sanitizeMcpTool(this.server.name, {
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
          ...(annotations && Object.keys(annotations).length ? { annotations } : {})
        });
      }));
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const client = await this.readyClient(signal);
    return await client.callTool({ name, arguments: args }, undefined, {
      ...(signal ? { signal } : {}),
      timeout: this.server.toolTimeoutMs,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: this.server.toolTimeoutMs
    });
  }

  async listPrompts(signal?: AbortSignal): Promise<McpPromptDescriptor[]> {
    const client = await this.readyClient(signal);
    if (!client.getServerCapabilities()?.prompts) return [];
    const prompts: McpPromptDescriptor[] = [];
    const guard = new McpPaginationGuard(mcpCatalogLimits("prompts/list"));
    let cursor: string | undefined;
    do {
      if (signal?.aborted) throw mcpAbortError("prompts/list", signal);
      const result = await client.listPrompts(cursor ? { cursor } : undefined, {
        ...(signal ? { signal } : {}),
        timeout: this.server.toolTimeoutMs
      });
      cursor = guard.next(result.nextCursor, result.prompts.length, mcpCatalogPageBytes(result.prompts), "prompts/list");
      prompts.push(...result.prompts.map((prompt) => normalizeMcpPrompt({
        name: prompt.name,
        ...(prompt.title ? { title: prompt.title } : {}),
        ...(prompt.description ? { description: prompt.description } : {}),
        ...(prompt.arguments ? {
          arguments: prompt.arguments.map((argument) => ({
            name: argument.name,
            ...(argument.description ? { description: argument.description } : {}),
            ...(typeof argument.required === "boolean" ? { required: argument.required } : {})
          }))
        } : {})
      })));
    } while (cursor);
    return prompts;
  }

  async getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<McpPromptResult> {
    const client = await this.readyClient(signal);
    if (!client.getServerCapabilities()?.prompts) throw new Error(`MCP server does not provide prompts: ${this.server.name}`);
    return normalizeMcpPromptResult(await client.getPrompt({ name, arguments: args }, {
      ...(signal ? { signal } : {}),
      timeout: this.server.toolTimeoutMs
    }));
  }

  async listResources(signal?: AbortSignal): Promise<McpResourceDescriptor[]> {
    const client = await this.readyClient(signal);
    const resources: McpResourceDescriptor[] = [];
    const guard = new McpPaginationGuard(mcpCatalogLimits("resources/list"));
    let cursor: string | undefined;
    do {
      if (signal?.aborted) throw mcpAbortError("resources/list", signal);
      const result = await client.listResources(cursor ? { cursor } : undefined, {
        ...(signal ? { signal } : {}),
        timeout: this.server.toolTimeoutMs
      });
      cursor = guard.next(result.nextCursor, result.resources.length, mcpCatalogPageBytes(result.resources), "resources/list");
      resources.push(...result.resources.map((resource) => normalizeMcpResource(resource)));
    } while (cursor);
    return resources;
  }

  async listResourceTemplates(signal?: AbortSignal): Promise<McpResourceTemplateDescriptor[]> {
    const client = await this.readyClient(signal);
    const templates: McpResourceTemplateDescriptor[] = [];
    const guard = new McpPaginationGuard(mcpCatalogLimits("resources/templates/list"));
    let cursor: string | undefined;
    do {
      if (signal?.aborted) throw mcpAbortError("resources/templates/list", signal);
      const result = await client.listResourceTemplates(cursor ? { cursor } : undefined, {
        ...(signal ? { signal } : {}),
        timeout: this.server.toolTimeoutMs
      });
      cursor = guard.next(result.nextCursor, result.resourceTemplates.length, mcpCatalogPageBytes(result.resourceTemplates), "resources/templates/list");
      templates.push(...result.resourceTemplates.map((template) => normalizeMcpResourceTemplate(template)));
    } while (cursor);
    return templates;
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<unknown> {
    const client = await this.readyClient(signal);
    return await client.readResource({ uri }, {
      ...(signal ? { signal } : {}),
      timeout: this.server.toolTimeoutMs
    });
  }

  serverInfo(): { name?: string; version?: string; instructions?: string } {
    const info = this.client?.getServerVersion();
    const instructions = this.client?.getInstructions();
    return {
      ...(info?.name ? { name: boundedMcpIdentifier(info.name, "mcp server name") } : {}),
      ...(info?.version ? { version: boundedMcpIdentifier(info.version, "mcp server version") } : {}),
      ...(instructions ? { instructions: boundedMcpMetadata(instructions) } : {})
    };
  }

  private async readyClient(signal?: AbortSignal): Promise<Client> {
    await this.initialize(signal);
    if (!this.client || !this.running) throw new Error(`MCP HTTP client is not connected: ${this.server.name}`);
    return this.client;
  }

  private async stopConnection(): Promise<void> {
    const stopped = new Error(`MCP client stopped: ${this.server.name}`);
    this.generation += 1;
    this.startController?.abort(stopped);
    const startTask = this.startTask;
    const pairs = uniqueHttpConnections([
      [this.client, this.transport],
      [this.connectingClient, this.connectingTransport]
    ]);
    this.client = undefined;
    this.transport = undefined;
    this.connectingClient = undefined;
    this.connectingTransport = undefined;
    this.running = false;
    await Promise.allSettled([
      ...pairs.map(([client, transport]) => closeHttpConnection(client, transport, true)),
      ...(startTask ? [startTask] : [])
    ]);
  }

  private async connect(generation: number, signal: AbortSignal): Promise<void> {
    const headers = resolveHttpHeaders(this.server);
    const callback = this.server.auth === "oauth" ? await openMcpOAuthCallback(this.server.oauth?.callbackUrl) : undefined;
    const provider = callback && this.oauthStore
      ? new PersistentMcpOAuthProvider(callback.url, this.server, this.oauthStore, callback)
      : undefined;
    try {
      if (signal.aborted || generation !== this.generation) throw mcpAbortError("initialize", signal);
      await this.connectTransport(headers, provider, callback, generation, signal);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!signal.aborted && generation === this.generation) this.failure = failure.message;
      throw new Error(`MCP ${this.server.name} HTTP transport error: ${failure.message}`);
    } finally {
      await callback?.close(signal.reason instanceof Error ? signal.reason : undefined);
    }
  }

  private async connectTransport(
    headers: Record<string, string>,
    provider: OAuthClientProvider | undefined,
    callback: OAuthCallback | undefined,
    generation: number,
    signal: AbortSignal
  ): Promise<void> {
    let authorizationAttempted = false;
    for (;;) {
      if (signal.aborted || generation !== this.generation) throw mcpAbortError("initialize", signal);
      let client: Client;
      client = new Client({ name: "farai", version: FARAI_VERSION }, {
        capabilities: this.elicitationHandler ? { elicitation: { form: { applyDefaults: true } } } : {},
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => {
              if (generation === this.generation && this.client === client && this.running) this.catalogChangeHandler?.("tools");
            }
          },
          prompts: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => {
              if (generation === this.generation && this.client === client && this.running) this.catalogChangeHandler?.("prompts");
            }
          },
          resources: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => {
              if (generation === this.generation && this.client === client && this.running) this.catalogChangeHandler?.("resources");
            }
          }
        }
      });
      if (this.elicitationHandler) {
        client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
          const form = normalizeMcpFormElicitationRequest(request.params);
          return await this.elicitationHandler!(form, extra.signal);
        });
      }
      const transport = new StreamableHTTPClientTransport(new URL(this.server.url), {
        ...(Object.keys(headers).length ? { requestInit: { headers } } : {}),
        ...(provider ? { authProvider: provider } : {}),
        fetch: boundedMcpFetch
      });
      this.connectingClient = client;
      this.connectingTransport = transport;
      let installed = false;
      client.onerror = (error) => {
        if (generation === this.generation) this.failure = error.message;
      };
      client.onclose = () => {
        if (this.client === client) this.running = false;
      };
      try {
        try {
          await client.connect(transport as any, {
            signal,
            timeout: this.server.startupTimeoutMs,
            maxTotalTimeout: this.server.startupTimeoutMs
          });
        } catch (error) {
          if (!(error instanceof UnauthorizedError) || !provider || !callback || authorizationAttempted) throw error;
          authorizationAttempted = true;
          const code = await callback.waitForCode(signal, this.server.startupTimeoutMs);
          await withMcpDeadline(transport.finishAuth(code), this.server.startupTimeoutMs, "OAuth token exchange", signal);
          continue;
        }
        if (signal.aborted || generation !== this.generation) throw mcpAbortError("initialize", signal);
        this.client = client;
        this.transport = transport;
        this.running = true;
        this.failure = undefined;
        installed = true;
        return;
      } finally {
        if (this.connectingClient === client) this.connectingClient = undefined;
        if (this.connectingTransport === transport) this.connectingTransport = undefined;
        if (!installed) await closeHttpConnection(client, transport, false);
      }
    }
  }
}

type OAuthCallback = {
  url: URL;
  authorize(url: URL): void;
  expectState(state: string): void;
  waitForCode(signal: AbortSignal, timeoutMs: number): Promise<string>;
  close(reason?: Error): Promise<void>;
};

type HttpConnection = [Client, StreamableHTTPClientTransport];

function uniqueHttpConnections(entries: Array<[Client | undefined, StreamableHTTPClientTransport | undefined]>): HttpConnection[] {
  const transports = new Set<StreamableHTTPClientTransport>();
  const result: HttpConnection[] = [];
  for (const [client, transport] of entries) {
    if (!client || !transport || transports.has(transport)) continue;
    transports.add(transport);
    result.push([client, transport]);
  }
  return result;
}

async function closeHttpConnection(client: Client, transport: StreamableHTTPClientTransport, terminate: boolean): Promise<void> {
  const termination = terminate && transport.sessionId
    ? transport.terminateSession().catch(() => undefined)
    : undefined;
  if (termination) await settleWithin(termination, HTTP_TERMINATE_GRACE_MS);
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
}

async function settleWithin(task: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class PersistentMcpOAuthProvider implements OAuthClientProvider {
  private stored: McpOAuthState;
  private readonly oauthState = randomBytes(32).toString("base64url");

  constructor(
    readonly redirectUrl: URL,
    private readonly server: ExternalMcpHttpServer,
    private readonly store: McpOAuthStore,
    private readonly callback: OAuthCallback
  ) {
    this.stored = store.load();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "farai",
      redirect_uris: [this.redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.server.oauth?.scopes?.length ? { scope: this.server.oauth.scopes.join(" ") } : {})
    };
  }

  state(): string {
    this.callback.expectState(this.oauthState);
    return this.oauthState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.server.oauth?.clientId
      ? { client_id: this.server.oauth.clientId }
      : this.stored.clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.stored = { ...this.stored, clientInformation };
    this.store.save(this.stored);
  }

  tokens(): OAuthTokens | undefined {
    return mcpOAuthStateAuthenticated(this.stored) ? this.stored.tokens : undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    const expiresIn = typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0
      ? tokens.expires_in
      : undefined;
    this.stored = {
      ...this.stored,
      tokens,
      ...(expiresIn ? { tokensExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() } : {})
    };
    if (!expiresIn) delete this.stored.tokensExpiresAt;
    this.store.save(this.stored);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.callback.authorize(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.stored = { ...this.stored, codeVerifier };
    this.store.save(this.stored);
  }

  codeVerifier(): string {
    if (!this.stored.codeVerifier) throw new Error("MCP OAuth code verifier is unavailable");
    return this.stored.codeVerifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") this.stored = {};
    if (scope === "client") delete this.stored.clientInformation;
    if (scope === "tokens") {
      delete this.stored.tokens;
      delete this.stored.tokensExpiresAt;
    }
    if (scope === "verifier") delete this.stored.codeVerifier;
    this.store.save(this.stored);
  }
}

function defaultMcpEnvironment(): Record<string, string> {
  const platformKeys = process.platform === "win32"
    ? ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE", "PROGRAMFILES"]
    : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];
  const keys = [
    ...platformKeys,
    "DOCKER_API_VERSION",
    "DOCKER_CERT_PATH",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_DEFAULT_PLATFORM",
    "DOCKER_HOST",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "SSH_AUTH_SOCK"
  ];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && !value.startsWith("()")) env[key] = value;
  }
  return env;
}

function forwardedMcpEnvironment(names: string[] | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names ?? []) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export async function openMcpOAuthCallback(configuredUrl: string | undefined): Promise<OAuthCallback> {
  const configured = configuredUrl ? new URL(configuredUrl) : new URL("http://127.0.0.1/callback");
  if (configured.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(configured.hostname)) {
    throw new Error("MCP OAuth callback must use a local HTTP loopback address");
  }
  if (configured.username || configured.password || configured.search || configured.hash) {
    throw new Error("MCP OAuth callback must not contain credentials, query parameters, or a fragment");
  }
  let server: Server | undefined;
  const sockets = new Set<Socket>();
  let expectedState: string | undefined;
  let settled = false;
  let closeTask: Promise<void> | undefined;
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (error: Error) => void = () => {};
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rejectCode = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
  });
  void code.catch(() => {});
  server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== configured.pathname) {
      response.writeHead(404).end("not found");
      return;
    }
    const error = requestUrl.searchParams.get("error");
    const authorizationCode = requestUrl.searchParams.get("code");
    if (error) {
      response.writeHead(400, { "content-type": "text/plain" }).end(`authorization failed: ${error}`);
      rejectCode(new Error(`MCP OAuth authorization failed: ${error}`));
      return;
    }
    const returnedState = requestUrl.searchParams.get("state");
    if (!expectedState || returnedState !== expectedState) {
      response.writeHead(400, { "content-type": "text/plain" }).end("authorization state mismatch");
      rejectCode(new Error("MCP OAuth authorization state mismatch"));
      return;
    }
    if (!authorizationCode) {
      response.writeHead(400, { "content-type": "text/plain" }).end("authorization code missing");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end("<html><body><h1>farai connected</h1><p>you can close this window and return to farai.</p></body></html>");
    resolveCode(authorizationCode);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const requestedPort = configured.port ? Number(configured.port) : 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const listener = server!;
      const onError = (error: Error) => {
        listener.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        listener.off("error", onError);
        resolve();
      };
      listener.once("error", onError);
      listener.once("listening", onListening);
      listener.listen(requestedPort, configured.hostname === "localhost" ? "127.0.0.1" : configured.hostname);
    });
  } catch (error) {
    rejectCode(error instanceof Error ? error : new Error(String(error)));
    for (const socket of sockets) socket.destroy();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    const failure = new Error("MCP OAuth callback listener failed to bind");
    rejectCode(failure);
    for (const socket of sockets) socket.destroy();
    await closeHttpServer(server);
    throw failure;
  }
  configured.port = String(address.port);
  return {
    url: configured,
    authorize(url) {
      openExternalUrl(url.toString());
    },
    expectState(state) {
      expectedState = state;
    },
    async waitForCode(signal, timeoutMs) {
      return await withMcpDeadline(code, timeoutMs, "OAuth authorization", signal);
    },
    async close(reason) {
      if (closeTask) return await closeTask;
      closeTask = (async () => {
        rejectCode(reason ?? new Error("MCP OAuth callback closed"));
        const listener = server;
        server = undefined;
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        if (listener) await closeHttpServer(listener);
      })();
      await closeTask;
    }
  };
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    try {
      server.close(done);
      server.closeAllConnections?.();
      timer = setTimeout(done, 500);
      timer.unref?.();
    } catch {
      done();
    }
  });
}

function openExternalUrl(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

async function withMcpDeadline<T>(task: Promise<T>, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  try {
    const deadlines: Promise<T>[] = [task, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    })];
    if (signal) {
      deadlines.push(new Promise<T>((_, reject) => {
        const abort = () => reject(mcpAbortError(label, signal));
        signal.addEventListener("abort", abort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", abort);
        if (signal.aborted) abort();
      }));
    }
    return await Promise.race(deadlines);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort?.();
  }
}

function mcpAbortError(method: string, signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(`MCP request cancelled: ${method}${reason === undefined ? "" : `: ${String(reason)}`}`);
}

export function normalizeMcpResource(resource: { name: string; uri: string; title?: unknown; description?: unknown; mimeType?: unknown }): McpResourceDescriptor {
  return {
    name: boundedMcpIdentifier(resource.name, "mcp resource name"),
    ...(typeof resource.title === "string" && resource.title ? { title: boundedMcpMetadata(resource.title) } : {}),
    uri: boundedMcpUri(resource.uri, "mcp resource uri"),
    ...(typeof resource.mimeType === "string" && resource.mimeType ? { mimeType: boundedMcpIdentifier(resource.mimeType, "mcp resource mime type") } : {}),
    ...(typeof resource.description === "string" && resource.description ? { description: boundedMcpMetadata(resource.description) } : {})
  };
}

export function normalizeMcpResourceTemplate(template: { name: string; uriTemplate: string; title?: unknown; description?: unknown; mimeType?: unknown }): McpResourceTemplateDescriptor {
  return {
    name: boundedMcpIdentifier(template.name, "mcp resource template name"),
    ...(typeof template.title === "string" && template.title ? { title: boundedMcpMetadata(template.title) } : {}),
    uriTemplate: boundedMcpUri(template.uriTemplate, "mcp resource uri template"),
    ...(typeof template.mimeType === "string" && template.mimeType ? { mimeType: boundedMcpIdentifier(template.mimeType, "mcp resource mime type") } : {}),
    ...(typeof template.description === "string" && template.description ? { description: boundedMcpMetadata(template.description) } : {})
  };
}

function boundedMcpIdentifier(value: string, label: string): string {
  if (!value) throw new Error(`${label} must not be empty`);
  if (Buffer.byteLength(value, "utf8") > 1_024) throw new Error(`${label} exceeded 1024 bytes`);
  return value;
}

function boundedMcpUri(value: string, label: string): string {
  if (!value) throw new Error(`${label} must not be empty`);
  if (Buffer.byteLength(value, "utf8") > 64 * 1024) throw new Error(`${label} exceeded ${64 * 1024} bytes`);
  return value;
}

function boundedMcpMetadata(value: string): string {
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, "utf8") <= MCP_MODEL_METADATA_MAX_BYTES) return trimmed;
  return `${takeBytes(trimmed, MCP_MODEL_METADATA_MAX_BYTES - 32, "head")}\n[truncated by farai]`;
}

async function waitForMcpAbort<T>(task: Promise<T>, method: string, signal?: AbortSignal): Promise<T> {
  if (!signal) return await task;
  if (signal.aborted) throw mcpAbortError(method, signal);
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(mcpAbortError(method, signal));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    task.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function forwardMcpAbort(source: AbortSignal | undefined, target: AbortController): (() => void) | undefined {
  if (!source) return undefined;
  const abort = () => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  if (source.aborted) abort();
  return () => source.removeEventListener("abort", abort);
}


function startsWithContentLength(buf: Buffer): boolean {
  return buf.subarray(0, 15).toString("latin1").toLowerCase().startsWith("content-length:");
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return Object.keys(result).length ? result : undefined;
}

function normalizeMcpUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw new Error("MCP URL must be a valid HTTP or HTTPS URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("MCP URL must use HTTP or HTTPS");
  if (parsed.username || parsed.password) throw new Error("MCP credentials must not be embedded in the URL");
  return parsed.toString();
}

function resolveHttpHeaders(server: ExternalMcpHttpServer): Record<string, string> {
  const headers = mergeMcpHeaders(server.httpHeaders);
  for (const [name, envName] of Object.entries(server.envHttpHeaders ?? {})) {
    const value = process.env[envName];
    if (value !== undefined) {
      deleteMcpHeader(headers, name);
      headers[name] = value;
    }
  }
  const token = server.bearerToken ?? (server.bearerTokenEnvVar ? process.env[server.bearerTokenEnvVar] : undefined);
  if (token && !Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function normalizeOAuthConfig(value: Record<string, unknown>): NonNullable<ExternalMcpServer["oauth"]> {
  const clientId = value.client_id ?? value.clientId;
  const callbackUrl = value.callback_url ?? value.callbackUrl;
  const scopes = value.scopes;
  return {
    ...(typeof clientId === "string" && clientId.trim() ? { clientId: clientId.trim() } : {}),
    ...(typeof callbackUrl === "string" && callbackUrl.trim() ? { callbackUrl: normalizeMcpUrl(callbackUrl) } : {}),
    ...(Array.isArray(scopes) ? { scopes: scopes.map(String).map((scope) => scope.trim()).filter(Boolean) } : {})
  };
}

function normalizeMcpConfigEntries(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!isRecord(parsed)) throw new Error("MCP config must be an array or an object with mcpServers");
  if (!isRecord(parsed.mcpServers)) throw new Error("MCP config must be an array or an object with mcpServers");
  return Object.entries(parsed.mcpServers).map(([name, value]) => {
    if (!isRecord(value)) throw new Error(`Invalid MCP server config: ${name}`);
    return { name, ...value };
  });
}

function secondsOrMs(secondsValue: unknown, msValue: unknown, fallback: number): number {
  if (typeof secondsValue === "number" && Number.isFinite(secondsValue) && secondsValue > 0) return Math.round(secondsValue * 1000);
  if (typeof msValue === "number" && Number.isFinite(msValue) && msValue > 0) return Math.round(msValue);
  return fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))] : [];
}

function normalizeMitmproxyConfig(value: Record<string, unknown>): NonNullable<ExternalMcpServer["mitmproxy"]> {
  return {
    autoStartProxy: value.autoStartProxy !== false,
    port: isPortTemplate(value.port)
      ? DEFAULT_MITMPROXY_PORT
      : typeof value.port === "number" && Number.isInteger(value.port) && value.port >= 1 && value.port <= MAX_TCP_PORT
      ? value.port
      : DEFAULT_MITMPROXY_PORT,
    ...(typeof value.dumpFile === "string" ? { dumpFile: value.dumpFile } : {}),
    ...(typeof value.upstreamProxy === "string" ? { upstreamProxy: value.upstreamProxy } : {})
  };
}

function isPortTemplate(value: unknown): boolean {
  return value === "{PORT}" || value === "${PORT}" || value === "{PROXY_PORT}" || value === "${PROXY_PORT}";
}
