import { batch } from "solid-js";
import { createStore, produce, reconcile, type SetStoreFunction } from "solid-js/store";
import type { ModelChoiceInfo } from "../agent-core/model-choices";
import type { StoreChange } from "../agent-store/sqlite-store";
import type { McpServerRuntimeStatus } from "../agent-tools/mcp-manager";
import type { ProxyFlowDetail, ProxyFlowSummary } from "../agent-tools/services/mitmproxy/flows";
import type { ServiceStatus } from "../agent-tools/services/types";
import type { CompactionBoundary, Evidence, Finding, MemoryItem, MessageWithParts, Note, QueuedUserInput, Session, SessionEvent, TodoItem, ToolCallRecord, ToolInputPreview } from "../types";
import type { OverlayKind } from "./input/router";
import { subagentActivityFromJob, type AgentThreadSummary, type BackgroundActivitySummary, type SessionListItem, type SessionSnapshot, type SubagentActivity } from "./runtime-port";

export type OverlayFrame =
  | { kind: "palette" | "sessions" | "evidence" | "findings" | "memory" | "mcp"; query: string; index: number }
  | { kind: "agents"; query: string; index: number; expandedId?: string }
  | { kind: "model"; query: string; index: number; providerID?: string };

export type CenterSurfaceFrame =
  | { kind: "detail"; title: string; body: string }
  | { kind: "alert"; title: string; body: string }
  | { kind: "confirm"; title: string; body: string; confirmLabel?: string; cancelLabel?: string }
  | { kind: "proxy_flow"; flow: ProxyFlowDetail }
  | { kind: "report" }
  | { kind: "container" };

export type UiFrame = OverlayFrame | CenterSurfaceFrame;

export type MainTab = "chat" | "proxy";
export type ProxyViewFilter = "all" | "http" | "websocket";

const PROXY_VIEW_FILTERS: readonly ProxyViewFilter[] = ["all", "http", "websocket"];

export function proxyFlowsForFilter(flows: readonly ProxyFlowSummary[], filter: ProxyViewFilter): ProxyFlowSummary[] {
  if (filter === "all") return [...flows];
  if (filter === "http") return flows.filter((flow) => flow.kind === "http" || flow.kind === "websocket");
  return flows.filter((flow) => flow.kind === filter);
}

function preferredProxyDetailPane(flow: ProxyFlowSummary | undefined, filter: ProxyViewFilter): 0 | 1 {
  return flow?.kind === "websocket" && filter !== "http" ? 1 : 0;
}

function proxyWebSocketMessageLimit(state: Pick<FaraiTuiStore["ui"], "proxyFlows" | "proxyFilter" | "proxySelectedIndex">): number {
  const flow = proxyFlowsForFilter(state.proxyFlows, state.proxyFilter)[state.proxySelectedIndex];
  return flow?.kind === "websocket" ? Math.max(0, flow.messageCount - 1) : 0;
}

export type StoreSnapshot = {
  session: Session | undefined;
  messages: MessageWithParts[];
  events: SessionEvent[];
  toolCalls: ToolCallRecord[];
  toolInputPreviews: ToolInputPreview[];
  backgroundActivities: BackgroundActivitySummary[];
  subagents: SubagentActivity[];
  todos: TodoItem[];
  evidence: Evidence[];
  notes: Note[];
  findings: Finding[];
  memory: MemoryItem[];
  runningTurnId: string | undefined;
  runningTurnStartedAt?: string | undefined;
  queuedPrompts: QueuedUserInput[];
  compactionBoundary?: CompactionBoundary | undefined;
};

export type FaraiTuiStore = {
  status: "loading" | "ready";
  workspace: string;
  sessions: Session[];
  activeSessionId: string | undefined;
  snapshot: StoreSnapshot;
  ui: {
    overlayStack: OverlayFrame[];
    centerSurfaceStack: CenterSurfaceFrame[];
    slashIndex: number;
    slashSuppressedText: string | undefined;
    promptHistory: PromptHistoryEntry[];
    historySearch: HistorySearchState | undefined;
    footerMode: "ambient" | "shortcuts" | "quit_hint" | "esc_hint";
    runningSince: number | undefined;
    submitting: boolean;
    compacting: boolean;
    statusDetail: string | undefined;
    contextUsage: ContextUsage | undefined;
    rawOutput: boolean;
    activeMainTab: MainTab;
    proxyFlows: ProxyFlowSummary[];
    proxyFilter: ProxyViewFilter;
    proxySelectedIndex: number;
    proxyDetailPane: 0 | 1;
    proxyWebSocketMessageIndex: number;
    expandedCells: Record<string, boolean>;
    containerStatus: "running" | "stopped" | "missing" | "unknown";
    services: ServiceStatus[];
    availableModels: ModelChoiceInfo[];
    mcpStatuses: McpServerRuntimeStatus[];
    mcpStatusError: string | undefined;
    messageNavigation: { direction: "next" | "prev"; sequence: number };
    centerScroll: { action: "up" | "down" | "pageUp" | "pageDown" | "home" | "end"; sequence: number };
    sessionStats: Record<string, Omit<SessionListItem, "session">>;
    agentThreads: AgentThreadSummary[];
    lastError: string | undefined;
  };
};

export type QueuedPrompt = QueuedUserInput;

export type ContextUsage = {
  tokens: number;
  budget?: number;
};

export type PromptHistoryEntry = {
  id: string;
  text: string;
  createdAt: number;
  source: "local" | "session";
};

export type HistorySearchState = {
  query: string;
  index: number;
  originalDraft: string;
};

export type StoreActions = {
  setStatus: (status: FaraiTuiStore["status"]) => void;
  sessionItemsLoaded: (items: SessionListItem[]) => void;
  activeSessionSet: (sessionId: string | undefined) => void;
  snapshotApplied: (next: SessionSnapshot) => void;
  snapshotPatched: (patch: Partial<StoreSnapshot>) => void;
  storeChangeApplied: (change: StoreChange) => void;
  storeChangesApplied: (changes: StoreChange[]) => void;
  overlayPush: (frame: UiFrame) => void;
  overlayOpen: (kind: OverlayKind) => void;
  overlayPop: () => void;
  overlayClear: () => void;
  centerSurfacePush: (frame: CenterSurfaceFrame) => void;
  centerSurfacePop: () => void;
  centerSurfaceReplaceTop: (frame: CenterSurfaceFrame) => void;
  overlayMove: (delta: number, optionCount: number) => void;
  overlaySetIndex: (index: number, optionCount: number) => void;
  overlayAppendQuery: (char: string) => void;
  overlayBackspaceQuery: () => void;
  slashIndexMove: (delta: number, optionCount: number) => void;
  slashIndexSet: (index: number, optionCount: number) => void;
  slashSuppress: (text: string | undefined) => void;
  transcriptClear: () => void;
  rawOutputToggle: () => void;
  mainTabSet: (tab: FaraiTuiStore["ui"]["activeMainTab"]) => void;
  proxyFilterSet: (filter: ProxyViewFilter) => void;
  proxyFilterCycle: (delta: number) => void;
  proxyFlowsSet: (flows: ProxyFlowSummary[]) => void;
  proxySelectedMove: (delta: number) => void;
  proxySelectedSet: (index: number) => void;
  proxyDetailPaneSet: (pane: 0 | 1) => void;
  proxyDetailPaneMove: (delta: number) => void;
  proxyWebSocketMessageSet: (index: number) => void;
  proxyWebSocketMessageMove: (delta: number) => void;
  cellExpandedToggle: (id: string) => void;
  agentDetailToggle: (id: string) => void;
  promptHistoryAdd: (text: string, source?: PromptHistoryEntry["source"]) => void;
  historySearchStart: (originalDraft: string) => void;
  historySearchStop: () => void;
  historySearchAppend: (char: string) => void;
  historySearchBackspace: () => void;
  historySearchMove: (delta: number, optionCount: number) => void;
  footerModeSet: (mode: FaraiTuiStore["ui"]["footerMode"]) => void;
  statusDetailSet: (detail: string | undefined) => void;
  contextUsageUpdated: (usage: ContextUsage | undefined) => void;
  containerStatusSet: (status: FaraiTuiStore["ui"]["containerStatus"]) => void;
  servicesSet: (services: ServiceStatus[]) => void;
  availableModelsSet: (models: ModelChoiceInfo[]) => void;
  mcpStatusesSet: (statuses: McpServerRuntimeStatus[]) => void;
  mcpStatusErrorSet: (message: string | undefined) => void;
  agentThreadsSet: (threads: AgentThreadSummary[]) => void;
  messageNavigationRequested: (direction: "next" | "prev") => void;
  centerScrollRequested: (action: FaraiTuiStore["ui"]["centerScroll"]["action"]) => void;
  chatCleared: () => void;
  promptSubmissionStarted: () => number;
  promptSubmissionFinished: (generation: number) => void;
  compactStarted: () => void;
  compactFinished: () => void;
  turnStarted: (turnId: string, startedAt?: string) => void;
  turnFinished: (turnId: string) => void;
  errorSet: (message: string | undefined) => void;
  streamTextUpdated: (partId: string, text: string) => void;
  toolInputPreviewUpdated: (preview: ToolInputPreview) => void;
  toolInputPreviewRemoved: (previewId: string) => void;
};

export type FaraiStore = {
  store: FaraiTuiStore;
  setStore: SetStoreFunction<FaraiTuiStore>;
  actions: StoreActions;
};

export function isAgentBusy(store: FaraiTuiStore): boolean {
  return Boolean(store.ui.submitting || store.ui.compacting || store.snapshot.runningTurnId);
}

export function isAgentCancelable(store: FaraiTuiStore): boolean {
  return Boolean(store.ui.compacting || store.snapshot.runningTurnId);
}

function emptySnapshot(): StoreSnapshot {
  return {
    session: undefined,
    messages: [],
    events: [],
    toolCalls: [],
    toolInputPreviews: [],
    backgroundActivities: [],
    subagents: [],
    todos: [],
    evidence: [],
    notes: [],
    findings: [],
    memory: [],
    runningTurnId: undefined,
    runningTurnStartedAt: undefined,
    queuedPrompts: [],
    compactionBoundary: undefined
  };
}

export function initialStore(workspace: string): FaraiTuiStore {
  return {
    status: "loading",
    workspace,
    sessions: [],
    activeSessionId: undefined,
    snapshot: emptySnapshot(),
    ui: {
      overlayStack: [],
      centerSurfaceStack: [],
      slashIndex: 0,
      slashSuppressedText: undefined,
      promptHistory: [],
      historySearch: undefined,
      footerMode: "ambient",
      runningSince: undefined,
      submitting: false,
      compacting: false,
      statusDetail: undefined,
      contextUsage: undefined,
      rawOutput: false,
      activeMainTab: "chat",
      proxyFlows: [],
      proxyFilter: "all",
      proxySelectedIndex: 0,
      proxyDetailPane: 0,
      proxyWebSocketMessageIndex: 0,
      expandedCells: {},
      containerStatus: "unknown",
      services: [],
      availableModels: [],
      mcpStatuses: [],
      mcpStatusError: undefined,
      messageNavigation: { direction: "next", sequence: 0 },
      centerScroll: { action: "down", sequence: 0 },
      sessionStats: {},
      agentThreads: [],
      lastError: undefined
    }
  };
}

export function createFaraiStore(workspace: string): FaraiStore {
  const [store, setStore] = createStore<FaraiTuiStore>(initialStore(workspace));
  return { store, setStore, actions: createActions(store, setStore) };
}

export function createActions(store: FaraiTuiStore, setStore: SetStoreFunction<FaraiTuiStore>): StoreActions {
  let promptSubmissionGeneration = 0;
  const applyStoreChanges = (changes: StoreChange[]): void => {
    if (changes.length === 0) return;
    setStore(produce((s) => {
      for (const change of changes) applyStoreChange(s, change);
    }));
  };
  return {
    setStatus(status: FaraiTuiStore["status"]): void {
      setStore("status", status);
    },
    sessionItemsLoaded(items: SessionListItem[]): void {
      setStore(produce((s) => {
        s.sessions = items.map((item) => item.session);
        s.ui.sessionStats = Object.fromEntries(items.map(({ session, ...stats }) => [session.id, stats]));
      }));
    },
    activeSessionSet(sessionId: string | undefined): void {
      promptSubmissionGeneration += 1;
      setStore(produce((s) => {
        s.activeSessionId = sessionId;
        s.snapshot = emptySnapshot();
        s.ui.overlayStack = [];
        s.ui.centerSurfaceStack = [];
        s.ui.slashIndex = 0;
        s.ui.slashSuppressedText = undefined;
        s.ui.historySearch = undefined;
        s.ui.footerMode = "ambient";
        s.ui.runningSince = undefined;
        s.ui.submitting = false;
        s.ui.compacting = false;
        s.ui.statusDetail = undefined;
        s.ui.contextUsage = undefined;
        s.ui.rawOutput = false;
        s.ui.activeMainTab = "chat";
        s.ui.proxyFlows = [];
        s.ui.proxyFilter = "all";
        s.ui.proxySelectedIndex = 0;
        s.ui.proxyDetailPane = 0;
        s.ui.proxyWebSocketMessageIndex = 0;
        s.ui.expandedCells = {};
        s.ui.containerStatus = "unknown";
        s.ui.services = [];
        s.ui.mcpStatuses = [];
        s.ui.centerScroll = { action: "down", sequence: 0 };
        s.ui.mcpStatusError = undefined;
        s.ui.lastError = undefined;
      }));
    },
    snapshotApplied(next: SessionSnapshot): void {
      const previousTurnId = store.snapshot.runningTurnId;
      if (next.runningTurnId && store.ui.submitting) promptSubmissionGeneration += 1;
      const toolInputPreviews = next.runningTurnId
        ? store.snapshot.toolInputPreviews.filter((preview) => preview.turnId === next.runningTurnId)
        : [];
      batch(() => {
        applySnapshotPatch(setStore, { ...next, toolInputPreviews });
        if (next.runningTurnId) setStore("ui", "submitting", false);
        syncTurnLifecycle(store, setStore, previousTurnId, next.runningTurnId, next.runningTurnStartedAt);
        setStore("ui", "contextUsage", contextUsageFromEvents(next.events));
      });
    },
    snapshotPatched(patch: Partial<StoreSnapshot>): void {
      const previousTurnId = store.snapshot.runningTurnId;
      const patchesTurn = Object.prototype.hasOwnProperty.call(patch, "runningTurnId")
        || Object.prototype.hasOwnProperty.call(patch, "runningTurnStartedAt");
      const nextTurnId = Object.prototype.hasOwnProperty.call(patch, "runningTurnId")
        ? patch.runningTurnId
        : previousTurnId;
      const nextStartedAt = Object.prototype.hasOwnProperty.call(patch, "runningTurnStartedAt")
        ? patch.runningTurnStartedAt
        : store.snapshot.runningTurnStartedAt;
      if (nextTurnId && store.ui.submitting) promptSubmissionGeneration += 1;
      batch(() => {
        applySnapshotPatch(setStore, patch);
        if (nextTurnId) setStore("ui", "submitting", false);
        if (patchesTurn) syncTurnLifecycle(store, setStore, previousTurnId, nextTurnId, nextStartedAt);
        if (patch.events) setStore("ui", "contextUsage", contextUsageFromEvents(patch.events));
      });
    },
    storeChangeApplied(change: StoreChange): void {
      applyStoreChanges([change]);
    },
    storeChangesApplied(changes: StoreChange[]): void {
      applyStoreChanges(changes);
    },
    overlayPush(frame: UiFrame): void {
      if (isSelectorFrame(frame)) {
        setStore(produce((s) => { s.ui.overlayStack.push(frame); }));
        return;
      }
      setStore(produce((s) => {
        s.ui.overlayStack = [];
        s.ui.centerScroll = { action: "down", sequence: 0 };
        s.ui.centerSurfaceStack.push(frame);
      }));
    },
    overlayOpen(kind: OverlayKind): void {
      if (isSelectorOverlayKind(kind)) {
        setStore(produce((s) => { s.ui.overlayStack.push(defaultOverlayFrame(kind)); }));
        return;
      }
      setStore(produce((s) => {
        s.ui.overlayStack = [];
        s.ui.centerScroll = { action: "down", sequence: 0 };
        s.ui.centerSurfaceStack.push(defaultCenterSurfaceFrame(kind));
      }));
    },
    overlayPop(): void {
      setStore(produce((s) => { s.ui.overlayStack.pop(); }));
    },
    overlayClear(): void {
      setStore("ui", "overlayStack", []);
    },
    centerSurfacePush(frame: CenterSurfaceFrame): void {
      setStore(produce((s) => {
        s.ui.overlayStack = [];
        s.ui.centerScroll = { action: "down", sequence: 0 };
        s.ui.centerSurfaceStack.push(frame);
      }));
    },
    centerSurfacePop(): void {
      setStore(produce((s) => { s.ui.centerSurfaceStack.pop(); }));
    },
    centerSurfaceReplaceTop(frame: CenterSurfaceFrame): void {
      setStore(produce((s) => {
        s.ui.overlayStack = [];
        s.ui.centerScroll = { action: "down", sequence: 0 };
        if (s.ui.centerSurfaceStack.length === 0) s.ui.centerSurfaceStack.push(frame);
        else s.ui.centerSurfaceStack[s.ui.centerSurfaceStack.length - 1] = frame;
      }));
    },
    overlayMove(delta: number, optionCount: number): void {
      setStore(produce((s) => {
        const top = s.ui.overlayStack[s.ui.overlayStack.length - 1];
        if (!top || !("index" in top)) return;
        top.index = clampIndex(top.index + delta, optionCount);
        if (top.kind === "agents") delete top.expandedId;
      }));
    },
    overlaySetIndex(index: number, optionCount: number): void {
      setStore(produce((s) => {
        const top = s.ui.overlayStack[s.ui.overlayStack.length - 1];
        if (!top || !("index" in top)) return;
        top.index = clampIndex(index, optionCount);
        if (top.kind === "agents") delete top.expandedId;
      }));
    },
    overlayAppendQuery(char: string): void {
      setStore(produce((s) => {
        const top = s.ui.overlayStack[s.ui.overlayStack.length - 1];
        if (!top || !("query" in top)) return;
        top.query += char;
        top.index = 0;
        if (top.kind === "agents") delete top.expandedId;
      }));
    },
    overlayBackspaceQuery(): void {
      setStore(produce((s) => {
        const top = s.ui.overlayStack[s.ui.overlayStack.length - 1];
        if (!top || !("query" in top)) return;
        top.query = top.query.slice(0, -1);
        top.index = 0;
        if (top.kind === "agents") delete top.expandedId;
      }));
    },
    slashIndexMove(delta: number, optionCount: number): void {
      setStore(produce((s) => { s.ui.slashIndex = clampIndex(s.ui.slashIndex + delta, optionCount); }));
    },
    slashIndexSet(index: number, optionCount: number): void {
      setStore(produce((s) => { s.ui.slashIndex = clampIndex(index, optionCount); }));
    },
    slashSuppress(text: string | undefined): void {
      setStore("ui", "slashSuppressedText", text);
    },

    transcriptClear(): void {
      setStore(produce((s) => {
        s.snapshot.messages = [];
        s.snapshot.events = [];
        s.snapshot.toolCalls = [];
        s.snapshot.toolInputPreviews = [];
      }));
    },
    rawOutputToggle(): void {
      setStore(produce((s) => {
        s.ui.rawOutput = !s.ui.rawOutput;
      }));
    },
    mainTabSet(tab: FaraiTuiStore["ui"]["activeMainTab"]): void {
      setStore("ui", "activeMainTab", tab);
    },
    proxyFilterSet(filter: ProxyViewFilter): void {
      setStore(produce((s) => {
        const selectedId = proxyFlowsForFilter(s.ui.proxyFlows, s.ui.proxyFilter)[s.ui.proxySelectedIndex]?.id;
        s.ui.proxyFilter = filter;
        const rows = proxyFlowsForFilter(s.ui.proxyFlows, filter);
        const nextIndex = selectedId ? rows.findIndex((flow) => flow.id === selectedId) : -1;
        s.ui.proxySelectedIndex = nextIndex === -1 ? 0 : nextIndex;
        s.ui.proxyDetailPane = preferredProxyDetailPane(rows[s.ui.proxySelectedIndex], filter);
        s.ui.proxyWebSocketMessageIndex = 0;
      }));
    },
    proxyFilterCycle(delta: number): void {
      setStore(produce((s) => {
        const currentIndex = PROXY_VIEW_FILTERS.indexOf(s.ui.proxyFilter);
        const nextIndex = (currentIndex + delta + PROXY_VIEW_FILTERS.length) % PROXY_VIEW_FILTERS.length;
        const selectedId = proxyFlowsForFilter(s.ui.proxyFlows, s.ui.proxyFilter)[s.ui.proxySelectedIndex]?.id;
        s.ui.proxyFilter = PROXY_VIEW_FILTERS[nextIndex] ?? "all";
        const rows = proxyFlowsForFilter(s.ui.proxyFlows, s.ui.proxyFilter);
        const selectedIndex = selectedId ? rows.findIndex((flow) => flow.id === selectedId) : -1;
        s.ui.proxySelectedIndex = selectedIndex === -1 ? 0 : selectedIndex;
        s.ui.proxyDetailPane = preferredProxyDetailPane(rows[s.ui.proxySelectedIndex], s.ui.proxyFilter);
        s.ui.proxyWebSocketMessageIndex = 0;
      }));
    },
    proxyFlowsSet(flows: ProxyFlowSummary[]): void {
      setStore(produce((s) => {
        const selectedId = proxyFlowsForFilter(s.ui.proxyFlows, s.ui.proxyFilter)[s.ui.proxySelectedIndex]?.id;
        const wasAtNewest = s.ui.proxySelectedIndex === 0;
        s.ui.proxyFlows = flows;
        const rows = proxyFlowsForFilter(flows, s.ui.proxyFilter);
        if (wasAtNewest || !selectedId) {
          s.ui.proxySelectedIndex = 0;
          s.ui.proxyDetailPane = preferredProxyDetailPane(rows[0], s.ui.proxyFilter);
          s.ui.proxyWebSocketMessageIndex = 0;
          return;
        }
        const nextIndex = rows.findIndex((flow) => flow.id === selectedId);
        s.ui.proxySelectedIndex = nextIndex === -1 ? clampIndex(s.ui.proxySelectedIndex, rows.length) : nextIndex;
        s.ui.proxyDetailPane = preferredProxyDetailPane(rows[s.ui.proxySelectedIndex], s.ui.proxyFilter);
        if (nextIndex === -1) s.ui.proxyWebSocketMessageIndex = 0;
        else s.ui.proxyWebSocketMessageIndex = Math.min(s.ui.proxyWebSocketMessageIndex, proxyWebSocketMessageLimit(s.ui));
      }));
    },
    proxySelectedMove(delta: number): void {
      setStore(produce((s) => {
        const rows = proxyFlowsForFilter(s.ui.proxyFlows, s.ui.proxyFilter);
        s.ui.proxySelectedIndex = clampIndex(s.ui.proxySelectedIndex + delta, rows.length);
        s.ui.proxyDetailPane = preferredProxyDetailPane(rows[s.ui.proxySelectedIndex], s.ui.proxyFilter);
        s.ui.proxyWebSocketMessageIndex = 0;
      }));
    },
    proxySelectedSet(index: number): void {
      setStore(produce((s) => {
        const rows = proxyFlowsForFilter(s.ui.proxyFlows, s.ui.proxyFilter);
        s.ui.proxySelectedIndex = clampIndex(index, rows.length);
        s.ui.proxyDetailPane = preferredProxyDetailPane(rows[s.ui.proxySelectedIndex], s.ui.proxyFilter);
        s.ui.proxyWebSocketMessageIndex = 0;
      }));
    },
    proxyDetailPaneSet(pane: 0 | 1): void {
      setStore("ui", "proxyDetailPane", pane);
    },
    proxyDetailPaneMove(delta: number): void {
      setStore("ui", "proxyDetailPane", (pane) => (pane + delta + 2) % 2 as 0 | 1);
    },
    proxyWebSocketMessageSet(index: number): void {
      setStore(produce((s) => {
        s.ui.proxyWebSocketMessageIndex = Math.min(proxyWebSocketMessageLimit(s.ui), Math.max(0, Math.floor(index)));
      }));
    },
    proxyWebSocketMessageMove(delta: number): void {
      setStore(produce((s) => {
        s.ui.proxyWebSocketMessageIndex = Math.min(proxyWebSocketMessageLimit(s.ui), Math.max(0, s.ui.proxyWebSocketMessageIndex + delta));
      }));
    },
    cellExpandedToggle(id: string): void {
      setStore(produce((s) => {
        s.ui.expandedCells[id] = !s.ui.expandedCells[id];
      }));
    },
    agentDetailToggle(id: string): void {
      setStore(produce((s) => {
        const top = s.ui.overlayStack.at(-1);
        if (top?.kind !== "agents") return;
        if (top.expandedId === id) delete top.expandedId;
        else top.expandedId = id;
      }));
    },
    promptHistoryAdd(text: string, source: PromptHistoryEntry["source"] = "local"): void {
      const trimmed = text.trim();
      if (!trimmed) return;
      setStore(produce((s) => {
        const prev = s.ui.promptHistory.filter((entry) => entry.text !== trimmed);
        prev.unshift({ id: `hist-${Date.now()}`, text: trimmed, createdAt: Date.now(), source });
        s.ui.promptHistory = prev.slice(0, 200);
      }));
    },
    historySearchStart(originalDraft: string): void {
      setStore("ui", "historySearch", { query: "", index: 0, originalDraft });
      setStore("ui", "footerMode", "ambient");
    },
    historySearchStop(): void {
      setStore("ui", "historySearch", undefined);
    },
    historySearchAppend(char: string): void {
      setStore(produce((s) => {
        if (!s.ui.historySearch) return;
        s.ui.historySearch.query += char;
        s.ui.historySearch.index = 0;
      }));
    },
    historySearchBackspace(): void {
      setStore(produce((s) => {
        if (!s.ui.historySearch) return;
        s.ui.historySearch.query = s.ui.historySearch.query.slice(0, -1);
        s.ui.historySearch.index = 0;
      }));
    },
    historySearchMove(delta: number, optionCount: number): void {
      setStore(produce((s) => {
        if (!s.ui.historySearch) return;
        s.ui.historySearch.index = clampIndex(s.ui.historySearch.index + delta, optionCount);
      }));
    },
    footerModeSet(mode: FaraiTuiStore["ui"]["footerMode"]): void {
      setStore("ui", "footerMode", mode);
    },
    statusDetailSet(detail: string | undefined): void {
      setStore("ui", "statusDetail", detail);
    },
    contextUsageUpdated(usage: ContextUsage | undefined): void {
      if (!usage) {
        setStore("ui", "contextUsage", undefined);
        return;
      }
      setStore(produce((s) => {
        s.ui.contextUsage = {
          tokens: usage.tokens,
          ...(usage.budget !== undefined
            ? { budget: usage.budget }
            : s.ui.contextUsage?.budget !== undefined
              ? { budget: s.ui.contextUsage.budget }
              : {})
        };
      }));
    },
    containerStatusSet(status: FaraiTuiStore["ui"]["containerStatus"]): void {
      setStore("ui", "containerStatus", status);
    },
    servicesSet(services: ServiceStatus[]): void {
      setStore("ui", "services", services);
    },
    availableModelsSet(models: ModelChoiceInfo[]): void {
      setStore("ui", "availableModels", models);
    },
    mcpStatusesSet(statuses: McpServerRuntimeStatus[]): void {
      setStore("ui", "mcpStatuses", statuses);
    },
    mcpStatusErrorSet(message: string | undefined): void {
      setStore("ui", "mcpStatusError", message);
    },
    agentThreadsSet(threads: AgentThreadSummary[]): void {
      setStore("ui", "agentThreads", reconcile(threads, { key: "id" }));
    },
    messageNavigationRequested(direction: "next" | "prev"): void {
      setStore(produce((s) => {
        s.ui.messageNavigation.direction = direction;
        s.ui.messageNavigation.sequence += 1;
      }));
    },
    centerScrollRequested(action: FaraiTuiStore["ui"]["centerScroll"]["action"]): void {
      setStore(produce((s) => {
        s.ui.centerScroll.action = action;
        s.ui.centerScroll.sequence += 1;
      }));
    },
    chatCleared(): void {
      promptSubmissionGeneration += 1;
      setStore(produce((s) => {
        s.ui.historySearch = undefined;
        s.ui.promptHistory = [];
        s.ui.expandedCells = {};
        s.ui.rawOutput = false;
        s.ui.submitting = false;
        s.ui.compacting = false;
        s.ui.runningSince = undefined;
        s.ui.statusDetail = undefined;
        s.ui.contextUsage = undefined;
        s.ui.lastError = undefined;
        s.snapshot.toolInputPreviews = [];
        s.snapshot.queuedPrompts = [];
      }));
    },
    promptSubmissionStarted(): number {
      const generation = ++promptSubmissionGeneration;
      setStore(produce((s) => {
        s.ui.submitting = true;
        if (s.ui.runningSince === undefined) s.ui.runningSince = Date.now();
        s.ui.statusDetail = "working";
        s.ui.lastError = undefined;
      }));
      return generation;
    },
    promptSubmissionFinished(generation: number): void {
      if (generation !== promptSubmissionGeneration) return;
      promptSubmissionGeneration += 1;
      setStore(produce((s) => {
        s.ui.submitting = false;
        if (!s.snapshot.runningTurnId && !s.ui.compacting) {
          s.ui.runningSince = undefined;
          if (isTurnStatusDetail(s.ui.statusDetail)) s.ui.statusDetail = undefined;
        }
      }));
    },
    compactStarted(): void {
      promptSubmissionGeneration += 1;
      setStore(produce((s) => {
        s.ui.submitting = false;
        s.ui.compacting = true;
        s.ui.runningSince = Date.now();
        s.ui.statusDetail = "compacting context";
        s.ui.lastError = undefined;
      }));
    },
    compactFinished(): void {
      setStore(produce((s) => {
        s.ui.compacting = false;
        if (!s.snapshot.runningTurnId && !s.ui.submitting) s.ui.runningSince = undefined;
        if (s.ui.statusDetail === "compacting context") s.ui.statusDetail = undefined;
      }));
    },
    turnStarted(turnId: string, startedAt?: string): void {
      promptSubmissionGeneration += 1;
      setStore(produce((s) => {
        const changed = s.snapshot.runningTurnId !== turnId;
        s.ui.submitting = false;
        s.snapshot.runningTurnId = turnId;
        s.snapshot.runningTurnStartedAt = startedAt;
        if (changed || s.ui.runningSince === undefined) s.ui.runningSince = turnStartedAtMs(startedAt);
        s.ui.statusDetail = "working";
        s.ui.lastError = undefined;
      }));
    },
    turnFinished(turnId: string): void {
      setStore(produce((s) => {
        if (s.snapshot.runningTurnId !== turnId) return;
        promptSubmissionGeneration += 1;
        s.ui.submitting = false;
        s.snapshot.runningTurnId = undefined;
        s.snapshot.runningTurnStartedAt = undefined;
        s.snapshot.toolInputPreviews = [];
        s.ui.runningSince = undefined;
        if (isTurnStatusDetail(s.ui.statusDetail)) s.ui.statusDetail = undefined;
      }));
    },
    errorSet(message: string | undefined): void {
      setStore("ui", "lastError", message);
    },
    streamTextUpdated(partId: string, text: string): void {
      setStore(produce((s) => {
        for (const message of s.snapshot.messages) {
          const part = message.parts.find((item) => item.id === partId);
          if (!part) continue;
          part.payload = { text };
          return;
        }
      }));
    },
    toolInputPreviewUpdated(preview: ToolInputPreview): void {
      setStore(produce((s) => {
        const index = s.snapshot.toolInputPreviews.findIndex((item) => item.id === preview.id);
        if (index === -1) s.snapshot.toolInputPreviews.push(preview);
        else s.snapshot.toolInputPreviews[index] = preview;
      }));
    },
    toolInputPreviewRemoved(previewId: string): void {
      setStore(produce((s) => {
        s.snapshot.toolInputPreviews = s.snapshot.toolInputPreviews.filter((item) => item.id !== previewId);
      }));
    }
  };
}

function applyStoreChange(store: FaraiTuiStore, change: StoreChange): void {
  switch (change.kind) {
    case "message": {
      const index = store.snapshot.messages.findIndex((item) => item.id === change.message.id);
      if (index === -1) {
        store.snapshot.messages.push({ ...change.message, parts: [] });
        if (store.snapshot.messages.length > 200) store.snapshot.messages.shift();
      } else {
        Object.assign(store.snapshot.messages[index]!, change.message);
      }
      break;
    }
    case "part": {
      const message = store.snapshot.messages.find((item) => item.id === change.part.messageId);
      if (!message) break;
      const index = message.parts.findIndex((item) => item.id === change.part.id);
      if (index === -1) message.parts.push(change.part);
      else Object.assign(message.parts[index]!, change.part);
      message.parts.sort((left, right) => left.order - right.order);
      break;
    }
    case "toolCall":
      upsertRecent(store.snapshot.toolCalls, change.toolCall, 25);
      break;
    case "evidence":
      upsertById(store.snapshot.evidence, change.evidence);
      break;
    case "finding":
      upsertById(store.snapshot.findings, change.finding);
      break;
    case "memory":
      upsertById(store.snapshot.memory, change.item);
      break;
    case "todo":
      upsertById(store.snapshot.todos, change.todo);
      break;
    case "note":
      upsertById(store.snapshot.notes, change.note);
      break;
    case "job": {
      const activity = subagentActivityFromJob(change.job);
      if (activity) upsertById(store.snapshot.subagents, activity);
      break;
    }
    case "session":
      store.snapshot.session = change.session;
      break;
    case "event":
    case "transientEvent":
    case "turn":
      break;
  }
}

function applySnapshotPatch(setStore: SetStoreFunction<FaraiTuiStore>, patch: Partial<StoreSnapshot>): void {
  for (const key of Object.keys(patch) as (keyof StoreSnapshot)[]) {
    const value = patch[key];
    if (Array.isArray(value)) setStore("snapshot", key as never, reconcile(value, { key: "id" }) as never);
    else setStore("snapshot", key as never, value as never);
  }
}

function syncTurnLifecycle(
  store: FaraiTuiStore,
  setStore: SetStoreFunction<FaraiTuiStore>,
  previousTurnId: string | undefined,
  nextTurnId: string | undefined,
  startedAt: string | undefined
): void {
  if (!nextTurnId) {
    if (!store.ui.submitting && !store.ui.compacting) {
      setStore("ui", "runningSince", undefined);
      if (isTurnStatusDetail(store.ui.statusDetail)) setStore("ui", "statusDetail", undefined);
    }
    return;
  }
  const authoritativeStartedAt = parsedTurnStartedAtMs(startedAt);
  if (previousTurnId !== nextTurnId || store.ui.runningSince === undefined || authoritativeStartedAt !== undefined) {
    setStore("ui", "runningSince", authoritativeStartedAt ?? Date.now());
  }
}

function turnStartedAtMs(startedAt: string | undefined): number {
  return parsedTurnStartedAtMs(startedAt) ?? Date.now();
}

function parsedTurnStartedAtMs(startedAt: string | undefined): number | undefined {
  const parsed = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(parsed, Date.now()) : undefined;
}

function isTurnStatusDetail(detail: string | undefined): boolean {
  return detail === "working"
    || detail === "thinking"
    || detail === "planning"
    || detail === "reading tool result"
    || detail === "running tool"
    || Boolean(detail?.startsWith("loop supervision"))
    || Boolean(detail?.startsWith("running "));
}

function upsertById<T extends { id: string }>(items: T[], item: T): void {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) items.push(item);
  else items[index] = item;
}

function upsertRecent<T extends { id: string }>(items: T[], item: T, limit: number): void {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) items.unshift(item);
  else items[index] = item;
  if (items.length > limit) items.length = limit;
}

function contextUsageFromEvents(events: SessionEvent[]): ContextUsage | undefined {
  let usage: ContextUsage | undefined;
  for (const event of events) {
    if (event.type === "planner_attempt") {
      const payload = event.payload as { contextTokens?: unknown; contextWindow?: unknown } | undefined;
      if (typeof payload?.contextTokens !== "number" || !Number.isFinite(payload.contextTokens) || payload.contextTokens < 0) continue;
      usage = {
        tokens: payload.contextTokens,
        ...(typeof payload.contextWindow === "number" && Number.isFinite(payload.contextWindow) && payload.contextWindow > 0
          ? { budget: payload.contextWindow }
          : {})
      };
      continue;
    }
    if (event.type !== "compaction" || !usage) continue;
    const payload = event.payload as { postCompactTokens?: unknown } | undefined;
    if (typeof payload?.postCompactTokens === "number" && Number.isFinite(payload.postCompactTokens) && payload.postCompactTokens >= 0) {
      usage = { ...usage, tokens: payload.postCompactTokens };
    }
  }
  return usage;
}

function defaultOverlayFrame(kind: OverlayFrame["kind"]): OverlayFrame {
  switch (kind) {
    case "palette":
    case "sessions":
    case "evidence":
    case "findings":
    case "memory":
    case "agents":
    case "model":
    case "mcp":
      return { kind, query: "", index: 0 };
  }
}

function defaultCenterSurfaceFrame(kind: OverlayKind): CenterSurfaceFrame {
  switch (kind) {
    case "detail":
      return { kind, title: "detail", body: "" };
    case "report":
    case "container":
      return { kind };
    default:
      throw new Error(`${kind} is a selector overlay, not a center surface`);
  }
}

function isSelectorOverlayKind(kind: OverlayKind): kind is OverlayFrame["kind"] {
  switch (kind) {
    case "palette":
    case "sessions":
    case "evidence":
    case "findings":
    case "memory":
    case "agents":
    case "model":
    case "mcp":
      return true;
    case "detail":
    case "report":
    case "container":
      return false;
  }
}

function isSelectorFrame(frame: UiFrame): frame is OverlayFrame {
  return "query" in frame;
}

function clampIndex(index: number, optionCount: number): number {
  if (optionCount <= 0) return 0;
  return Math.max(0, Math.min(index, optionCount - 1));
}
