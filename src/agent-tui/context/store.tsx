import { createContext, createEffect, onCleanup, useContext, type JSX } from "solid-js";
import type { FaraiTuiStore, StoreActions } from "../store";
import { createFaraiStore } from "../store";
import { createTuiEventDispatcher } from "../events";
import { useTuiRuntime } from "./runtime";
import type { TimelineRow } from "../renderers";
import type { UserInputAnswer } from "../../types";
import type { PreparedUpdateCheck } from "../update-check";
import { createTranscriptStreamEngine, type TranscriptStreamEngine } from "../transcript/stream-engine";
import { createTranscriptProjection } from "../transcript/projection";
import { TerminalDimensionsProvider, useTuiDimensions } from "./terminal";
import { createStoreStatusController } from "./store-status-controller";
import { createStoreSessionController } from "./store-session-controller";
import { createStoreResourceController, proxyRefreshQuery } from "./store-resource-controller";
import { createStorePromptController } from "./store-prompt-controller";

export { proxyRefreshQuery };

export type TuiStoreValue = {
  store: FaraiTuiStore;
  actions: StoreActions;
  timelineRows: () => TimelineRow[];
  transcript: TranscriptStreamEngine;
  submitPrompt: (text: string) => boolean;
  submitMcpPrompt: (server: string, prompt: string, args: string[]) => Promise<boolean>;
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
  openEmailOverlay: () => Promise<void>;
  toggleContainer: (options?: { reportError?: boolean }) => Promise<void>;
  setStatusDetail: (detail: string | undefined, timeoutMs?: number) => void;
};

const StoreContext = createContext<TuiStoreValue>();

type TuiStoreProviderProps = {
  initialSessionId?: string | undefined;
  onActiveSessionChange?: (sessionId: string, title?: string) => void;
  updateCheck?: PreparedUpdateCheck | undefined;
  children: JSX.Element;
};

export function TuiStoreProvider(props: TuiStoreProviderProps): JSX.Element {
  const { port, workspace, capabilities } = useTuiRuntime();
  const dims = useTuiDimensions();
  const { store, setStore: _set, actions } = createFaraiStore(workspace);
  const transcript = createTranscriptStreamEngine();
  let disposed = false;
  const status = createStoreStatusController({ store, actions, isDisposed: () => disposed });
  let resources!: ReturnType<typeof createStoreResourceController>;
  let prompts!: ReturnType<typeof createStorePromptController>;
  const sessions = createStoreSessionController({
    port,
    store,
    actions,
    transcript,
    isDisposed: () => disposed,
    ...(props.onActiveSessionChange ? { onActiveSessionChange: props.onActiveSessionChange } : {}),
    onSessionActivated: (sessionId) => prompts.onSessionActivated(sessionId),
    onSessionReady: (sessionId) => { void resources.refreshSessionMcp(sessionId); }
  });
  resources = createStoreResourceController({
    port,
    store,
    actions,
    sessions,
    setStatusDetail: status.set,
    isDisposed: () => disposed
  });
  prompts = createStorePromptController({
    port,
    capabilities,
    store,
    actions,
    sessions,
    setStatusDetail: status.set,
    isDisposed: () => disposed
  });
  if (props.updateCheck?.cachedNotice) actions.updateNoticeSet(props.updateCheck.cachedNotice);
  if (props.updateCheck?.refresh) {
    void props.updateCheck.refresh.then((notice) => {
      if (!disposed) actions.updateNoticeSet(notice);
    });
  }
  const timelineRows = createTranscriptProjection(store, () => Math.max(1, dims().width - 4));
  const eventDispatcher = createTuiEventDispatcher({
    getActiveSessionId: () => store.activeSessionId,
    port,
    actions,
    setStatusDetail: status.set,
    refreshSnapshot: sessions.requestSnapshotRefresh,
    refreshSessions: sessions.refreshSessions,
    onSnapshot: (snapshot) => transcript.reconcile(snapshot.messages, snapshot.runningTurnId),
    onTurnStarted: (turnId) => transcript.beginTurn(turnId),
    onTurnFinished: (turnId) => transcript.finishTurn(turnId),
    onStreamText: (partId, text, turnId) => transcript.updateText(partId, text, turnId),
    onStreamReasoning: (partId, rationale, turnId) => transcript.updateReasoning(partId, rationale, turnId)
  }, (error) => {
    if (!disposed) actions.errorSet(error instanceof Error ? error.message : String(error));
  });
  const off = port.event.on((event) => {
    if (disposed) return;
    if (event.type === "store.changed" || event.type === "store.batch" || event.type === "turn.started") {
      sessions.invalidateSnapshot(event.sessionId);
    }
    eventDispatcher.dispatch(event);
  });
  onCleanup(() => {
    disposed = true;
    off();
    eventDispatcher.dispose();
    transcript.dispose();
    status.dispose();
    sessions.dispose();
    resources.dispose();
  });

  createEffect(() => {
    const session = store.snapshot.session;
    if (session && session.id === store.activeSessionId) props.onActiveSessionChange?.(session.id, session.title);
  });

  createEffect(() => {
    if (store.ui.activeMainTab !== "proxy" || store.ui.centerSurfaceStack.length > 0) return;
    let disposed = false;
    const tick = async () => {
      if (disposed) return;
      await resources.refreshServices();
      if (disposed) return;
      await resources.refreshProxyFlows();
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
      await sessions.refreshSessions();
      const seed = props.initialSessionId ?? store.sessions[0]?.id;
      if (seed) await sessions.selectSession(seed);
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
    transcript,
    submitPrompt: prompts.submitPrompt,
    submitMcpPrompt: prompts.submitMcpPrompt,
    submitUserInput: prompts.submitUserInput,
    answerUserInputQuestion: prompts.answerUserInputQuestion,
    cancelUserInput: prompts.cancelUserInput,
    queuePrompt: prompts.queuePrompt,
    createSession: sessions.createSession,
    forkCurrentSession: sessions.forkCurrentSession,
    selectSession: sessions.selectSession,
    compact: prompts.compact,
    clearCurrentSession: prompts.clearCurrentSession,
    cancelCurrentTurn: prompts.cancelCurrentTurn,
    refreshSnapshot: sessions.refreshSnapshot,
    refreshSessions: sessions.refreshSessions,
    refreshContainerStatus: resources.refreshContainerStatus,
    refreshServices: resources.refreshServices,
    refreshProxyFlows: resources.refreshProxyFlows,
    refreshAvailableModels: resources.refreshAvailableModels,
    openModelsOverlay: resources.openModelsOverlay,
    refreshAgentThreads: resources.refreshAgentThreads,
    openAgentsOverlay: resources.openAgentsOverlay,
    openMcpOverlay: resources.openMcpOverlay,
    openEmailOverlay: resources.openEmailOverlay,
    toggleContainer: resources.toggleContainer,
    setStatusDetail: status.set
  };

  return (
    <TerminalDimensionsProvider value={dims}>
      <StoreContext.Provider value={value}>{props.children}</StoreContext.Provider>
    </TerminalDimensionsProvider>
  );
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

function textFromPayload(payload: unknown): unknown {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && "text" in payload) {
    return (payload as { text?: unknown }).text;
  }
  return undefined;
}
