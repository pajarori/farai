import type { Session } from "../../types";
import { id, nowIso } from "../../utils";
import { McpStdioClient, type ExternalMcpServer } from "../mcp-adapter";
import { configuredMcpServer, ensureMcpProxyReady, prepareMcpServerProcess } from "../mcp-manager";

export type BrowserContextStatus = "starting" | "ready" | "busy" | "closing";

export type BrowserContextActivity = {
  id: string;
  name: string;
  status: BrowserContextStatus;
  createdAt: string;
  lastUsedAt?: string;
};

type BrowserContextEntry = BrowserContextActivity & {
  sessionId: string;
  client?: BrowserMcpClient;
  tools: Set<string>;
  mutex: AsyncMutex;
  ready: Promise<void>;
  lifecycle: AbortController;
};

type BrowserContextListener = (contexts: BrowserContextActivity[]) => void;

type BrowserMcpClient = Pick<McpStdioClient, "initialize" | "listTools" | "callTool" | "stop">;

type BrowserContextManagerOptions = {
  resolveServer?: (workspace: string) => ExternalMcpServer | undefined;
  ensureProxy?: (input: { workspace: string; configWorkspace?: string; session: Session; signal?: AbortSignal }, port: number) => Promise<void>;
  prepareServer?: typeof prepareMcpServerProcess;
  createClient?: (config: ExternalMcpServer) => BrowserMcpClient;
};

const MAX_BROWSER_CONTEXTS_PER_SESSION = 8;

export class BrowserContextManager {
  private readonly contexts = new Map<string, Map<string, BrowserContextEntry>>();
  private readonly listeners = new Map<string, Set<BrowserContextListener>>();

  constructor(private readonly options: BrowserContextManagerOptions = {}) {}

  list(session: Session | string): BrowserContextActivity[] {
    const sessionId = typeof session === "string" ? session : session.id;
    return [...(this.contexts.get(sessionId)?.values() ?? [])]
      .map(toActivity)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.name.localeCompare(right.name));
  }

  subscribe(session: Session | string, listener: BrowserContextListener): () => void {
    const sessionId = typeof session === "string" ? session : session.id;
    let listeners = this.listeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(sessionId);
    };
  }

  async create(input: { workspace: string; configWorkspace?: string; session: Session; name: string; signal?: AbortSignal }): Promise<BrowserContextActivity> {
    return await this.createNamed(input, false);
  }

  async close(input: { session: Session; browser: string; signal?: AbortSignal }): Promise<BrowserContextActivity> {
    const entry = this.resolve(input.session.id, input.browser);
    await waitForSignal(entry.ready, input.signal);
    await entry.mutex.run(async () => {
      entry.status = "closing";
      this.emit(entry.sessionId);
      try {
        await entry.client?.stop();
      } finally {
        this.contexts.get(entry.sessionId)?.delete(entry.id);
        if (this.contexts.get(entry.sessionId)?.size === 0) this.contexts.delete(entry.sessionId);
        this.emit(entry.sessionId);
      }
    }, input.signal);
    return toActivity(entry);
  }

  async runOperation<T>(input: {
    workspace: string;
    configWorkspace?: string;
    session: Session;
    browser?: string;
    signal?: AbortSignal;
  }, operation: (invoke: (tool: string, args: Record<string, unknown>) => Promise<unknown>, context: BrowserContextActivity) => Promise<T>): Promise<{ context: BrowserContextActivity; value: T }> {
    const entry = input.browser
      ? this.resolve(input.session.id, input.browser)
      : await this.createNamed({ ...input, name: "default" }, true).then((activity) => this.resolve(input.session.id, activity.id));
    await waitForSignal(entry.ready, input.signal);
    return await entry.mutex.run(async () => {
      entry.status = "busy";
      entry.lastUsedAt = nowIso();
      this.emit(entry.sessionId);
      try {
        const invoke = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
          if (!entry.tools.has(tool)) throw new Error(`Browser backend does not provide ${tool}`);
          if (!entry.client) throw new Error("Browser context client is unavailable");
          return await entry.client.callTool(tool, args, input.signal);
        };
        const context = toActivity(entry);
        return { context, value: await operation(invoke, context) };
      } finally {
        entry.status = "ready";
        entry.lastUsedAt = nowIso();
        this.emit(entry.sessionId);
      }
    }, input.signal);
  }

  async stopSession(session: Session | string): Promise<void> {
    const sessionId = typeof session === "string" ? session : session.id;
    const entries = [...(this.contexts.get(sessionId)?.values() ?? [])];
    for (const entry of entries) entry.lifecycle.abort(new Error("Browser session stopped"));
    await Promise.allSettled(entries.map(async (entry) => {
      await entry.ready.catch(() => {});
      await entry.mutex.run(async () => {
        entry.status = "closing";
        this.emit(sessionId);
        await entry.client?.stop().catch(() => {});
      });
    }));
    this.contexts.delete(sessionId);
    this.emit(sessionId);
  }

  private async createNamed(input: { workspace: string; configWorkspace?: string; session: Session; name: string; signal?: AbortSignal }, allowDefault: boolean): Promise<BrowserContextActivity> {
    input.signal?.throwIfAborted();
    const name = normalizeBrowserName(input.name);
    if (!allowDefault && name.toLowerCase() === "default") throw new Error("Browser name 'default' is reserved for the implicit browser context");
    const sessionContexts = this.sessionContexts(input.session.id);
    const existing = [...sessionContexts.values()].find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      await waitForSignal(existing.ready, input.signal);
      return toActivity(existing);
    }
    if (sessionContexts.size >= MAX_BROWSER_CONTEXTS_PER_SESSION) {
      throw new Error(`A session can have at most ${MAX_BROWSER_CONTEXTS_PER_SESSION} browser contexts; close one before creating another`);
    }

    const contextId = id();
    const configWorkspace = input.configWorkspace ?? input.workspace;
    const base = this.options.resolveServer
      ? this.options.resolveServer(configWorkspace)
      : configuredMcpServer(configWorkspace, "playwright");
    if (!base) throw new Error("No enabled Playwright MCP server is configured");
    const config = isolatedBrowserConfig(base, contextId);
    let resolveReady = () => {};
    let rejectReady = (_error: unknown) => {};
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => {});
    const entry: BrowserContextEntry = {
      id: contextId,
      name,
      status: "starting",
      createdAt: nowIso(),
      sessionId: input.session.id,
      tools: new Set(),
      mutex: new AsyncMutex(),
      ready,
      lifecycle: new AbortController()
    };
    sessionContexts.set(entry.id, entry);
    this.emit(entry.sessionId);
    const signal = input.signal
      ? AbortSignal.any([input.signal, entry.lifecycle.signal])
      : entry.lifecycle.signal;

    try {
      const managedProxyPort = loopbackProxyPort(config);
      if (managedProxyPort !== undefined) {
        await (this.options.ensureProxy ?? ensureMcpProxyReady)({
          workspace: input.workspace,
          configWorkspace,
          session: input.session,
          signal
        }, managedProxyPort);
      }
      const prepared = await (this.options.prepareServer ?? prepareMcpServerProcess)({
        workspace: input.workspace,
        configWorkspace,
        session: input.session,
        signal
      }, config);
      const client = this.createClient(prepared);
      entry.client = client;
      await waitForSignal(client.initialize(), signal);
      const descriptors = await waitForSignal(client.listTools(), signal);
      entry.tools = new Set(descriptors.map((descriptor) => descriptor.name));
      for (const required of ["browser_navigate", "browser_snapshot"]) {
        if (!entry.tools.has(required)) throw new Error(`Playwright MCP server does not provide ${required}`);
      }
      entry.status = "ready";
      resolveReady();
      this.emit(entry.sessionId);
      return toActivity(entry);
    } catch (error) {
      rejectReady(error);
      await entry.client?.stop().catch(() => {});
      sessionContexts.delete(entry.id);
      if (sessionContexts.size === 0) this.contexts.delete(entry.sessionId);
      this.emit(entry.sessionId);
      throw error;
    }
  }

  private resolve(sessionId: string, selector: string): BrowserContextEntry {
    const normalized = selector.trim();
    const entries = [...(this.contexts.get(sessionId)?.values() ?? [])];
    const entry = entries.find((candidate) => candidate.id === normalized)
      ?? entries.find((candidate) => candidate.name.toLowerCase() === normalized.toLowerCase());
    if (!entry) {
      const available = entries.map((candidate) => `${candidate.name} (${candidate.id})`).join(", ");
      throw new Error(`Unknown browser context: ${selector}${available ? `. Available: ${available}` : ". Create one with browser_context first"}`);
    }
    return entry;
  }

  private sessionContexts(sessionId: string): Map<string, BrowserContextEntry> {
    let contexts = this.contexts.get(sessionId);
    if (!contexts) {
      contexts = new Map();
      this.contexts.set(sessionId, contexts);
    }
    return contexts;
  }

  private emit(sessionId: string): void {
    const snapshot = this.list(sessionId);
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try { listener(snapshot); } catch { }
    }
  }

  private createClient(config: ExternalMcpServer): BrowserMcpClient {
    return this.options.createClient?.(config) ?? new McpStdioClient(config);
  }
}

export const browserContextManager = new BrowserContextManager();

export async function stopBrowserContextsForSession(session: Session | string): Promise<void> {
  await browserContextManager.stopSession(session);
}

function isolatedBrowserConfig(base: ExternalMcpServer, contextId: string): ExternalMcpServer {
  const conflicts = base.args.filter((arg) => arg === "--shared-browser-context" || arg.startsWith("--user-data-dir") || arg.startsWith("--storage-state"));
  if (conflicts.length > 0) {
    throw new Error(`Playwright MCP browser contexts require isolated profiles; remove conflicting arguments: ${conflicts.join(", ")}`);
  }
  return {
    ...base,
    name: `playwright-browser-${contextId}`,
    args: base.args.includes("--isolated") ? [...base.args] : [...base.args, "--isolated"],
    required: false,
    autoStart: false
  };
}

function loopbackProxyPort(config: ExternalMcpServer): number | undefined {
  const candidates: string[] = [];
  for (let index = 0; index < config.args.length; index += 1) {
    const arg = config.args[index]!;
    if (arg === "--proxy-server" && config.args[index + 1]) candidates.push(config.args[index + 1]!);
    else if (arg.startsWith("--proxy-server=")) candidates.push(arg.slice("--proxy-server=".length));
  }
  if (config.env?.PLAYWRIGHT_MCP_PROXY_SERVER) candidates.push(config.env.PLAYWRIGHT_MCP_PROXY_SERVER);
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") continue;
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
    } catch { }
  }
  return undefined;
}

function normalizeBrowserName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Browser context name must not be empty");
  if (name.length > 64) throw new Error("Browser context name must be 64 characters or fewer");
  if (/\r|\n|\0/.test(name)) throw new Error("Browser context name contains unsupported control characters");
  return name;
}

function toActivity(entry: BrowserContextEntry): BrowserContextActivity {
  return {
    id: entry.id,
    name: entry.name,
    status: entry.status,
    createdAt: entry.createdAt,
    ...(entry.lastUsedAt ? { lastUsedAt: entry.lastUsedAt } : {})
  };
}

class AsyncMutex {
  private locked = false;
  private readonly waiters: Array<{ resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort?: () => void }> = [];

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Browser context operation cancelled"));
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: { resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort?: () => void } = {
        resolve,
        reject,
        ...(signal ? { signal } : {})
      };
      if (signal) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(signal.reason ?? new Error("Browser context operation cancelled"));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.locked = false;
      return;
    }
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
    waiter.resolve();
  }
}

async function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) throw signal.reason ?? new Error("Browser context operation cancelled");
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Browser context operation cancelled"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); }
    );
  });
}
