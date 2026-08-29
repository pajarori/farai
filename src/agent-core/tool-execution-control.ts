import type { Session, ToolDefinition } from "../types";
import { getTool } from "../agent-tools/registry";
import { canonicalToolName } from "../tool-names";

export class ToolDeadlineError extends Error {
  constructor(readonly tool: string, readonly timeoutMs: number) {
    super(`Tool ${tool} timed out after ${timeoutMs}ms`);
    this.name = "ToolDeadlineError";
  }
}

export class ToolExecutionLease {
  private active = true;
  private reason = "tool execution finished";

  isActive(): boolean {
    return this.active;
  }

  assertActive(): void {
    if (!this.active) throw new Error(`Tool context is no longer active: ${this.reason}`);
  }

  revoke(reason: string): void {
    this.active = false;
    this.reason = reason;
  }
}

export class ToolExecutionDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timeoutMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly abortFromParent: (() => void) | undefined;

  constructor(private readonly tool: string, timeoutMs: number, private readonly parentSignal?: AbortSignal) {
    this.timeoutMs = normalizeToolTimeout(timeoutMs);
    this.signal = this.controller.signal;
    this.abortFromParent = parentSignal
      ? () => this.controller.abort(parentSignal.reason ?? new Error("tool execution cancelled"))
      : undefined;
    if (parentSignal?.aborted) this.abortFromParent?.();
    else if (parentSignal && this.abortFromParent) parentSignal.addEventListener("abort", this.abortFromParent, { once: true });
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    if (Number.isFinite(this.timeoutMs)) {
      this.timer ??= setTimeout(() => {
        if (!this.signal.aborted) this.controller.abort(new ToolDeadlineError(this.tool, this.timeoutMs));
      }, this.timeoutMs);
    }
    this.signal.throwIfAborted();
    return await abortablePromise(Promise.resolve().then(work), this.signal);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.parentSignal && this.abortFromParent) this.parentSignal.removeEventListener("abort", this.abortFromParent);
  }
}

type ToolGateState = {
  activeReaders: number;
  activeWriter: boolean;
  queue: ToolGateWaiter[];
};

type ToolGateWaiter = {
  mode: "read" | "write";
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export class ToolExecutionGate {
  private readonly states = new Map<string, ToolGateState>();
  private readonly idleResolvers = new Set<() => void>();

  idle(): Promise<void> {
    if (this.states.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.add(resolve));
  }

  async run<T>(key: string, parallel: boolean, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(key, parallel ? "read" : "write", signal);
    try {
      signal?.throwIfAborted();
      return await fn();
    } finally {
      release();
    }
  }

  private acquire(key: string, mode: "read" | "write", signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("tool gate acquisition cancelled"));
        return;
      }
      const state = this.states.get(key) ?? { activeReaders: 0, activeWriter: false, queue: [] };
      this.states.set(key, state);
      const waiter: ToolGateWaiter = { mode, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = state.queue.indexOf(waiter);
          if (index === -1) return;
          state.queue.splice(index, 1);
          this.detach(waiter);
          reject(signal.reason ?? new Error("tool gate acquisition cancelled"));
          this.drain(key, state);
          this.cleanup(key, state);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      state.queue.push(waiter);
      this.drain(key, state);
    });
  }

  private drain(key: string, state: ToolGateState): void {
    if (state.activeWriter) return;
    const first = state.queue[0];
    if (!first) return;
    if (first.mode === "write") {
      if (state.activeReaders > 0) return;
      state.queue.shift();
      state.activeWriter = true;
      this.grant(first, () => {
        state.activeWriter = false;
        this.drain(key, state);
        this.cleanup(key, state);
      });
      return;
    }
    while (state.queue[0]?.mode === "read" && !state.activeWriter) {
      const next = state.queue.shift()!;
      state.activeReaders += 1;
      this.grant(next, () => {
        state.activeReaders -= 1;
        this.drain(key, state);
        this.cleanup(key, state);
      });
    }
  }

  private cleanup(key: string, state: ToolGateState): void {
    if (state.activeReaders === 0 && !state.activeWriter && state.queue.length === 0 && this.states.get(key) === state) {
      this.states.delete(key);
      if (this.states.size === 0) {
        for (const resolve of this.idleResolvers) resolve();
        this.idleResolvers.clear();
      }
    }
  }

  private grant(waiter: ToolGateWaiter, release: () => void): void {
    this.detach(waiter);
    waiter.resolve(release);
  }

  private detach(waiter: ToolGateWaiter): void {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    delete waiter.onAbort;
  }
}

export function leasedToolCapability<T extends object>(target: T, lease: ToolExecutionLease): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        lease.assertActive();
        return Reflect.apply(value, target, args);
      };
    }
  });
}

export function normalizeToolTimeout(timeoutMs: number): number {
  if (timeoutMs === Number.POSITIVE_INFINITY) return timeoutMs;
  if (!Number.isFinite(timeoutMs)) return 120_000;
  return Math.max(1, Math.floor(timeoutMs));
}

export function toolOperationTimeout(timeoutMs: number): number {
  const deadline = normalizeToolTimeout(timeoutMs);
  if (!Number.isFinite(deadline)) return deadline;
  const handoffGrace = Math.min(5_000, Math.max(50, Math.floor(deadline * 0.05)));
  return Math.max(1, deadline - handoffGrace);
}

export function abortablePromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); }
    );
  });
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted"));
}

export function toolForExecution(session: Session, name: string): ToolDefinition {
  const canonical = canonicalToolName(name);
  const tool = getTool(canonical, session);
  if (!tool) throw new Error(`unknown tool: ${canonical}`);
  const scoped = session.toolScope?.length ? new Set(session.toolScope.map(canonicalToolName)) : undefined;
  if (scoped && !scoped.has(canonical) && canonical !== "tool_invoke") {
    throw new Error(`tool ${canonical} is outside this session's scope`);
  }
  return tool;
}

export function toolConcurrencyKey(tool: ToolDefinition, session: Session, workspace: string): string {
  if (tool.concurrencyScope === "runtime") return "runtime";
  if (tool.concurrencyScope === "session") return `session:${session.id}`;
  return `workspace:${workspace}`;
}

export function toolSchedulingDefinition(tool: ToolDefinition, args: unknown, session: Session): ToolDefinition {
  if (canonicalToolName(tool.name) !== "tool_invoke" || !args || typeof args !== "object" || Array.isArray(args)) return tool;
  const targetName = canonicalToolName(String((args as Record<string, unknown>).name ?? ""));
  return getTool(targetName, session) ?? tool;
}
