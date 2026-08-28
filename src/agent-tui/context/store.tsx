import { useTerminalDimensions } from "@opentui/solid";
import { createContext, createEffect, createMemo, onCleanup, useContext, type JSX } from "solid-js";
import type { FaraiTuiStore, StoreActions } from "../store";
import { createFaraiStore, isAgentBusy } from "../store";
import { createTuiEventDispatcher } from "../events";
import { useTuiRuntime } from "./runtime";
import type { ProxyFlowQuery, ProxyFlowSummary } from "../../agent-tools/services/mitmproxy/flows";
import { projectMessagesToRows, type TimelineRow } from "../renderers";
import type { AgentThreadSummary } from "../runtime-port";

export function proxyRefreshQuery(): ProxyFlowQuery {
  return { limit: 300 };
}

export type TuiStoreValue = {
  store: FaraiTuiStore;
  actions: StoreActions;
  timelineRows: () => TimelineRow[];
  submitPrompt: (text: string) => Promise<void>;
  queuePrompt: (text: string) => Promise<void>;
  createSession: () => Promise<void>;
  forkCurrentSession: () => Promise<void>;
  selectSession: (sessionId: string) => Promise<void>;
  compact: (instructions?: string) => Promise<void>;
  clearCurrentSession: () => Promise<void>;
  cancelCurrentTurn: () => Promise<void>;
  refreshSnapshot: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshContainerStatus: () => Promise<void>;
  refreshServices: () => Promise<void>;
  refreshProxyFlows: () => Promise<void>;
  refreshAvailableModels: () => Promise<void>;
  refreshAgentThreads: () => Promise<void>;
  openAgentsOverlay: () => Promise<void>;
  openMcpOverlay: () => Promise<void>;
  toggleContainer: () => Promise<void>;
  setStatusDetail: (detail: string | undefined, timeoutMs?: number) => void;
};

const StoreContext = createContext<TuiStoreValue>();

type TuiStoreProviderProps = {
  initialSessionId?: string | undefined;
  onActiveSessionChange?: (sessionId: string, title?: string) => void;
  children: JSX.Element;
};

export function TuiStoreProvider(props: TuiStoreProviderProps): JSX.Element {
  const { port, workspace } = useTuiRuntime();
  const dims = useTerminalDimensions();
  const { store, setStore: _set, actions } = createFaraiStore(workspace);
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  const proxyRefreshes = new Map<string, Promise<void>>();
  const mcpRefreshes = new Map<string, Promise<void>>();
  const snapshotRefreshes = new Map<string, { generation: number; promise: Promise<void> }>();
  const snapshotGenerations = new Map<string, number>();
  const promptSubmissions = new Map<string, { generation: number }>();
  let agentThreadsRefresh: Promise<void> | undefined;
  const timelineRows = createMemo(() => projectMessagesToRows(
    store.snapshot.messages,
    Math.max(1, dims().width - 4),
    store.snapshot.runningTurnId,
    store.snapshot.toolCalls,
    store.snapshot.toolInputPreviews
  ));

  function setStatusDetail(detail: string | undefined, timeoutMs?: number): void {
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = undefined; }
    actions.statusDetailSet(detail);
    if (!detail || !timeoutMs) return;
    statusTimer = setTimeout(() => {
      statusTimer = undefined;
      if (store.ui.statusDetail === detail) actions.statusDetailSet(undefined);
    }, timeoutMs);
  }

  async function refreshSessions(): Promise<void> {
    const items = await port.listSessionItems();
    actions.sessionItemsLoaded(items);
  }

  async function refreshSnapshot(): Promise<void> {
    const sid = store.activeSessionId;
    if (!sid) return;
    await requestSnapshotRefresh(sid);
  }

  function invalidateSnapshot(sid: string): number {
    const generation = (snapshotGenerations.get(sid) ?? 0) + 1;
    snapshotGenerations.set(sid, generation);
    return generation;
  }

  function requestSnapshotRefresh(sid: string): Promise<void> {
    return refreshSnapshotFor(sid, invalidateSnapshot(sid));
  }

  function refreshSnapshotFor(sid: string, generation = snapshotGenerations.get(sid) ?? 0): Promise<void> {
    const existing = snapshotRefreshes.get(sid);
    if (existing?.generation === generation) return existing.promise;
    const refresh = (async () => {
      const snapshot = await port.loadSnapshot(sid);
      if (store.activeSessionId !== sid || snapshotGenerations.get(sid) !== generation) return;
      actions.snapshotApplied(snapshot);
      for (const entry of promptHistoryFromMessages(snapshot.messages)) {
        actions.promptHistoryAdd(entry, "session");
      }
    })();
    const entry = { generation, promise: refresh };
    snapshotRefreshes.set(sid, entry);
    void refresh.then(
      () => { if (snapshotRefreshes.get(sid) === entry) snapshotRefreshes.delete(sid); },
      () => { if (snapshotRefreshes.get(sid) === entry) snapshotRefreshes.delete(sid); }
    );
    return refresh;
  }

  async function selectSession(sessionId: string): Promise<void> {
    if (sessionId === store.activeSessionId) return;
    actions.activeSessionSet(sessionId);
    const pendingSubmission = promptSubmissions.get(sessionId);
    if (pendingSubmission) pendingSubmission.generation = actions.promptSubmissionStarted();
    props.onActiveSessionChange?.(sessionId);
    port.setActiveSession(sessionId);
    try {
      await requestSnapshotRefresh(sessionId);
    } catch (error) {
      if (store.activeSessionId !== sessionId) return;
      actions.errorSet(error instanceof Error ? error.message : String(error));
    }
    void refreshSessionMcp(sessionId);
  }

  function refreshSessionMcp(sessionId: string): Promise<void> {
    const existing = mcpRefreshes.get(sessionId);
    if (existing) return existing;
    const refresh = (async () => {
      if (store.activeSessionId !== sessionId) return;
      setStatusDetail("starting mcp");
      try {
        await port.refreshMcp();
        if (store.activeSessionId !== sessionId) return;
        const [statuses, services] = await Promise.all([port.listMcpStatuses(), port.listServices()]);
        if (store.activeSessionId !== sessionId) return;
        actions.mcpStatusesSet(statuses);
        actions.servicesSet(services);
      } catch (error) {
        if (store.activeSessionId !== sessionId) return;
        actions.errorSet(error instanceof Error ? error.message : String(error));
      } finally {
        if (store.activeSessionId === sessionId && store.ui.statusDetail === "starting mcp") setStatusDetail(undefined);
      }
    })();
    mcpRefreshes.set(sessionId, refresh);
    void refresh.finally(() => {
      if (mcpRefreshes.get(sessionId) === refresh) mcpRefreshes.delete(sessionId);
    });
    return refresh;
  }

  async function createSession(): Promise<void> {
    try {
      const session = await port.createSession();
      await refreshSessions();
      await selectSession(session.id);
    } catch (error) {
      actions.errorSet(error instanceof Error ? error.message : String(error));
    }
  }

  async function forkCurrentSession(): Promise<void> {
    const sid = store.activeSessionId;
    if (!sid) return;
    try {
      const session = await port.forkSession(sid);
      await refreshSessions();
      await selectSession(session.id);
    } catch (error) {
      actions.errorSet(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshContainerStatus(): Promise<void> {
    const sid = store.activeSessionId;
    if (!sid) return;
    try {
      const status = await port.containerStatus();
      if (store.activeSessionId !== sid) return;
      actions.containerStatusSet(containerState(
        status.imageExists,
        status.imageContractCurrent,
        status.persistentRunning,
        status.persistentImageCurrent
      ));
    } catch {
      if (store.activeSessionId !== sid) return;
      actions.containerStatusSet("missing");
    }
  }

  async function refreshServices(): Promise<void> {
    const sid = store.activeSessionId;
    if (!sid) return;
    try {
      const services = await port.listServices();
      if (store.activeSessionId !== sid) return;
      actions.servicesSet(services);
    } catch {
      if (store.activeSessionId !== sid) return;
      actions.servicesSet([]);
    }
  }

  function refreshProxyFlows(): Promise<void> {
    const sid = store.activeSessionId;
    if (!sid) return Promise.resolve();
    const inFlight = proxyRefreshes.get(sid);
    if (inFlight) return inFlight;
    const refresh = (async () => {
      try {
        // Keep one protocol-complete source list; proxy sub-tabs are local projections.
        const flows = await port.listProxyFlows(proxyRefreshQuery());
        if (store.activeSessionId !== sid) return;
        actions.proxyFlowsSet(sortProxyFlowsNewestFirst(flows));
      } catch {
        // A transient MCP failure must not blank a previously useful traffic view.
      }
    })();
    proxyRefreshes.set(sid, refresh);
    void refresh.finally(() => {
      if (proxyRefreshes.get(sid) === refresh) proxyRefreshes.delete(sid);
    });
    return refresh;
  }

  async function refreshAvailableModels(): Promise<void> {
    try {
      const models = await port.listAvailableModels();
      actions.availableModelsSet(models);
    } catch {
      actions.availableModelsSet([]);
    }
  }

  function refreshAgentThreads(): Promise<void> {
    const sid = store.activeSessionId;
    if (!sid) return Promise.resolve();
    if (agentThreadsRefresh) return agentThreadsRefresh;
    const refresh = (async () => {
      const threads = await port.listAgentThreads(sid);
      if (store.activeSessionId === sid) actions.agentThreadsSet(threads);
    })();
    agentThreadsRefresh = refresh;
    void refresh.finally(() => {
      if (agentThreadsRefresh === refresh) agentThreadsRefresh = undefined;
    });
    return refresh;
  }

  async function openAgentsOverlay(): Promise<void> {
    actions.overlayOpen("agents");
    try {
      await Promise.all([refreshSessions(), refreshAgentThreads()]);
    } catch (error) {
      actions.errorSet(error instanceof Error ? error.message : String(error));
    }
  }

  async function openMcpOverlay(): Promise<void> {
    const sid = store.activeSessionId;
    if (!sid) return;
    setStatusDetail("refreshing mcp");
    actions.mcpStatusErrorSet(undefined);
    actions.overlayOpen("mcp");
    try {
      await port.refreshMcp();
      if (store.activeSessionId !== sid) return;
      await refreshServices();
      if (store.activeSessionId !== sid) return;
      const statuses = await port.listMcpStatuses();
      if (store.activeSessionId !== sid) return;
      actions.mcpStatusesSet(statuses);
    } catch (error) {
      if (store.activeSessionId !== sid) return;
      actions.mcpStatusErrorSet(error instanceof Error ? error.message : String(error));
    } finally {
      if (store.activeSessionId === sid) setStatusDetail(undefined);
    }
  }

  async function toggleContainer(): Promise<void> {
    try {
      if (store.ui.containerStatus === "running") await port.stopContainer();
      else await port.startContainer();
      await refreshContainerStatus();
    } catch (error) {
      actions.errorSet(error instanceof Error ? error.message : String(error));
    }
  }

  async function submitPrompt(text: string): Promise<void> {
    const sid = store.activeSessionId;
    if (!sid || !text.trim()) return;
    if (promptSubmissions.has(sid) || isAgentBusy(store) || port.getRunningTurnId(sid)) {
      await queuePrompt(text);
      return;
    }
    actions.promptHistoryAdd(text);
    const submission = { generation: actions.promptSubmissionStarted() };
    promptSubmissions.set(sid, submission);
    try {
      await port.prompt(sid, text);
    } catch (error) {
      if (store.activeSessionId !== sid) return;
      actions.errorSet(error instanceof Error ? error.message : String(error));
    } finally {
      if (promptSubmissions.get(sid) === submission) {
        promptSubmissions.delete(sid);
        if (store.activeSessionId !== sid) return;
        actions.promptSubmissionFinished(submission.generation);
        try {
          await requestSnapshotRefresh(sid);
        } catch (error) {
          if (store.activeSessionId === sid) actions.errorSet(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  async function queuePrompt(text: string): Promise<void> {
    const sid = store.activeSessionId;
    if (!sid || !text.trim()) return;
    const queued = port.queueInput(sid, text);
    if (!queued) return;
    actions.snapshotPatched({ queuedPrompts: mergeQueuedPrompts(store.snapshot.queuedPrompts, queued) });
    actions.promptHistoryAdd(text);
    try {
      const activity = await port.loadActivityState(sid);
      if (store.activeSessionId !== sid) return;
      actions.snapshotPatched(activity);
    } catch {
    }
  }

  async function compact(instructions?: string): Promise<void> {
    const sid = store.activeSessionId;
    if (!sid || store.ui.compacting) return;
    if (store.ui.submitting || store.snapshot.runningTurnId || port.getRunningTurnId(sid)) {
      await queuePrompt(`/compact${instructions ? ` ${instructions}` : ""}`);
      return;
    }
    actions.compactStarted();
    try {
      await port.compact(sid, instructions);
      if (store.activeSessionId !== sid) return;
      await refreshSnapshot();
      setStatusDetail("context compacted", 1_500);
    } catch (error) {
      if (store.activeSessionId !== sid) return;
      const message = error instanceof Error ? error.message : String(error);
      if (!/abort|cancel/i.test(message)) actions.errorSet(message);
    } finally {
      if (store.activeSessionId === sid) actions.compactFinished();
    }
  }

  async function clearCurrentSession(): Promise<void> {
    const sid = store.activeSessionId;
    if (!sid) return;
    if (isAgentBusy(store) || port.getRunningTurnId(sid)) {
      await queuePrompt("/clear");
      return;
    }
    try {
      await port.clearSession(sid);
      if (store.activeSessionId !== sid) return;
      await refreshSnapshot();
      actions.chatCleared();
      setStatusDetail("conversation cleared", 1_500);
    } catch (error) {
      if (store.activeSessionId !== sid) return;
      actions.errorSet(error instanceof Error ? error.message : String(error));
    }
  }

  async function cancelCurrentTurn(): Promise<void> {
    const sid = store.activeSessionId;
    if (!sid) return;
    if (store.ui.compacting) {
      port.cancelCompaction(sid);
      actions.compactFinished();
      return;
    }
    const turnId = store.snapshot.runningTurnId ?? port.getRunningTurnId(sid);
    if (!turnId) return;
    try {
      await port.cancelTurn(turnId, "cancelled by user");
    } catch (error) {
      actions.errorSet(error instanceof Error ? error.message : String(error));
    }
    await refreshSnapshot();
  }

  const eventDispatcher = createTuiEventDispatcher({
    getActiveSessionId: () => store.activeSessionId,
    port,
    actions,
    setStatusDetail,
    refreshSnapshot: requestSnapshotRefresh,
    onSnapshot: () => undefined
  }, (error) => actions.errorSet(error instanceof Error ? error.message : String(error)));
  const off = port.event.on((event) => {
    if (event.type === "store.changed" || event.type === "store.batch") invalidateSnapshot(event.sessionId);
    eventDispatcher.dispatch(event);
  });
  onCleanup(() => {
    off();
    eventDispatcher.dispose();
    if (statusTimer) clearTimeout(statusTimer);
  });

  createEffect(() => {
    const session = store.snapshot.session;
    if (session && session.id === store.activeSessionId) props.onActiveSessionChange?.(session.id, session.title);
  });

  createEffect(() => {
    if (store.ui.activeMainTab !== "proxy") return;
    let disposed = false;
    const tick = async () => {
      if (disposed) return;
      await refreshServices();
      await refreshProxyFlows();
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, 1_000);
    onCleanup(() => {
      disposed = true;
      clearInterval(timer);
    });
  });

  void (async () => {
    try {
      await refreshSessions();
      const seed = props.initialSessionId ?? store.sessions[0]?.id;
      if (seed) await selectSession(seed);
    } catch (error) {
      actions.errorSet(error instanceof Error ? error.message : String(error));
    } finally {
      actions.setStatus("ready");
    }
  })();

  const value: TuiStoreValue = {
    store,
    actions,
    timelineRows,
    submitPrompt,
    queuePrompt,
    createSession,
    forkCurrentSession,
    selectSession,
    compact,
    clearCurrentSession,
    cancelCurrentTurn,
    refreshSnapshot,
    refreshSessions,
    refreshContainerStatus,
    refreshServices,
    refreshProxyFlows,
    refreshAvailableModels,
    refreshAgentThreads,
    openAgentsOverlay,
    openMcpOverlay,
    toggleContainer,
    setStatusDetail
  };

  return <StoreContext.Provider value={value}>{props.children}</StoreContext.Provider>;
}

function sortProxyFlowsNewestFirst(flows: ProxyFlowSummary[]): ProxyFlowSummary[] {
  return flows.slice().sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp));
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeQueuedPrompts(current: FaraiTuiStore["snapshot"]["queuedPrompts"], queued: FaraiTuiStore["snapshot"]["queuedPrompts"][number]): FaraiTuiStore["snapshot"]["queuedPrompts"] {
  if (current.some((item) => item.id === queued.id)) return current;
  return [...current, queued].sort((left, right) => left.sequence - right.sequence);
}

export function useTuiStore(): TuiStoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("TuiStoreProvider missing");
  return ctx;
}

export function hasNewUserMessage(messages: Array<{ id: string; role: string }>, knownIds: ReadonlySet<string>): boolean {
  return messages.some((message) => message.role === "user" && !knownIds.has(message.id));
}

export function promptHistoryFromMessages(messages: Array<{ role: string; parts: Array<{ type: string; payload: unknown }> }>): string[] {
  const values: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of message.parts) {
      if (part.type !== "text") continue;
      const text = textFromPayload(part.payload);
      if (typeof text === "string" && text.trim()) values.push(text);
    }
  }
  return values;
}

function containerState(
  imageExists: boolean,
  imageContractCurrent: boolean,
  persistentRunning: boolean,
  persistentImageCurrent: boolean
): "missing" | "running" | "stopped" {
  if (!imageExists || !imageContractCurrent) return "missing";
  return persistentRunning && persistentImageCurrent ? "running" : "stopped";
}

function textFromPayload(payload: unknown): unknown {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && "text" in payload) {
    return (payload as { text?: unknown }).text;
  }
  return undefined;
}
