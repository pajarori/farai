import type { BackendSessionResult, ExecutionBackend, SessionKind } from "../backends/types";
import { BACKGROUND_PROCESS_OUTPUT_MAX_BYTES, BoundedOutputBuffer } from "../backends/output-buffer";

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
  output: BoundedOutputBuffer;
  combineInitialOnTerminal: boolean;
  pollQueue: Promise<void>;
  closing: boolean;
  stopTask?: Promise<void>;
};

export type StartSessionResult = BackendSessionResult & { sessionId: string };

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly stopping = new Map<string, Promise<void>>();
  private starting = 0;
  private startGeneration = 0;
  private readonly startDrainWaiters = new Set<() => void>();
  private readonly rejectedAdoptionStops = new Set<Promise<void>>();
  private stopAllTask: Promise<void> | undefined;
  private reapTimer: ReturnType<typeof setTimeout> | undefined;
  private reapInFlight: Promise<void> | undefined;

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
    if (this.stopAllTask) throw new Error("Background sessions are stopping");
    await this.reapIdle();
    if (this.stopAllTask) throw new Error("Background sessions are stopping");
    if (this.runningCount() + this.starting >= this.maxConcurrent) {
      throw new Error(`Too many background sessions running (max ${this.maxConcurrent}). Stop one with session_stop before starting another.`);
    }
    const generation = this.startGeneration;
    this.starting += 1;
    try {
      const kind = opts.kind ?? "generic";
      const result = await backend.startSession(command, { yieldMs, ...(signal ? { signal } : {}), ...opts });
      if (generation !== this.startGeneration || signal?.aborted) {
        const cancellation = signal?.reason instanceof Error
          ? signal.reason
          : new Error(signal?.reason === undefined ? "Background session start cancelled" : String(signal.reason));
        if (result.session.status === "running") this.track(backend, toolName, result.session.sessionId, kind, result.output, false);
        try {
          if (result.session.status === "running") await this.stop(result.session.sessionId);
          else await backend.stopSession(result.session.sessionId);
        } catch (error) {
          throw new AggregateError([cancellation, error], "Background session start was cancelled and cleanup failed");
        }
        throw cancellation;
      }
      if (result.session.status === "running") this.track(backend, toolName, result.session.sessionId, kind, result.output, false);
      return { ...result, sessionId: result.session.sessionId };
    } finally {
      this.starting -= 1;
      if (this.starting === 0) {
        for (const resolve of this.startDrainWaiters) resolve();
        this.startDrainWaiters.clear();
      }
    }
  }

  adopt(backend: ExecutionBackend, toolName: string, sessionId: string, kind: SessionKind = "generic", output = ""): boolean {
    this.track(backend, toolName, sessionId, kind, output, true);
    if (this.stopAllTask) {
      const stopping = this.stop(sessionId);
      this.rejectedAdoptionStops.add(stopping);
      void stopping.finally(() => this.rejectedAdoptionStops.delete(stopping)).catch(() => {});
      return false;
    }
    void this.reapIdle();
    return true;
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
    const managed = sessionIds
      .map((sessionId) => this.sessions.get(sessionId))
      .filter((session): session is ManagedSession => Boolean(session));
    if (managed.length === 0) return false;
    if (timeoutMs <= 0) return managed.some((session) => session.terminal !== undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    try {
      return await Promise.race([Promise.race(managed.map((session) => session.completion)).then(() => true as const), timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async poll(sessionId: string, input: string | undefined, yieldMs: number): Promise<BackendSessionResult> {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`Unknown or expired background session: ${sessionId}`);
    managed.lastUsedAt = Date.now();
    this.scheduleReap();
    return await this.queuePoll(managed, async () => {
      if (this.sessions.get(sessionId) !== managed) throw new Error(`Unknown or expired background session: ${sessionId}`);
      if (managed.closing) return await this.stoppedResult(managed);
      if (managed.terminal) {
        await managed.notifications;
        return await this.consume(managed, managed.terminalPoll ?? managed.terminal);
      }
      let result: BackendSessionResult;
      try {
        result = await managed.backend.pollSession(sessionId, { ...(input ? { input } : {}), yieldMs });
      } catch (error) {
        if (managed.closing) return await this.stoppedResult(managed);
        throw error;
      }
      if (managed.closing) return await this.stoppedResult(managed);
      if (this.sessions.get(sessionId) !== managed) throw new Error(`Unknown or expired background session: ${sessionId}`);
      appendOutput(managed.output, result.output);
      if (result.session.status !== "running") {
        const terminal = managed.terminal ?? { ...result, output: managed.output.text() };
        managed.terminalPoll = result;
        this.settle(managed, terminal);
        return await this.consume(managed, result);
      }
      return result;
    });
  }

  async stop(sessionId: string): Promise<void> {
    const inFlight = this.stopping.get(sessionId);
    if (inFlight) return inFlight;
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    managed.closing = true;
    const stopping = (async () => {
      try {
        await managed.backend.stopSession(sessionId);
        const result: BackendSessionResult = {
          session: { sessionId, status: "error", exitCode: null, kind: managed.kind },
          output: "Background session stopped."
        };
        this.settle(managed, result);
        if (this.sessions.get(sessionId) === managed) this.sessions.delete(sessionId);
        this.scheduleReap();
      } catch (error) {
        managed.closing = false;
        throw error;
      }
    })();
    managed.stopTask = stopping;
    this.stopping.set(sessionId, stopping);
    try {
      await stopping;
    } finally {
      if (this.stopping.get(sessionId) === stopping) this.stopping.delete(sessionId);
      if (managed.stopTask === stopping) delete managed.stopTask;
    }
  }

  release(sessionId: string): void {
    void this.stop(sessionId).catch(() => {});
  }

  async stopAll(): Promise<void> {
    if (this.stopAllTask) return await this.stopAllTask;
    const task = this.stopAllOnce();
    this.stopAllTask = task;
    try {
      await task;
      const failures: unknown[] = [];
      while (this.rejectedAdoptionStops.size > 0) {
        const outcomes = await Promise.allSettled([...this.rejectedAdoptionStops]);
        failures.push(...outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []));
      }
      if (this.sessions.size > 0) {
        failures.push(new Error(`Background sessions remain active: ${[...this.sessions.keys()].join(", ")}`));
      }
      if (failures.length) throw new AggregateError(failures, "One or more background sessions could not be stopped");
    } finally {
      if (this.stopAllTask === task) this.stopAllTask = undefined;
    }
  }

  async stopMany(sessionIds: string[]): Promise<void> {
    await Promise.allSettled([...new Set(sessionIds)].map((sessionId) => this.stop(sessionId)));
  }

  isTracked(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  private runningCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) if (!session.terminal) count += 1;
    return count;
  }

  private async stopAllOnce(): Promise<void> {
    this.startGeneration += 1;
    await this.waitForStarts();
    await Promise.allSettled([...this.sessions.keys()].map((sessionId) => this.stop(sessionId)));
  }

  private async waitForStarts(): Promise<void> {
    if (this.starting === 0) return;
    await new Promise<void>((resolve) => this.startDrainWaiters.add(resolve));
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
      output: outputBuffer(output),
      combineInitialOnTerminal,
      pollQueue: Promise.resolve(),
      closing: false
    };
    this.sessions.set(sessionId, managed);
    this.scheduleReap();
    if (backend.waitSession) {
      void backend.waitSession(sessionId).then(
        (result) => this.settle(managed, {
          ...result,
          output: managed.combineInitialOnTerminal
            ? appendOutput(managed.output, result.output)
            : result.output || managed.output.text()
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
    managed.lastUsedAt = Date.now();
    this.scheduleReap();
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
    await managed.backend.stopSession(managed.sessionId);
    if (this.sessions.get(managed.sessionId) === managed) this.sessions.delete(managed.sessionId);
    this.scheduleReap();
    return result;
  }

  private queuePoll<T>(managed: ManagedSession, operation: () => Promise<T>): Promise<T> {
    const task = managed.pollQueue.then(operation);
    managed.pollQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async stoppedResult(managed: ManagedSession): Promise<BackendSessionResult> {
    await managed.stopTask;
    if (!managed.terminal) throw new Error(`Background session stop did not settle: ${managed.sessionId}`);
    await managed.notifications;
    return managed.terminal;
  }

  private reapIdle(): Promise<void> {
    if (this.reapInFlight) return this.reapInFlight;
    const operation = this.reapExpired();
    this.reapInFlight = operation;
    void operation.finally(() => {
      if (this.reapInFlight === operation) this.reapInFlight = undefined;
    }).catch(() => {});
    return operation;
  }

  private async reapExpired(): Promise<void> {
    const now = Date.now();
    const expired = [...this.sessions.values()]
      .filter((managed) => now - managed.lastUsedAt >= this.idleTimeoutMs)
      .map((managed) => managed.sessionId);
    await Promise.allSettled(expired.map((sessionId) => this.stop(sessionId)));
    this.scheduleReap();
  }

  private scheduleReap(): void {
    if (this.reapTimer) clearTimeout(this.reapTimer);
    this.reapTimer = undefined;
    if (this.sessions.size === 0) return;
    const nextExpiry = Math.min(...[...this.sessions.values()].map((managed) => managed.lastUsedAt + this.idleTimeoutMs));
    this.reapTimer = setTimeout(() => {
      this.reapTimer = undefined;
      void this.reapIdle();
    }, Math.max(1, nextExpiry - Date.now()));
    this.reapTimer.unref?.();
  }
}

function outputBuffer(initial: string): BoundedOutputBuffer {
  const output = new BoundedOutputBuffer(BACKGROUND_PROCESS_OUTPUT_MAX_BYTES);
  if (initial) output.push(initial);
  return output;
}

function appendOutput(output: BoundedOutputBuffer, chunk: string): string {
  if (!chunk) return output.text();
  if (output.totalBytes() > 0) output.push("\n");
  output.push(chunk);
  return output.text();
}

export const sessionManager = new SessionManager();
