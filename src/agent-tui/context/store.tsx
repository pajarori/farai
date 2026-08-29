import { useTerminalDimensions } from "@opentui/solid";
import { createContext, createEffect, createMemo, onCleanup, useContext, type JSX } from "solid-js";
import type { FaraiTuiStore, StoreActions } from "../store";
import { createFaraiStore, isAgentBusy } from "../store";
import { createTuiEventDispatcher } from "../events";
import { useTuiRuntime } from "./runtime";
import type { ProxyFlowQuery, ProxyFlowSummary } from "../../agent-tools/services/mitmproxy/flows";
import { projectMessagesToRows, type TimelineRow } from "../renderers";
import type { AgentThreadSummary } from "../runtime-port";
import type { UserInputAnswer } from "../../types";

export function proxyRefreshQuery(): ProxyFlowQuery {
  return { limit: 300 };
}

export type TuiStoreValue = {
  store: FaraiTuiStore;
  actions: StoreActions;
  timelineRows: () => TimelineRow[];
  submitPrompt: (text: string) => boolean;
  submitUserInput: (answer: UserInputAnswer) => Promise<boolean>;
  answerUserInputQuestion: (questionId: string, answer: string) => Promise<boolean>;
  cancelUserInput: () => Promise<void>;
  queuePrompt: (text: string) => boolean;
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
  openModelsOverlay: () => Promise<void>;
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
  const { port, workspace, capabilities } = useTuiRuntime();
  const dims = useTerminalDimensions();
  const { store, setStore: _set, actions } = createFaraiStore(workspace);
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  const proxyRefreshes = new Map<string, Promise<void>>();
  const mcpRefreshes = new Map<string, { epoch: number; promise: Promise<void> }>();
  const snapshotRefreshes = new Map<string, { generation: number; promise: Promise<void> }>();
  const snapshotGenerations = new Map<string, number>();
  const promptSubmissions = new Map<string, { generation: number }>();
  const agentThreadRefreshes = new Map<string, { epoch: number; promise: Promise<void> }>();
  const containerToggles = new Map<string, Promise<void>>();
  let sessionRefreshGeneration = 0;
  let modelRefreshGeneration = 0;
  let sessionSelectionIntent = 0;
  let mcpOverlayGeneration = 0;
  let disposed = false;
  const timelineRows = createMemo(() => projectMessagesToRows(
    store.snapshot.messages,
    Math.max(1, dims().width - 4),
    store.snapshot.runningTurnId,
    store.snapshot.toolCalls,
    store.snapshot.toolInputPreviews
  ));

  function setStatusDetail(detail: string | undefined, timeoutMs?: number): void {
    if (disposed) return;
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = undefined; }
    actions.statusDetailSet(detail);
    if (!detail || !timeoutMs) return;
    statusTimer = setTimeout(() => {
      statusTimer = undefined;
      if (disposed) return;
      if (store.ui.statusDetail === detail) actions.statusDetailSet(undefined);
    }, timeoutMs);
  }

  function captureSessionOwner(sessionId = store.activeSessionId): { sessionId: string; epoch: number } | undefined {
    if (disposed || !sessionId || store.activeSessionId !== sessionId) return undefined;
    return { sessionId, epoch: sessionSelectionIntent };
  }

  function ownsSession(owner: { sessionId: string; epoch: number }): boolean {
    return !disposed
      && store.activeSessionId === owner.sessionId
      && sessionSelectionIntent === owner.epoch;
  }

  async function refreshSessions(): Promise<void> {
    if (disposed) return;
    const generation = ++sessionRefreshGeneration;
    const items = await port.listSessionItems();
    if (disposed || sessionRefreshGeneration !== generation) return;
    actions.sessionItemsLoaded(items);
  }

  async function refreshSnapshot(): Promise<void> {
    if (disposed) return;
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
    if (disposed) return Promise.resolve();
    return refreshSnapshotFor(sid, invalidateSnapshot(sid));
  }

  function refreshSnapshotFor(sid: string, generation = snapshotGenerations.get(sid) ?? 0): Promise<void> {
    if (disposed) return Promise.resolve();
    const existing = snapshotRefreshes.get(sid);
    if (existing?.generation === generation) return existing.promise;
    const refresh = (async () => {
      const snapshot = await port.loadSnapshot(sid);
      if (disposed || store.activeSessionId !== sid || snapshotGenerations.get(sid) !== generation) return;
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
    if (disposed || sessionId === store.activeSessionId) return;
    const intent = ++sessionSelectionIntent;
    await selectSessionForIntent(sessionId, intent);
  }

  async function selectSessionForIntent(sessionId: string, intent: number): Promise<void> {
    if (disposed || sessionSelectionIntent !== intent) return;
    if (sessionId === store.activeSessionId) return;
    actions.activeSessionSet(sessionId);
    const pendingSubmission = promptSubmissions.get(sessionId);
    if (pendingSubmission) pendingSubmission.generation = actions.promptSubmissionStarted();
    props.onActiveSessionChange?.(sessionId);
    port.setActiveSession(sessionId);
    try {
      await requestSnapshotRefresh(sessionId);
    } catch (error) {
      if (disposed || sessionSelectionIntent !== intent || store.activeSessionId !== sessionId) return;
      actions.errorSet(error instanceof Error ? error.message : String(error));
    }
    if (!disposed && sessionSelectionIntent === intent && store.activeSessionId === sessionId) void refreshSessionMcp(sessionId);
  }

  function refreshSessionMcp(sessionId: string): Promise<void> {
    const owner = captureSessionOwner(sessionId);
    if (!owner) return Promise.resolve();
    const existing = mcpRefreshes.get(sessionId);
    if (existing?.epoch === owner.epoch) return existing.promise;
    const refresh = (async () => {
      if (!ownsSession(owner)) return;
      setStatusDetail("starting mcp");
      try {
        await port.refreshMcp();
        if (!ownsSession(owner)) return;
        const [statuses, services] = await Promise.all([port.listMcpStatuses(), port.listServices()]);
        if (!ownsSession(owner)) return;
        actions.mcpStatusesSet(statuses);
        actions.servicesSet(services);
      } catch (error) {
        if (!ownsSession(owner)) return;
        actions.errorSet(error instanceof Error ? error.message : String(error));
      } finally {
        if (ownsSession(owner) && store.ui.statusDetail === "starting mcp") setStatusDetail(undefined);
      }
    })();
    const entry = { epoch: owner.epoch, promise: refresh };
    mcpRefreshes.set(sessionId, entry);
    const cleanup = () => {
      if (mcpRefreshes.get(sessionId) === entry) mcpRefreshes.delete(sessionId);
    };
    void refresh.then(cleanup, cleanup);
    return refresh;
  }

  async function createSession(): Promise<void> {
    if (disposed) return;
    const intent = ++sessionSelectionIntent;
    try {
      const session = await port.createSession();
      if (disposed || sessionSelectionIntent !== intent) return;
      await refreshSessions();
      await selectSessionForIntent(session.id, intent);
    } catch (error) {
      if (disposed || sessionSelectionIntent !== intent) return;
      actions.errorSet(error instanceof Error ? error.message : String(error));
    }
  }

  async function forkCurrentSession(): Promise<void> {
    if (disposed) return;
    const sid = store.activeSessionId;
    if (!sid) return;
    const intent = ++sessionSelectionIntent;
    try {
      const session = await port.forkSession(sid);
      if (disposed || sessionSelectionIntent !== intent) return;
      await refreshSessions();
      await selectSessionForIntent(session.id, intent);
    } catch (error) {
      if (disposed || sessionSelectionIntent !== intent) return;
      actions.errorSet(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshContainerStatus(): Promise<void> {
    const owner = captureSessionOwner();
    if (!owner) return;
    try {
      const status = await port.containerStatus();
      if (!ownsSession(owner)) return;
      actions.containerStatusSet(containerState(
        status.imageExists,
        status.imageContractCurrent,
        status.persistentRunning,
        status.persistentImageCurrent
      ));
    } catch {
      if (!ownsSession(owner)) return;
      actions.containerStatusSet("missing");
    }
  }

  async function refreshServices(): Promise<void> {
    const owner = captureSessionOwner();
    if (!owner) return;
    try {
      const services = await port.listServices();
      if (!ownsSession(owner)) return;
      actions.servicesSet(services);
    } catch {
      if (!ownsSession(owner)) return;
      actions.servicesSet([]);
    }
  }

  function refreshProxyFlows(): Promise<void> {
    const owner = captureSessionOwner();
    if (!owner) return Promise.resolve();
    const key = `${owner.sessionId}:${owner.epoch}`;
    const inFlight = proxyRefreshes.get(key);
    if (inFlight) return inFlight;
    const refresh = (async () => {
      try {
        // Keep one protocol-complete source list; proxy sub-tabs are local projections.
        const flows = await port.listProxyFlows(proxyRefreshQuery());
        if (!ownsSession(owner)) return;
        actions.proxyFlowsSet(sortProxyFlowsNewestFirst(flows));
      } catch {
        // A transient MCP failure must not blank a previously useful traffic view.
      }
    })();
    proxyRefreshes.set(key, refresh);
    const cleanup = () => {
      if (proxyRefreshes.get(key) === refresh) proxyRefreshes.delete(key);
    };
    void refresh.then(cleanup, cleanup);
    return refresh;
  }

  async function refreshAvailableModels(): Promise<void> {
    if (disposed) return;
    const generation = ++modelRefreshGeneration;
    try {
      const catalog = await port.loadModelCatalog();
      if (disposed || modelRefreshGeneration !== generation) return;
      actions.modelCatalogSet(catalog.providers, catalog.models);
    } catch {
      if (disposed || modelRefreshGeneration !== generation) return;
      actions.availableModelsSet([]);
    }
  }

  async function openModelsOverlay(): Promise<void> {
    if (disposed) return;
    actions.overlayOpen("model");
    setStatusDetail("loading models");
    try {
      await refreshAvailableModels();
    } finally {
      if (!disposed && store.ui.statusDetail === "loading models") setStatusDetail(undefined);
    }
  }

  function refreshAgentThreads(): Promise<void> {
    const owner = captureSessionOwner();
    if (!owner) return Promise.resolve();
    const inFlight = agentThreadRefreshes.get(owner.sessionId);
    if (inFlight?.epoch === owner.epoch) return inFlight.promise;
    const refresh = (async () => {
      try {
        const threads = await port.listAgentThreads(owner.sessionId);
        if (ownsSession(owner)) actions.agentThreadsSet(threads);
      } catch (error) {
        if (ownsSession(owner)) actions.errorSet(error instanceof Error ? error.message : String(error));
      }
    })();
    const entry = { epoch: owner.epoch, promise: refresh };
    agentThreadRefreshes.set(owner.sessionId, entry);
    const cleanup = () => {
      if (agentThreadRefreshes.get(owner.sessionId) === entry) agentThreadRefreshes.delete(owner.sessionId);
    };
    void refresh.then(cleanup, cleanup);
    return refresh;
  }

  async function openAgentsOverlay(): Promise<void> {
    const owner = captureSessionOwner();
    if (!owner) return;
    actions.overlayOpen("agents");
    try {
      await Promise.all([refreshSessions(), refreshAgentThreads()]);
    } catch (error) {
      if (!ownsSession(owner)) return;
      actions.errorSet(error instanceof Error ? error.message : String(error));
    }
  }

  async function openMcpOverlay(): Promise<void> {
    const owner = captureSessionOwner();
    if (!owner) return;
    const generation = ++mcpOverlayGeneration;
    setStatusDetail("refreshing mcp");
    actions.mcpStatusErrorSet(undefined);
    actions.overlayOpen("mcp");
    try {
      await port.refreshMcp();
      if (mcpOverlayGeneration !== generation || !ownsSession(owner)) return;
      const [services, statuses] = await Promise.all([port.listServices(), port.listMcpStatuses()]);
      if (mcpOverlayGeneration !== generation || !ownsSession(owner)) return;
      actions.servicesSet(services);
      actions.mcpStatusesSet(statuses);
    } catch (error) {
      if (mcpOverlayGeneration !== generation || !ownsSession(owner)) return;
      actions.mcpStatusErrorSet(error instanceof Error ? error.message : String(error));
    } finally {
      if (mcpOverlayGeneration === generation && ownsSession(owner) && store.ui.statusDetail === "refreshing mcp") {
        setStatusDetail(undefined);
      }
    }
  }

  function toggleContainer(): Promise<void> {
    const owner = captureSessionOwner();
    if (!owner) return Promise.resolve();
    const existing = containerToggles.get(owner.sessionId);
    if (existing) return existing;
    const toggle = (async () => {
      try {
        const status = await port.containerStatus();
        if (!ownsSession(owner)) return;
        const current = containerState(
          status.imageExists,
          status.imageContractCurrent,
          status.persistentRunning,
          status.persistentImageCurrent
        );
        if (current === "running") await port.stopContainer();
        else await port.startContainer();
        if (!ownsSession(owner)) return;
        await refreshContainerStatus();
      } catch (error) {
        if (!ownsSession(owner)) return;
        actions.errorSet(error instanceof Error ? error.message : String(error));
      }
    })();
    containerToggles.set(owner.sessionId, toggle);
    const cleanup = () => {
      if (containerToggles.get(owner.sessionId) === toggle) containerToggles.delete(owner.sessionId);
    };
    void toggle.then(cleanup, cleanup);
    return toggle;
  }

  function submitPrompt(text: string): boolean {
    if (disposed) return false;
    const sid = store.activeSessionId;
    if (!sid || !text.trim()) return false;
    if (store.snapshot.pendingUserInput) {
      actions.promptHistoryAdd(text);
      void (async () => {
        try {
          await port.answerUserInput(sid, text);
          await requestSnapshotRefresh(sid);
        } catch (error) {
          if (!disposed && store.activeSessionId === sid) actions.errorSet(error instanceof Error ? error.message : String(error));
        }
      })();
      return true;
    }
    if (promptSubmissions.has(sid) || isAgentBusy(store) || port.getRunningTurnId(sid)) {
      if (port.steer?.(sid, text)) {
        actions.promptHistoryAdd(text);
        setStatusDetail("steering submitted", 1_500);
        return true;
      }
      return queuePrompt(text);
    }
    actions.promptHistoryAdd(text);
    const submission = { generation: actions.promptSubmissionStarted() };
    promptSubmissions.set(sid, submission);
    void (async () => {
      try {
        await port.prompt(sid, text);
      } catch (error) {
        if (!disposed && store.activeSessionId === sid) actions.errorSet(error instanceof Error ? error.message : String(error));
      } finally {
        if (promptSubmissions.get(sid) === submission) {
          promptSubmissions.delete(sid);
          if (disposed || store.activeSessionId !== sid) return;
          actions.promptSubmissionFinished(submission.generation);
          try {
            await requestSnapshotRefresh(sid);
          } catch (error) {
            if (!disposed && store.activeSessionId === sid) actions.errorSet(error instanceof Error ? error.message : String(error));
          }
        }
      }
    })();
    return true;
  }

  async function submitUserInput(answer: UserInputAnswer): Promise<boolean> {
    if (disposed) return false;
    const sid = store.activeSessionId;
    const request = store.snapshot.pendingUserInput;
    if (!sid || !request || request.sessionId !== sid || store.ui.requestUserInput?.submitting) return false;
    const requestId = request.id;
    actions.requestUserInputSubmittingSet(true);
    actions.errorSet(undefined);
    try {
      await port.answerUserInputStructured(sid, answer);
      if (disposed || store.activeSessionId !== sid) return true;
      actions.snapshotPatched({ pendingUserInput: undefined });
      await requestSnapshotRefresh(sid);
      return true;
    } catch (error) {
      if (!disposed && store.activeSessionId === sid && store.snapshot.pendingUserInput?.id === requestId) {
        actions.requestUserInputSubmittingSet(false);
        actions.errorSet(error instanceof Error ? error.message : String(error));
      }
      return false;
    }
  }

  async function answerUserInputQuestion(questionId: string, rawAnswer: string): Promise<boolean> {
    const request = store.snapshot.pendingUserInput;
    const state = store.ui.requestUserInput;
    const answer = rawAnswer.trim();
    if (!request || !state || state.requestId !== request.id || state.submitting || !answer) return false;
    if (!request.questions.some((question) => question.id === questionId)) return false;
    const answers = { ...state.answers, [questionId]: answer };
    actions.requestUserInputAnswerSet(questionId, answer);
    const nextIndex = request.questions.findIndex((question) => !answers[question.id]?.trim());
    if (nextIndex >= 0) {
      actions.requestUserInputQuestionSet(nextIndex);
      return true;
    }
    return submitUserInput({ answers });
  }

  async function cancelUserInput(): Promise<void> {
    if (disposed) return;
    const sid = store.activeSessionId;
    const request = store.snapshot.pendingUserInput;
    if (!sid || !request || request.sessionId !== sid) return;
    try {
      await port.cancelUserInput(sid);
      if (disposed || store.activeSessionId !== sid) return;
      actions.snapshotPatched({ pendingUserInput: undefined });
      const turnId = store.snapshot.runningTurnId ?? port.getRunningTurnId(sid);
      if (turnId && capabilities.cancel) {
        try { await port.cancelTurn(turnId, "user input cancelled"); } catch { }
      }
      await requestSnapshotRefresh(sid);
    } catch (error) {
      if (!disposed && store.activeSessionId === sid) actions.errorSet(error instanceof Error ? error.message : String(error));
    }
  }

  function queuePrompt(text: string): boolean {
    if (disposed) return false;
    const sid = store.activeSessionId;
    try {
      if (!sid || !text.trim() || !captureSessionOwner(sid)) return false;
      const queued = port.queueInput(sid, text);
      if (!queued) return false;
      actions.snapshotPatched({ queuedPrompts: mergeQueuedPrompts(store.snapshot.queuedPrompts, queued) });
      actions.promptHistoryAdd(text);
      return true;
    } catch (error) {
      if (!disposed && store.activeSessionId === sid) actions.errorSet(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function compact(instructions?: string): Promise<void> {
    if (disposed) return;
    if (!capabilities.compact) {
      actions.errorSet("context compaction is unavailable in this TUI session");
      return;
    }
    const sid = store.activeSessionId;
    if (!sid || store.ui.compacting) return;
    if (store.ui.submitting || store.snapshot.runningTurnId || port.getRunningTurnId(sid)) {
      await queuePrompt(`/compact${instructions ? ` ${instructions}` : ""}`);
      return;
    }
    actions.compactStarted();
    try {
      await port.compact(sid, instructions);
      if (disposed || store.activeSessionId !== sid) return;
      await refreshSnapshot();
      setStatusDetail("context compacted", 1_500);
    } catch (error) {
      if (disposed || store.activeSessionId !== sid) return;
      const message = error instanceof Error ? error.message : String(error);
      if (!/abort|cancel/i.test(message)) actions.errorSet(message);
    } finally {
      if (!disposed && store.activeSessionId === sid) actions.compactFinished();
    }
  }

  async function clearCurrentSession(): Promise<void> {
    if (disposed) return;
    const sid = store.activeSessionId;
    if (!sid) return;
    if (isAgentBusy(store) || port.getRunningTurnId(sid)) {
      await queuePrompt("/clear");
      return;
    }
    try {
      await port.clearSession(sid);
      if (disposed || store.activeSessionId !== sid) return;
      await refreshSnapshot();
      actions.chatCleared();
      setStatusDetail("conversation cleared", 1_500);
    } catch (error) {
      if (disposed || store.activeSessionId !== sid) return;
      actions.errorSet(error instanceof Error ? error.message : String(error));
    }
  }

  async function cancelCurrentTurn(): Promise<void> {
    if (disposed) return;
    if (!capabilities.cancel) {
      actions.errorSet("turn cancellation is unavailable in this TUI session");
      return;
    }
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
      if (disposed || store.activeSessionId !== sid) return;
      actions.errorSet(error instanceof Error ? error.message : String(error));
    }
    try {
      await requestSnapshotRefresh(sid);
    } catch (error) {
      if (!disposed && store.activeSessionId === sid) actions.errorSet(error instanceof Error ? error.message : String(error));
    }
  }

  const eventDispatcher = createTuiEventDispatcher({
    getActiveSessionId: () => store.activeSessionId,
    port,
    actions,
    setStatusDetail,
    refreshSnapshot: requestSnapshotRefresh,
    refreshSessions,
    onSnapshot: () => undefined
  }, (error) => {
    if (!disposed) actions.errorSet(error instanceof Error ? error.message : String(error));
  });
  const off = port.event.on((event) => {
    if (disposed) return;
    if (event.type === "store.changed" || event.type === "store.batch") invalidateSnapshot(event.sessionId);
    eventDispatcher.dispatch(event);
  });
  onCleanup(() => {
    disposed = true;
    sessionSelectionIntent += 1;
    sessionRefreshGeneration += 1;
    modelRefreshGeneration += 1;
    mcpOverlayGeneration += 1;
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
      if (!disposed) actions.errorSet(error instanceof Error ? error.message : String(error));
    } finally {
      if (!disposed) actions.setStatus("ready");
    }
  })();

  const value: TuiStoreValue = {
    store,
    actions,
    timelineRows,
    submitPrompt,
    submitUserInput,
    answerUserInputQuestion,
    cancelUserInput,
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
    openModelsOverlay,
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
