import type { StoreActions } from "./store";
import type { SessionSnapshot, TuiEvent, TuiRuntimePort } from "./runtime-port";
import type { SessionEvent } from "../types";

export type EventContext = {
  getActiveSessionId: () => string | undefined;
  port: TuiRuntimePort;
  actions: StoreActions;
  beginAsyncRefresh?: (kind: AsyncRefreshKind, sessionId?: string) => () => boolean;
  setStatusDetail?: (detail: string | undefined, timeoutMs?: number) => void;
  refreshSnapshot?: (sessionId: string) => Promise<void>;
  refreshSessions?: () => Promise<void>;
  onSnapshot?: (snapshot: SessionSnapshot) => void;
  onTurnStarted?: (turnId: string) => void;
  onTurnFinished?: (turnId: string) => void;
  onStreamText?: (partId: string, text: string, turnId: string) => void;
  onStreamReasoning?: (partId: string, rationale: string, turnId: string) => void;
  afterTurnSettled?: () => void | Promise<void>;
};

export type AsyncRefreshKind = "snapshot" | "activity" | "mcp" | "sessions";

export type TuiEventDispatcher = {
  dispatch(event: TuiEvent): void;
  settle(): Promise<void>;
  dispose(): void;
};

export function createTuiEventDispatcher(
  ctx: EventContext,
  onError: (error: unknown) => void = () => {}
): TuiEventDispatcher {
  const versions = new Map<string, number>();
  const inFlight = new Set<Promise<void>>();
  let disposed = false;

  const refreshKey = (kind: AsyncRefreshKind, sessionId?: string): string => `${kind}:${sessionId ?? "*"}`;
  const bump = (kind: AsyncRefreshKind, sessionId?: string): number => {
    const key = refreshKey(kind, sessionId);
    const version = (versions.get(key) ?? 0) + 1;
    versions.set(key, version);
    return version;
  };
  const beginAsyncRefresh = (kind: AsyncRefreshKind, sessionId?: string): (() => boolean) => {
    const key = refreshKey(kind, sessionId);
    const version = bump(kind, sessionId);
    return () => !disposed && versions.get(key) === version;
  };
  const invalidateFor = (event: TuiEvent): void => {
    if (event.type === "sessions.changed") {
      bump("sessions");
      return;
    }
    if (event.type !== "event.appended") bump("snapshot", event.sessionId);
    if (event.type === "store.changed" && event.change.kind === "job") {
      bump("activity", event.sessionId);
      return;
    }
    if (event.type === "store.batch" && event.changes.some((change) => change.kind === "job")) {
      bump("activity", event.sessionId);
      return;
    }
    if (event.type !== "event.appended") return;
    if (contextUsageForEvent(event.event)) bump("snapshot", event.sessionId);
    if (isActivityStateEvent(event.event)) bump("activity", event.sessionId);
    if (isMcpStartupEvent(event.event)) bump("mcp", event.sessionId);
  };

  return {
    dispatch(event): void {
      if (disposed) return;
      invalidateFor(event);
      const task = handleTuiEvent(event, {
        ...ctx,
        beginAsyncRefresh,
        afterTurnSettled: () => disposed ? undefined : ctx.afterTurnSettled?.()
      }).catch((error) => {
        if (disposed) return;
        try { onError(error); } catch { }
      });
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    },
    async settle(): Promise<void> {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    dispose(): void {
      disposed = true;
      versions.clear();
    }
  };
}

export async function handleTuiEvent(evt: TuiEvent, ctx: EventContext): Promise<void> {
  const active = ctx.getActiveSessionId();
  const isStillActive = (sessionId: string): boolean => ctx.getActiveSessionId() === sessionId;
  async function refreshSnapshot(sessionId: string): Promise<void> {
    if (ctx.refreshSnapshot) {
      await ctx.refreshSnapshot(sessionId);
      return;
    }
    const isCurrent = ctx.beginAsyncRefresh?.("snapshot", sessionId) ?? (() => true);
    const snapshot = await ctx.port.loadSnapshot(sessionId);
    if (!isCurrent() || !isStillActive(sessionId)) return;
    ctx.actions.snapshotPatched({
      messages: snapshot.messages,
      events: snapshot.events,
      toolCalls: snapshot.toolCalls,
      backgroundActivities: snapshot.backgroundActivities,
      browserContexts: snapshot.browserContexts,
      subagents: snapshot.subagents ?? [],
      todos: snapshot.todos,
      evidence: snapshot.evidence,
      notes: snapshot.notes,
      findings: snapshot.findings,
      memory: snapshot.memory,
      runningTurnId: snapshot.runningTurnId,
      runningTurnStartedAt: snapshot.runningTurnStartedAt,
      pendingSteers: snapshot.pendingSteers,
      queuedPrompts: snapshot.queuedPrompts,
      pendingUserInput: snapshot.pendingUserInput,
      compactionBoundary: snapshot.compactionBoundary
    });
    ctx.onSnapshot?.(snapshot);
  }

  async function refreshActivityState(sessionId: string): Promise<void> {
    const isCurrent = ctx.beginAsyncRefresh?.("activity", sessionId) ?? (() => true);
    const state = await ctx.port.loadActivityState(sessionId);
    if (!isCurrent() || !isStillActive(sessionId)) return;
    ctx.actions.snapshotPatched(state);
  }

  switch (evt.type) {
    case "sessions.changed": {
      if (ctx.refreshSessions) {
        await ctx.refreshSessions();
        return;
      }
      const isCurrent = ctx.beginAsyncRefresh?.("sessions") ?? (() => true);
      const items = await ctx.port.listSessionItems();
      if (!isCurrent()) return;
      ctx.actions.sessionItemsLoaded(items);
      return;
    }
    case "event.appended":
    case "store.changed":
    case "store.batch":
    case "activity.changed":
    case "snapshot.changed":
    case "turn.started":
    case "turn.finished": {
      if (evt.sessionId !== active) return;
      break;
    }
  }
  switch (evt.type) {
    case "turn.started":
      ctx.onTurnStarted?.(evt.turnId);
      ctx.actions.turnStarted(evt.turnId, evt.startedAt);
      break;
    case "turn.finished":
      ctx.onTurnFinished?.(evt.turnId);
      ctx.actions.turnFinished(evt.turnId);
      await refreshSnapshot(evt.sessionId);
      queueMicrotask(() => { void ctx.afterTurnSettled?.(); });
      break;
    case "event.appended": {
      const contextUsage = contextUsageForEvent(evt.event);
      if (contextUsage) ctx.actions.contextUsageUpdated?.(contextUsage);
      if (isToolInputPreviewEvent(evt.event)) {
        const payload = evt.event.payload as { previewId?: unknown; turnId?: unknown; index?: unknown; providerToolCallId?: unknown; tool?: unknown; rawArguments?: unknown };
        const previewId = typeof payload.previewId === "string" ? payload.previewId : evt.event.id;
        if (evt.event.type === "tool_input_end") ctx.actions.toolInputPreviewRemoved(previewId);
        else if (typeof payload.turnId === "string" && typeof payload.index === "number") {
          ctx.actions.toolInputPreviewUpdated({
            id: previewId,
            turnId: payload.turnId,
            index: payload.index,
            ...(typeof payload.providerToolCallId === "string" ? { providerToolCallId: payload.providerToolCallId } : {}),
            tool: typeof payload.tool === "string" ? payload.tool : "tool",
            rawArguments: typeof payload.rawArguments === "string" ? payload.rawArguments : ""
          });
        }
      }
      if (evt.event.type === "stream_text") {
        const payload = evt.event.payload as { turnId?: unknown; partId?: unknown; text?: unknown } | undefined;
        if (typeof payload?.turnId === "string" && typeof payload.partId === "string" && typeof payload.text === "string") {
          ctx.onStreamText?.(payload.partId, payload.text, payload.turnId);
        }
      }
      if (evt.event.type === "stream_reasoning") {
        const payload = evt.event.payload as { turnId?: unknown; partId?: unknown; rationale?: unknown } | undefined;
        if (typeof payload?.turnId === "string" && typeof payload.partId === "string" && typeof payload.rationale === "string") {
          ctx.onStreamReasoning?.(payload.partId, payload.rationale, payload.turnId);
        }
      }
      const detail = statusDetailFor(evt.event);
      const timeout = statusTimeoutForEvent(evt.event);
      if (detail !== undefined) {
        if (ctx.setStatusDetail) ctx.setStatusDetail(detail, timeout);
        else ctx.actions.statusDetailSet(detail);
      }
      if (isMcpStartupEvent(evt.event)) {
        const isCurrent = ctx.beginAsyncRefresh?.("mcp", evt.sessionId) ?? (() => true);
        const statuses = await ctx.port.listMcpStatuses();
        if (!isCurrent() || !isStillActive(evt.sessionId)) return;
        ctx.actions.mcpStatusesSet(statuses);
      }
      if (isActivityStateEvent(evt.event)) await refreshActivityState(evt.sessionId);
      if (isUserInputControlEvent(evt.event)) await refreshSnapshot(evt.sessionId);
      break;
    }
    case "store.changed":
      ctx.actions.storeChangeApplied(evt.change);
      break;
    case "store.batch":
      ctx.actions.storeChangesApplied(evt.changes);
      break;
    case "activity.changed":
      ctx.actions.snapshotPatched(evt.state);
      break;
    case "snapshot.changed":
      await refreshSnapshot(evt.sessionId);
      break;
    default:
      break;
  }
}

function isUserInputControlEvent(event: SessionEvent): boolean {
  if (event.type !== "control" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return false;
  const kind = (event.payload as { kind?: unknown }).kind;
  return kind === "user_input_requested" || kind === "user_input_answered" || kind === "user_input_cancelled";
}

function isActivityStateEvent(event: SessionEvent): boolean {
  return event.type === "mailbox_queued"
    || event.type === "mailbox_consumed"
    || event.type === "job_completed"
    || event.type === "job_failed"
    || event.type === "job_cancelled"
    || event.type === "job_lost";
}

function statusDetailFor(event: SessionEvent): string | undefined {
  if (!event || typeof event !== "object" || !("type" in event)) return undefined;
  const typed = event as { type: string; payload?: unknown };
  if (typed.type === "tool_started") {
    const payload = typed.payload as { tool?: unknown } | undefined;
    return typeof payload?.tool === "string" ? `running ${payload.tool}` : "running tool";
  }
  if (typed.type === "reasoning_summary") return "thinking";
  if (typed.type === "planner_attempt") return plannerAttemptStatus(typed.payload);
  if (typed.type === "planner_error") return plannerErrorStatus(typed.payload);
  if (typed.type === "loop_supervision") return loopSupervisionStatus(typed.payload);
  if (typed.type === "tool_result") return "reading tool result";
  if (typed.type === "mcp_startup_update") return mcpStartupUpdateStatus(typed.payload);
  if (typed.type === "mcp_startup_complete") return mcpStartupCompleteStatus(typed.payload);
  if (typed.type === "compaction") {
    const payload = typed.payload as { stage?: unknown; boundaryId?: unknown; preCompactTokens?: unknown; postCompactTokens?: unknown } | undefined;
    if (payload?.stage === "started") return "compacting context";
    if (typeof payload?.boundaryId === "string") {
      if (typeof payload.preCompactTokens === "number" && typeof payload.postCompactTokens === "number") {
        return `context compacted ${shortTokens(payload.preCompactTokens)} -> ${shortTokens(payload.postCompactTokens)}`;
      }
      return "context compacted";
    }
  }
  return undefined;
}

function plannerAttemptStatus(payload: unknown): string {
  void payload;
  return "planning";
}

function contextUsageForEvent(event: SessionEvent): { tokens: number; budget?: number } | undefined {
  if (event.type === "planner_attempt") {
    const payload = event.payload as { contextTokens?: unknown; contextWindow?: unknown } | undefined;
    if (typeof payload?.contextTokens !== "number" || !Number.isFinite(payload.contextTokens) || payload.contextTokens < 0) return undefined;
    return {
      tokens: payload.contextTokens,
      ...(typeof payload.contextWindow === "number" && Number.isFinite(payload.contextWindow) && payload.contextWindow > 0
        ? { budget: payload.contextWindow }
        : {})
    };
  }
  if (event.type === "compaction") {
    const payload = event.payload as { postCompactTokens?: unknown } | undefined;
    if (typeof payload?.postCompactTokens === "number" && Number.isFinite(payload.postCompactTokens) && payload.postCompactTokens >= 0) {
      return { tokens: payload.postCompactTokens };
    }
  }
  return undefined;
}

function loopSupervisionStatus(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as { cause?: unknown };
  const cause = record.cause === "repeated_tool" ? "repeated calls" : "no progress";
  return `loop supervision · ${cause}`;
}

function plannerErrorStatus(payload: unknown): string | undefined {
  return retryStatus(payload);
}

function retryStatus(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as { retrying?: unknown; nextAttempt?: unknown; maxAttempts?: unknown; retryDelayMs?: unknown };
  if (record.retrying !== true || typeof record.nextAttempt !== "number" || typeof record.maxAttempts !== "number") return undefined;
  const wait = typeof record.retryDelayMs === "number" && Number.isFinite(record.retryDelayMs) && record.retryDelayMs >= 0
    ? record.retryDelayMs < 1_000 ? "<1s" : `${Math.ceil(record.retryDelayMs / 1_000)}s`
    : undefined;
  return `retrying model · ${record.nextAttempt}/${record.maxAttempts}${wait ? ` · ${wait}` : ""}`;
}

function shortTokens(value: number): string {
  if (value < 1_000) return String(Math.max(0, Math.round(value)));
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2).replace(/\.0$/, "")}k`;
}

function statusTimeoutForEvent(event: SessionEvent): number | undefined {
  if (isTerminalMcpStartupEvent(event)) return 2_000;
  if (event.type === "compaction" && typeof (event.payload as { boundaryId?: unknown } | undefined)?.boundaryId === "string") return 1_500;
  return undefined;
}

function isToolInputPreviewEvent(event: SessionEvent): boolean {
  return event.type === "tool_input_start" || event.type === "tool_input_delta" || event.type === "tool_input_end";
}

function isMcpStartupEvent(event: SessionEvent): boolean {
  return event.type === "mcp_startup_update" || event.type === "mcp_startup_complete" || event.type === "mcp_catalog_changed";
}

function isTerminalMcpStartupEvent(event: SessionEvent): boolean {
  if (event.type === "mcp_startup_complete") return true;
  if (event.type !== "mcp_startup_update") return false;
  const payload = event.payload as { status?: { state?: unknown } } | undefined;
  const state = payload?.status?.state;
  return state === "ready" || state === "failed" || state === "cancelled";
}

function mcpStartupUpdateStatus(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as { server?: unknown; status?: { state?: unknown; error?: unknown } };
  const server = typeof record.server === "string" ? record.server : "mcp";
  const state = record.status?.state;
  if (state === "starting") return `starting mcp ${server}`;
  if (state === "ready") return `mcp ${server} ready`;
  if (state === "failed") return `mcp ${server} failed`;
  if (state === "cancelled") return `mcp ${server} cancelled`;
  return undefined;
}

function mcpStartupCompleteStatus(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return "mcp refresh complete";
  const record = payload as { ready?: unknown; failed?: unknown };
  const ready = Array.isArray(record.ready) ? record.ready.length : 0;
  const failed = Array.isArray(record.failed) ? record.failed.length : 0;
  if (failed > 0) return `mcp refresh complete (${ready} ready, ${failed} failed)`;
  return ready > 0 ? `mcp refresh complete (${ready} ready)` : "mcp refresh complete";
}
