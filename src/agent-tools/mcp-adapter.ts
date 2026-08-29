import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type ExternalMcpServer = {
  name: string;
  type: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  runInContainer: boolean;
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

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const DEFAULT_MITMPROXY_PORT = 31_337;
const MAX_TCP_PORT = 65_535;
const MAX_STDIO_BUFFER_BYTES = 10 * 1024 * 1024;
const STDIO_CLOSE_GRACE_MS = 250;
const STDIO_TERM_GRACE_MS = 500;
const STDIO_KILL_GRACE_MS = 1_000;
export const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";
const MCP_LEGACY_PROTOCOL_VERSIONS = [MCP_LEGACY_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"] as const;

type McpProcessState = {
  proc: ChildProcessWithoutNullStreams;
  buffer: Buffer;
  stderr: string;
  closing: boolean;
  ended: boolean;
  closed: boolean;
  exitPromise: Promise<void>;
  closePromise: Promise<void>;
  resolveExit: () => void;
  resolveClose: () => void;
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

export function normalizeMcpServerEntry(entry: Record<string, unknown>): ExternalMcpServer {
  const obj = entry;
  const env = isRecord(obj.env)
    ? Object.fromEntries(Object.entries(obj.env).filter((item): item is [string, string] => typeof item[1] === "string"))
    : undefined;
  return {
    name: String(obj.name),
    type: "stdio",
    command: String(obj.command),
    args: Array.isArray(obj.args) ? obj.args.map(String) : [],
    ...(typeof obj.cwd === "string" ? { cwd: obj.cwd } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    runInContainer: (obj.run_in_container ?? obj.runInContainer) !== false,
    enabled: obj.enabled !== false,
    required: (obj.required ?? false) === true,
    startupTimeoutMs: secondsOrMs(obj.startup_timeout_sec, obj.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS),
    toolTimeoutMs: secondsOrMs(obj.tool_timeout_sec, obj.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS),
    autoStart: (obj.auto_start ?? obj.autoStart) !== false,
    ...(Array.isArray(obj.enabled_tools) ? { enabledTools: obj.enabled_tools.map(String) } : {}),
    ...(Array.isArray(obj.enabledTools) ? { enabledTools: obj.enabledTools.map(String) } : {}),
    ...(Array.isArray(obj.disabled_tools) ? { disabledTools: obj.disabled_tools.map(String) } : {}),
    ...(Array.isArray(obj.disabledTools) ? { disabledTools: obj.disabledTools.map(String) } : {}),
    ...(isRecord(obj.mitmproxy) ? { mitmproxy: normalizeMitmproxyConfig(obj.mitmproxy) } : {})
  };
}

export function mcpServersFromConfig(servers: Record<string, Record<string, unknown>>): ExternalMcpServer[] {
  return Object.entries(servers).map(([name, entry]) => normalizeMcpServerEntry({ name, ...entry }));
}

export async function loadExternalMcpConfig(path = ".farai/mcp.json"): Promise<ExternalMcpServer[]> {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(await Bun.file(path).text()) as unknown;
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
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    mutates
  };
}

export class McpStdioClient {
  private active: McpProcessState | undefined;
  private startTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private initializedState: McpProcessState | undefined;
  private initializeTask: { state: McpProcessState; task: Promise<unknown> } | undefined;
  private nextId = 1;
  private pending = new Map<number, PendingMcpRequest>();
  private lastFailure: string | undefined;

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

  async initialize(): Promise<unknown> {
    return await this.ensureInitialized();
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const state = await this.ensureInitializedState();
    const result = await this.requestOnState(state, "tools/list", {}, this.server.startupTimeoutMs);
    const tools = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
    return tools
      .filter((tool): tool is RawMcpTool => isRecord(tool) && typeof tool.name === "string")
      .map((tool) => sanitizeMcpTool(this.server.name, tool));
  }

  async listResources(signal?: AbortSignal): Promise<McpResourceDescriptor[]> {
    const state = await this.ensureInitializedState();
    const result = await this.requestOnState(state, "resources/list", {}, this.server.startupTimeoutMs, signal);
    const resources = isRecord(result) && Array.isArray(result.resources) ? result.resources : [];
    return resources
      .filter((resource): resource is RawMcpResource => isRecord(resource) && typeof resource.name === "string" && typeof resource.uri === "string")
      .map((resource) => ({
        name: resource.name,
        ...(resource.title ? { title: resource.title } : {}),
        uri: resource.uri,
        ...(resource.mimeType || resource.mime_type ? { mimeType: resource.mimeType ?? resource.mime_type } : {}),
        ...(resource.description ? { description: resource.description } : {})
      }));
  }

  async listResourceTemplates(): Promise<McpResourceTemplateDescriptor[]> {
    const state = await this.ensureInitializedState();
    const result = await this.requestOnState(state, "resources/templates/list", {}, this.server.startupTimeoutMs);
    const templates = isRecord(result) && Array.isArray(result.resourceTemplates) ? result.resourceTemplates : [];
    return templates
      .filter((template): template is RawMcpResourceTemplate => {
        if (!isRecord(template) || typeof template.name !== "string") return false;
        return typeof template.uriTemplate === "string" || typeof template.uri_template === "string";
      })
      .map((template) => ({
        name: template.name,
        ...(template.title ? { title: template.title } : {}),
        uriTemplate: template.uriTemplate ?? template.uri_template!,
        ...(template.mimeType || template.mime_type ? { mimeType: template.mimeType ?? template.mime_type } : {}),
        ...(template.description ? { description: template.description } : {})
      }));
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<unknown> {
    const state = await this.ensureInitializedState();
    return await this.requestOnState(state, "resources/read", { uri }, this.server.toolTimeoutMs, signal);
  }

  async callTool(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const state = await this.ensureInitializedState();
    return await this.requestOnState(state, "tools/call", { name, arguments: args }, this.server.toolTimeoutMs, signal);
  }

  private async spawnProcess(): Promise<void> {
    const proc = spawn(this.server.command, this.server.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: process.platform === "win32",
      ...(this.server.cwd ? { cwd: this.server.cwd } : {}),
      env: { ...defaultMcpEnvironment(), ...(this.server.env ?? {}) }
    });
    let resolveExit = () => {};
    let resolveClose = () => {};
    const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });
    const closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });
    const state: McpProcessState = {
      proc,
      buffer: Buffer.alloc(0),
      stderr: "",
      closing: false,
      ended: false,
      closed: false,
      exitPromise,
      closePromise,
      resolveExit,
      resolveClose
    };
    this.active = state;
    proc.stdout.on("data", (chunk: Buffer) => this.onStdout(state, chunk));
    proc.stdout.on("error", (error) => this.failProcess(state, error));
    proc.stdin.on("error", (error) => this.failProcess(state, error));
    proc.stderr.on("data", (chunk: Buffer) => {
      state.stderr = `${state.stderr}${chunk.toString()}`.slice(-8_000);
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
    if (this.initializeTask?.state === state) this.initializeTask = undefined;
    this.rejectPending(state, error);
    try { state.proc.stdin.end(); } catch { }
    if (!(await this.waitForExit(state, STDIO_CLOSE_GRACE_MS))) {
      try { state.proc.kill("SIGTERM"); } catch { }
    }
    if (!(await this.waitForExit(state, STDIO_TERM_GRACE_MS))) {
      try { state.proc.kill("SIGKILL"); } catch { }
    }
    await this.waitForExit(state, STDIO_KILL_GRACE_MS);
    this.destroyProcessStreams(state);
  }

  private async ensureInitializedState(): Promise<McpProcessState> {
    await this.ensureInitialized();
    const state = this.initializedState;
    if (!state || state.closing || state.ended || state.closed) throw new Error(`MCP client stopped: ${this.server.name}`);
    return state;
  }

  private async ensureInitialized(): Promise<unknown> {
    await this.start();
    const state = this.active;
    if (!state || state.ended || state.closed) throw new Error(`MCP process not started: ${this.server.name}`);
    if (this.initializedState === state) return undefined;
    if (this.initializeTask?.state === state) return await this.initializeTask.task;
    const task = (async () => {
      try {
        const result = await this.requestOnState(state, "initialize", {
          protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "farai", version: "0.1.0" }
        }, this.server.startupTimeoutMs);
        if (!isRecord(result) || typeof result.protocolVersion !== "string") {
          throw new Error(`MCP server sent an invalid initialize result: ${this.server.name}`);
        }
        if (!MCP_LEGACY_PROTOCOL_VERSIONS.includes(result.protocolVersion as typeof MCP_LEGACY_PROTOCOL_VERSIONS[number])) {
          throw new Error(`MCP server selected an unsupported protocol version: ${result.protocolVersion}`);
        }
        await this.notifyOnState(state, "notifications/initialized", {});
        if (state.ended || state.closed) throw state.failure ?? new Error(`MCP process exited during initialization: ${this.server.name}`);
        this.initializedState = state;
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
      return await task;
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

  private async notifyOnState(state: McpProcessState, method: string, params: unknown): Promise<void> {
    await this.writeMessage(state, JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private onStdout(state: McpProcessState, chunk: Buffer): void {
    if (state.closed) return;
    if (state.buffer.length + chunk.length > MAX_STDIO_BUFFER_BYTES) {
      state.buffer = Buffer.alloc(0);
      this.failProcess(state, new Error(`MCP stdout exceeded ${MAX_STDIO_BUFFER_BYTES} bytes without a complete message`));
      try { state.proc.kill("SIGTERM"); } catch { }
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
          try { state.proc.kill("SIGTERM"); } catch { }
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
    let message: { id?: number; method?: string; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.method === "string") {
      if (typeof message.id === "number" && !state.ended && !state.closed) {
        void this.writeMessage(state, JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } })).catch(() => {});
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

  private onProcessExit(state: McpProcessState, code: number | null, signal: NodeJS.Signals | null): void {
    if (!state.ended) {
      state.ended = true;
      state.resolveExit();
    }
    if (this.active === state) this.active = undefined;
    if (this.initializedState === state) this.initializedState = undefined;
    if (this.initializeTask?.state === state) this.initializeTask = undefined;
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
    if (this.initializeTask?.state === state) this.initializeTask = undefined;
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
    if (this.initializeTask?.state === state) this.initializeTask = undefined;
    this.rejectPending(state, state.failure);
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
    const stderr = state.stderr.trim();
    return new Error(`MCP ${this.server.name} transport error: ${message}${stderr ? `: ${stderr}` : ""}`);
  }

  private exitError(state: McpProcessState, code: number | null, signal: NodeJS.Signals | null): Error {
    if (state.failure) return state.failure;
    const status = code !== null ? ` with code ${code}` : signal ? ` from ${signal}` : "";
    const stderr = state.stderr.trim();
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

function mcpAbortError(method: string, signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(`MCP request cancelled: ${method}${reason === undefined ? "" : `: ${String(reason)}`}`);
}

function startsWithContentLength(buf: Buffer): boolean {
  return buf.subarray(0, 15).toString("latin1").toLowerCase().startsWith("content-length:");
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
