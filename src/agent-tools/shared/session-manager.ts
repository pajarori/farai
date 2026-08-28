import type { BackendSessionResult, ExecutionBackend, SessionKind } from "../backends/types";

export const DEFAULT_MAX_CONCURRENT_SESSIONS = 8;
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 300_000;
export const MIN_YIELD_MS = 250;
export const MAX_YIELD_MS = 20_000;

export function clampYieldMs(value: unknown): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : MIN_YIELD_MS;
  return Math.min(MAX_YIELD_MS, Math.max(MIN_YIELD_MS, Math.floor(parsed)));
}

type CompletionListener = (result: BackendSessionResult) => void | Promise<void>;

type ManagedSession = {
  sessionId: string;
  backend: ExecutionBackend;
  toolName: string;
  kind: SessionKind;
  startedAt: number;
  lastUsedAt: number;
  completion: Promise<BackendSessionResult>;
  resolveCompletion: (result: BackendSessionResult) => void;
  listeners: Set<CompletionListener>;
  notifications: Promise<void>;
  terminal?: BackendSessionResult;
  terminalPoll?: BackendSessionResult;
  output: string;
  combineInitialOnTerminal: boolean;
};

export type StartSessionResult = BackendSessionResult & { sessionId: string };

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(
    private readonly maxConcurrent = DEFAULT_MAX_CONCURRENT_SESSIONS,
    private readonly idleTimeoutMs = DEFAULT_SESSION_IDLE_TIMEOUT_MS
  ) {}

  count(): number {
    return this.sessions.size;
  }

  async start(
    backend: ExecutionBackend,
    toolName: string,
    command: string,
    yieldMs: number,
    signal: AbortSignal | undefined,
    opts: { kind?: SessionKind; pty?: boolean } = {}
  ): Promise<StartSessionResult> {
    this.reapIdle();
    if (this.runningCount() >= this.maxConcurrent) {
      throw new Error(`Too many background sessions running (max ${this.maxConcurrent}). Stop one with session_stop before starting another.`);
    }
    const kind = opts.kind ?? "generic";
    const result = await backend.startSession(command, { yieldMs, ...(signal ? { signal } : {}), ...opts });
    if (result.session.status === "running") this.track(backend, toolName, result.session.sessionId, kind, result.output, false);
    return { ...result, sessionId: result.session.sessionId };
  }

  adopt(backend: ExecutionBackend, toolName: string, sessionId: string, kind: SessionKind = "generic", output = ""): void {
    this.reapIdle();
    this.track(backend, toolName, sessionId, kind, output, true);
  }

  getKind(sessionId: string): SessionKind | undefined {
    return this.sessions.get(sessionId)?.kind;
  }

  getBackendKind(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.backend.kind;
  }

  async wait(sessionId: string): Promise<BackendSessionResult> {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`Unknown or expired background session: ${sessionId}`);
    const result = await managed.completion;
    await managed.notifications;
    return result;
  }

  onComplete(sessionId: string, listener: CompletionListener): () => void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return () => {};
    managed.listeners.add(listener);
    if (managed.terminal) this.notify(managed, managed.terminal);
    return () => { managed.listeners.delete(listener); };
  }

  async waitForAny(sessionIds: string[], timeoutMs: number): Promise<boolean> {
    const waits = sessionIds
      .map((sessionId) => this.sessions.get(sessionId)?.completion)
      .filter((promise): promise is Promise<BackendSessionResult> => Boolean(promise));
    if (waits.length === 0) return false;
    if (timeoutMs <= 0) return waits.some((_, index) => this.sessions.get(sessionIds[index]!)?.terminal !== undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const completed = Promise.race(waits).then(() => true as const);
    const result = await Promise.race([completed, timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  }

  async poll(sessionId: string, input: string | undefined, yieldMs: number): Promise<BackendSessionResult> {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`Unknown or expired background session: ${sessionId}`);
    managed.lastUsedAt = Date.now();
    if (managed.terminal) {
      await managed.notifications;
      return this.consume(managed, managed.terminalPoll ?? managed.terminal);
    }
    const result = await managed.backend.pollSession(sessionId, { ...(input ? { input } : {}), yieldMs });
    managed.output = appendOutput(managed.output, result.output);
    if (result.session.status !== "running") {
      const terminal = managed.terminal ?? { ...result, output: managed.output };
      managed.terminalPoll = result;
      this.settle(managed, terminal);
      return this.consume(managed, result);
    }
    return result;
  }

  async stop(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    await managed.backend.stopSession(sessionId).catch(() => {});
    const result: BackendSessionResult = {
      session: { sessionId, status: "error", exitCode: null, kind: managed.kind },
      output: "Background session stopped."
    };
    this.settle(managed, result);
    this.sessions.delete(sessionId);
  }

  release(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const sessionId of ids) await this.stop(sessionId).catch(() => {});
  }

  async stopMany(sessionIds: string[]): Promise<void> {
    for (const sessionId of new Set(sessionIds)) await this.stop(sessionId).catch(() => {});
  }

  isTracked(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  private runningCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) if (!session.terminal) count += 1;
    return count;
  }

  private track(
    backend: ExecutionBackend,
    toolName: string,
    sessionId: string,
    kind: SessionKind,
    output: string,
    combineInitialOnTerminal: boolean
  ): ManagedSession {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    let resolveCompletion!: (result: BackendSessionResult) => void;
    const completion = new Promise<BackendSessionResult>((resolve) => { resolveCompletion = resolve; });
    const managed: ManagedSession = {
      sessionId,
      backend,
      toolName,
      kind,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      completion,
      resolveCompletion,
      listeners: new Set(),
      notifications: Promise.resolve(),
      output,
      combineInitialOnTerminal
    };
    this.sessions.set(sessionId, managed);
    if (backend.waitSession) {
      void backend.waitSession(sessionId).then(
        (result) => this.settle(managed, {
          ...result,
          output: managed.combineInitialOnTerminal
            ? appendOutput(managed.output, result.output)
            : result.output || managed.output
        }),
        (error) => this.settle(managed, {
          session: { sessionId, status: "error", exitCode: null, kind },
          output: error instanceof Error ? error.message : String(error)
        })
      );
    }
    return managed;
  }

  private settle(managed: ManagedSession, result: BackendSessionResult): void {
    if (managed.terminal) return;
    managed.terminal = result;
    managed.resolveCompletion(result);
    this.notify(managed, result);
  }

  private notify(managed: ManagedSession, result: BackendSessionResult): void {
    const listeners = [...managed.listeners];
    managed.listeners.clear();
    managed.notifications = managed.notifications.then(async () => {
      await Promise.allSettled(listeners.map((listener) => listener(result)));
    });
  }

  private async consume(managed: ManagedSession, result: BackendSessionResult): Promise<BackendSessionResult> {
    this.sessions.delete(managed.sessionId);
    await managed.backend.stopSession(managed.sessionId).catch(() => {});
    return result;
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const [sessionId, managed] of this.sessions) {
      if (managed.terminal || now - managed.lastUsedAt > this.idleTimeoutMs) void this.stop(sessionId);
    }
  }
}

function appendOutput(existing: string, chunk: string): string {
  if (!chunk) return existing;
  return existing ? `${existing}\n${chunk}` : chunk;
}

export const sessionManager = new SessionManager();
