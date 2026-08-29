import type {
  AgentPromptResult,
  BackgroundJob,
  CompactionBoundary,
  MessageWithParts,
  Session,
  SessionEvent,
  ToolCallRecord,
  TodoItem,
  Turn,
  Evidence,
  Note,
  Finding,
  MemoryItem,
  PendingSteerInput,
  QueuedUserInput
} from "../types";
import type { PendingUserInput, UserInputAnswer } from "../types";
import type { AgentRuntime } from "../agent-core/runtime";
import type { SessionPatch } from "../agent-core/runtime";
import { subscribeSessionEvents, type EventSubscription } from "../agent-core/events/transport";
import { DEFAULT_KALI_IMAGE, type ContainerStatus } from "../agent-container/kali";
import type { SqliteStore, StoreChange } from "../agent-store/sqlite-store";
import type { ServiceStatus } from "../agent-tools/services/types";
import { sessionDisplayName } from "../session-title";
import { serviceRegistry } from "../agent-tools/services/registry";
import { proxyFlowDetailFromMcpInspect, proxyFlowsFromMcpTrafficSummary, readProxyFlowDetail, readProxyFlows, type ProxyFlowDetail, type ProxyFlowQuery, type ProxyFlowSummary } from "../agent-tools/services/mitmproxy/flows";
import { callMcpServerTool, listMcpServerStatuses, refreshMcpTools, type McpServerRuntimeStatus } from "../agent-tools/mcp-manager";
import type { ModelChoiceInfo } from "../agent-core/model-choices";
import { modelChoicesFromCatalog } from "../agent-core/model-choices";
import { buildModelCatalog } from "../agent-core/model-catalog";
import { listModelProviders, probeModelProvider, removeModelProvider, saveModelProvider, type ModelProviderInfo, type ModelProviderProbe, type ProbeModelProviderInput, type SaveModelProviderInput } from "../agent-core/model-provider-management";
import { loadModelProfiles } from "../agent-core/model-profiles";
import { HEURISTIC_MODEL_ID } from "../agent-core/model-registry";
import type { ContextManifest } from "../agent-core/context-engine";
import { browserContextManager, type BrowserContextActivity } from "../agent-tools/browser/context-manager";

export type TuiEvent =
  | { type: "event.appended"; sessionId: string; event: SessionEvent }
  | { type: "store.changed"; sessionId: string; change: StoreChange }
  | { type: "store.batch"; sessionId: string; changes: StoreChange[] }
  | { type: "activity.changed"; sessionId: string; state: Pick<ActivityState, "backgroundActivities" | "subagents"> }
  | { type: "turn.started"; sessionId: string; turnId: string; startedAt: string }
  | { type: "turn.finished"; sessionId: string; turnId: string; status: Turn["status"] }
  | { type: "snapshot.changed"; sessionId: string }
  | { type: "sessions.changed" };

export type TuiEventListener = (event: TuiEvent) => void;

export type SessionSnapshot = {
  session: Session;
  messages: MessageWithParts[];
  events: SessionEvent[];
  toolCalls: ToolCallRecord[];
  toolInputPreviews: import("../types").ToolInputPreview[];
  backgroundActivities: BackgroundActivitySummary[];
  browserContexts: BrowserContextActivity[];
  subagents?: SubagentActivity[];
  todos: TodoItem[];
  evidence: Evidence[];
  notes: Note[];
  findings: Finding[];
  memory: MemoryItem[];
  runningTurnId: string | undefined;
  runningTurnStartedAt?: string | undefined;
  pendingSteers: PendingSteerInput[];
  queuedPrompts: QueuedUserInput[];
  compactionBoundary?: CompactionBoundary | undefined;
  pendingUserInput?: PendingUserInput | undefined;
};

export type ActivityState = Pick<SessionSnapshot, "backgroundActivities" | "browserContexts" | "subagents" | "pendingSteers" | "queuedPrompts">;

export type BackgroundActivitySummary = {
  id: string;
  label: string;
  count: number;
};

export type SubagentActivity = {
  id: string;
  childSessionId: string;
  title: string;
  lane?: string;
  mode: "attached" | "detached";
  status: BackgroundJob["status"];
  model?: string;
  summary?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type AgentThreadSummary = {
  id: string;
  sessionId: string;
  parentSessionId?: string;
  role: "main" | "subagent";
  depth: number;
  title: string;
  lane?: string;
  mode: "attached" | "detached";
  status: BackgroundJob["status"] | "idle";
  model?: string;
  summary?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type SessionListItem = {
  session: Session;
  evidenceCount: number;
  findingCount: number;
  todoCount: number;
  running: boolean;
};

export type ModelCatalogSnapshot = {
  providers: ModelProviderInfo[];
  models: ModelChoiceInfo[];
};

export type RemoveModelProviderResult = {
  id: string;
  location: "global" | "project";
  providerRemains: boolean;
  fallbackModel: string;
  updatedSessions: number;
};

export interface TuiRuntimePort {
  listSessions(): Promise<Session[]>;
  listSessionItems(): Promise<SessionListItem[]>;
  listAgentThreads(sessionId: string): Promise<AgentThreadSummary[]>;
  loadSession(id: string): Promise<Session>;
  createSession(): Promise<Session>;
  updateSession(id: string, patch: SessionPatch): Promise<Session>;
  forkSession(id: string, title?: string): Promise<Session>;
  archiveSession(id: string): Promise<Session>;
  exportReport(id: string, options?: { write?: boolean }): Promise<{ markdown: string; path?: string }>;
  containerStatus(): Promise<ContainerStatus>;
  listServices(): Promise<ServiceStatus[]>;
  listProxyFlows(options?: ProxyFlowQuery): Promise<ProxyFlowSummary[]>;
  getProxyFlow(id: string): Promise<ProxyFlowDetail | undefined>;
  listAvailableModels(): Promise<ModelChoiceInfo[]>;
  loadModelCatalog(): Promise<ModelCatalogSnapshot>;
  probeModelProvider(input: ProbeModelProviderInput, signal?: AbortSignal): Promise<ModelProviderProbe>;
  saveModelProvider(input: SaveModelProviderInput): Promise<ModelCatalogSnapshot>;
  removeModelProvider(providerID: string): Promise<RemoveModelProviderResult>;
  refreshMcp(): Promise<void>;
  listMcpStatuses(): Promise<McpServerRuntimeStatus[]>;
  startContainer(): Promise<void>;
  stopContainer(): Promise<void>;
  loadSnapshot(sessionId: string): Promise<SessionSnapshot>;
  loadActivityState(sessionId: string): Promise<ActivityState>;
  prompt(sessionId: string, input: string): Promise<AgentPromptResult>;
  answerUserInput(sessionId: string, input: string): Promise<UserInputAnswer>;
  answerUserInputStructured(sessionId: string, answer: UserInputAnswer): Promise<UserInputAnswer>;
  cancelUserInput(sessionId: string): Promise<PendingUserInput>;
  queueInput(sessionId: string, input: string): QueuedUserInput | undefined;
  takeBackQueuedInput(sessionId: string): QueuedUserInput | undefined;
  inspectContext(sessionId: string, hypotheticalInput?: string): Promise<ContextManifest>;
  steer(sessionId: string, input: string): boolean;
  compact(sessionId: string, instructions?: string): Promise<Session>;
  cancelCompaction(sessionId: string): void;
  clearSession(sessionId: string): Promise<Session>;
  loadFullMessages(sessionId: string): Promise<MessageWithParts[]>;
  cancelTurn(turnId: string, reason?: string): Promise<Turn>;
  setActiveSession(sessionId: string | undefined): void;
  getRunningTurnId(sessionId: string): string | undefined;
  event: { on(cb: TuiEventListener): () => void };
  dispose(): Promise<void>;
}

export type TuiCapabilities = {
  compact: boolean;
  cancel: boolean;
};

export type TuiInput = {
  workspace: string;
  sessionId?: string | undefined;
  capabilities?: TuiCapabilities | undefined;
  runtime: TuiRuntimePort;
};

const BATCH_DEBOUNCE_MS = 16;
const RUNNING_STATUSES: Turn["status"][] = ["running"];
const POLL_FALLBACK_INTERVAL_MS = 200;

function isRunning(status: Turn["status"]): boolean {
  return RUNNING_STATUSES.includes(status);
}

type PortOptions = {
  forcePoll?: boolean;
};

export function createRuntimePort(runtime: AgentRuntime, options: PortOptions = {}): TuiRuntimePort {
  const listeners = new Set<TuiEventListener>();
  const pending: TuiEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  let activeSessionId: string | undefined;
  let unsubscribeStore: (() => void) | undefined;
  let unsubscribeBrowserContexts: (() => void) | undefined;
  let eventSubscription: EventSubscription | undefined;
  let eventCursor = 0;
  let sessionsCache: string | undefined;
  const runningTurnByTurnId = new Map<string, Turn["status"]>();
  let cachedRunningTurnId: string | undefined;

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const store: SqliteStore = runtime.store;
  const usePush = !options.forcePoll && typeof store.subscribe === "function";

  function flush(): void {
    flushTimer = undefined;
    if (pending.length === 0) return;
    const drained = pending.splice(0, pending.length);
    for (const evt of drained) {
      if (evt.type !== "sessions.changed" && evt.sessionId !== activeSessionId) continue;
      for (const listener of listeners) {
        try { listener(evt); } catch {  }
      }
    }
  }

  function enqueue(evt: TuiEvent): void {
    if (disposed) return;
    if (evt.type === "snapshot.changed" && pending.some((item) => item.type === "snapshot.changed" && item.sessionId === evt.sessionId)) return;
    const streamIdentity = transientStreamIdentity(evt);
    if (streamIdentity) {
      const existing = pending.length - 1;
      if (existing >= 0 && transientStreamIdentity(pending[existing]!) === streamIdentity) pending[existing] = evt;
      else pending.push(evt);
      if (!flushTimer) flushTimer = setTimeout(flush, BATCH_DEBOUNCE_MS);
      return;
    }
    if (evt.type === "activity.changed") {
      const existing = pending.findIndex((item) => item.type === "activity.changed" && item.sessionId === evt.sessionId);
      if (existing >= 0) pending[existing] = evt;
      else pending.push(evt);
      if (!flushTimer) flushTimer = setTimeout(flush, BATCH_DEBOUNCE_MS);
      return;
    }
    if (evt.type === "store.changed") {
      const previous = pending.at(-1);
      if (previous?.type === "store.batch" && previous.sessionId === evt.sessionId) {
        const previousChange = previous.changes.at(-1);
        if (previousChange && storeChangeIdentity(previousChange) === storeChangeIdentity(evt.change)) {
          previous.changes[previous.changes.length - 1] = evt.change;
        } else {
          previous.changes.push(evt.change);
        }
        return;
      }
      pending.push({ type: "store.batch", sessionId: evt.sessionId, changes: [evt.change] });
      if (!flushTimer) flushTimer = setTimeout(flush, BATCH_DEBOUNCE_MS);
      return;
    }
    pending.push(evt);
    if (flushTimer) return;
    flushTimer = setTimeout(flush, BATCH_DEBOUNCE_MS);
  }

  function updateRunningFromTurn(turn: Turn): void {
    const prev = runningTurnByTurnId.get(turn.id);
    runningTurnByTurnId.set(turn.id, turn.status);
    const wasRunning = prev !== undefined && isRunning(prev);
    const nowRunning = isRunning(turn.status);
    if (!wasRunning && nowRunning) {
      cachedRunningTurnId = turn.id;
      enqueue({ type: "turn.started", sessionId: turn.sessionId, turnId: turn.id, startedAt: turn.createdAt });
    }
    if (wasRunning && !nowRunning) {
      if (cachedRunningTurnId === turn.id) cachedRunningTurnId = undefined;
      enqueue({ type: "turn.finished", sessionId: turn.sessionId, turnId: turn.id, status: turn.status });
    }
  }

  function subscribeStore(sessionId: string, cursor = store.latestEventSequence(sessionId)): void {
    unsubscribeStore?.();
    eventSubscription?.close();
    eventCursor = cursor;
    eventSubscription = subscribeSessionEvents(store, sessionId, eventCursor, (event) => {
      eventCursor = event.sequence ?? eventCursor;
      enqueue({ type: "event.appended", sessionId, event });
    });
    unsubscribeStore = store.subscribe(sessionId, (change: StoreChange) => {
      switch (change.kind) {
        case "event":
          break;
        case "transientEvent":
          enqueue({ type: "event.appended", sessionId: change.sessionId, event: change.event });
          break;
        case "turn":
          updateRunningFromTurn(change.turn);
          break;
        case "session":
          enqueue({ type: "sessions.changed" });
          enqueue({ type: "snapshot.changed", sessionId: change.sessionId });
          break;
        default:
          enqueue({ type: "store.changed", sessionId: change.sessionId, change });
          if (change.kind === "job") {
            enqueue({
              type: "activity.changed",
              sessionId: change.sessionId,
              state: {
                backgroundActivities: summarizeBackgroundActivities(store, change.sessionId),
                subagents: summarizeSubagents(store, change.sessionId)
              }
            });
          }
          break;
      }
    });
  }

  function seedTurnCache(sessionId: string): void {
    runningTurnByTurnId.clear();
    cachedRunningTurnId = undefined;
    try {
      const turns = store.listTurns(sessionId, 20);
      for (const turn of turns) {
        runningTurnByTurnId.set(turn.id, turn.status);
        if (isRunning(turn.status)) cachedRunningTurnId = turn.id;
      }
    } catch {  }
  }

  function pollFallback(): void {
    if (disposed || !activeSessionId) return;
    const sessionId = activeSessionId;
    try {
      const list = store.listSessions(50, { includeArchived: true });
      const fingerprint = JSON.stringify(list.map((session) => ({
        id: session.id,
        title: session.title,
        provider: session.provider,
        model: session.model,
        phase: session.phase,
        archivedAt: session.archivedAt,
        updatedAt: session.updatedAt,
        running: store.listTurns(session.id, 5).some((turn) => isRunning(turn.status))
      })));
      if (sessionsCache === undefined) sessionsCache = fingerprint;
      else if (fingerprint !== sessionsCache) {
        sessionsCache = fingerprint;
        enqueue({ type: "sessions.changed" });
      }
    } catch {  }
    try {
      let changed = false;
      for (const event of store.listEventsAfter(sessionId, eventCursor, 400)) {
        eventCursor = event.sequence ?? eventCursor;
        enqueue({ type: "event.appended", sessionId, event });
        changed = true;
      }
      if (changed) enqueue({ type: "snapshot.changed", sessionId });
    } catch {  }
    try {
      const turns = store.listTurns(sessionId, 20);
      for (const turn of turns) updateRunningFromTurn(turn);
    } catch {  }
  }

  function startFallback(): void {
    if (pollTimer) return;
    pollTimer = setInterval(pollFallback, POLL_FALLBACK_INTERVAL_MS);
  }

  function stopFallback(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
    eventCursor = 0;
    sessionsCache = undefined;
  }

  function readSnapshot(sessionId: string): SessionSnapshot {
    const session = store.loadSession(sessionId);
    const messages = store.listVisibleMessages(sessionId, 200);
    const events = store.listEvents(sessionId, 400);
    const toolCalls = store.listToolCalls(sessionId, 25);
    const backgroundActivities = summarizeBackgroundActivities(store, sessionId);
    const browserContexts = browserContextManager.list(sessionId);
    const subagents = summarizeSubagents(store, sessionId);
    const todos = store.listTodos(sessionId, { limit: 25 });
    const evidence = store.listEvidence(sessionId);
    const notes = store.listNotes(sessionId);
    const findings = store.listFindings(sessionId);
    const memory = store.listMemory(sessionId);
    const turns = store.listTurns(sessionId, 10);
    const running = turns.find((t) => isRunning(t.status));
    return {
      session,
      messages,
      events,
      toolCalls,
      toolInputPreviews: [],
      backgroundActivities,
      browserContexts,
      subagents,
      todos,
      evidence,
      notes,
      findings,
      memory,
      runningTurnId: running?.id,
      runningTurnStartedAt: running?.createdAt,
      pendingSteers: runtime.listPendingSteeringInputs(sessionId),
      queuedPrompts: runtime.listQueuedFollowupInputs(sessionId),
      compactionBoundary: store.latestCompactionBoundary(sessionId),
      pendingUserInput: runtime.pendingUserInput(sessionId)
    };
  }

  return {
    async listSessions() { return store.listResumableSessions(100, { includeArchived: true }); },
    async listSessionItems() {
      return store.listResumableSessions(100, { includeArchived: true }).map((session) => ({
        session,
        evidenceCount: store.listEvidence(session.id).length,
        findingCount: store.listFindings(session.id).length,
        todoCount: store.listTodos(session.id).filter((todo) => todo.status !== "done" && todo.status !== "cancelled").length,
        running: store.listTurns(session.id, 5).some((turn) => isRunning(turn.status))
      }));
    },
    async listAgentThreads(sessionId) { return summarizeAgentThreads(store, sessionId); },
    async loadSession(id) { return runtime.loadSession(id); },
    async createSession() {
      const session = await runtime.createSession();

      return session;
    },
    async updateSession(id, patch) { return runtime.updateSession(id, patch); },
    async forkSession(id, title) { return runtime.forkSession(id, title); },
    async archiveSession(id) { return runtime.archiveSession(id); },
    async exportReport(id, reportOptions) { return runtime.exportReport(id, reportOptions); },
    async answerUserInput(sessionId, input) { return runtime.answerUserInput(sessionId, input); },
    async answerUserInputStructured(sessionId, answer) { return runtime.answerUserInputStructured(sessionId, answer); },
    async cancelUserInput(sessionId) { return runtime.cancelUserInput(sessionId); },
    async containerStatus() {
      if (!activeSessionId) {
        return {
          image: DEFAULT_KALI_IMAGE,
          imageExists: false,
          imageContractCurrent: false,
          persistentName: "",
          persistentRunning: false,
          persistentImageCurrent: false
        };
      }
      return runtime.containerStatus(activeSessionId);
    },
    async listServices() {
      const local = serviceRegistry.list().filter((service) => !activeSessionId || service.sessionId === activeSessionId);
      const mcp = listMcpServerStatuses(activeSessionId)
        .filter((status) => status.name.includes("mitmproxy"))
        .map((status): ServiceStatus => ({
          name: status.name,
          kind: "mitmproxy-mcp",
          sessionId: activeSessionId ?? "host",
          startedAt: Date.now(),
          detail: status.running
            ? `mcp ${status.proxy?.running ? `proxy 127.0.0.1:${status.proxy.port}` : "running"}`
            : `mcp ${status.error ?? "stopped"}`,
          metadata: {
            mcp: true,
            running: status.running,
            proxy: status.proxy
          }
        }));
      return [...mcp, ...local];
    },
    async listProxyFlows(options = {}) {
      if (activeSessionId) {
        const session = runtime.loadSession(activeSessionId);
        try {
          await refreshMcpTools({ workspace: session.workspace, configWorkspace: runtime.workspace, session, includeResources: false });
          let mcpResult: unknown;
          try {
            mcpResult = await callMcpServerTool({
              workspace: session.workspace,
              configWorkspace: runtime.workspace,
              session,
              server: "mitmproxy-mcp",
              tool: "proxy_flow_summaries",
              args: { limit: options.limit ?? 300, ...(options.kind ? { kind: options.kind } : {}) }
            });
          } catch {
            try {
              mcpResult = await callMcpServerTool({
                workspace: session.workspace,
                configWorkspace: runtime.workspace,
                session,
                server: "mitmproxy-mcp",
                tool: "get_flow_summary_v2",
                args: { limit: options.limit ?? 300, ...(options.kind ? { kind: options.kind } : {}) }
              });
            } catch {
              mcpResult = await callMcpServerTool({
                workspace: session.workspace,
                configWorkspace: runtime.workspace,
                session,
                server: "mitmproxy-mcp",
                tool: "get_traffic_summary",
                args: { limit: options.limit ?? 300 }
              });
            }
          }
          const flows = proxyFlowsFromMcpTrafficSummary(mcpResult, options);
          if (flows.length > 0 || listMcpServerStatuses(activeSessionId).some((status) => status.name === "mitmproxy-mcp" && status.running)) return flows;
        } catch {
        }
      }
      const services = serviceRegistry.list().filter((service) => service.kind === "mitmproxy" && (!activeSessionId || service.sessionId === activeSessionId));
      const selected = options.serviceName
        ? services.find((service) => service.name === options.serviceName)
        : services[0];
      const flowJsonl = typeof selected?.metadata?.flowJsonl === "string" ? selected.metadata.flowJsonl : undefined;
      if (!flowJsonl) return [];
      return await readProxyFlows(flowJsonl, options);
    },
    async getProxyFlow(id) {
      if (activeSessionId) {
        const session = runtime.loadSession(activeSessionId);
        try {
          try {
            const mcpResult = await callMcpServerTool({
              workspace: session.workspace,
              configWorkspace: runtime.workspace,
              session,
              server: "mitmproxy-mcp",
              tool: "proxy_flow_inspect",
              args: { flow_id: id }
            });
            const detail = proxyFlowDetailFromMcpInspect(mcpResult);
            if (detail) return detail;
          } catch {
          }
          try {
            const compatibleResult = await callMcpServerTool({
              workspace: session.workspace,
              configWorkspace: runtime.workspace,
              session,
              server: "mitmproxy-mcp",
              tool: "inspect_flow_v2",
              args: { flow_id: id }
            });
            const compatibleDetail = proxyFlowDetailFromMcpInspect(compatibleResult);
            if (compatibleDetail) return compatibleDetail;
          } catch {
          }
          const legacyResult = await callMcpServerTool({
            workspace: session.workspace,
            configWorkspace: runtime.workspace,
            session,
            server: "mitmproxy-mcp",
            tool: "inspect_flow",
            args: { flow_id: id, full_body: false }
          });
          const legacyDetail = proxyFlowDetailFromMcpInspect(legacyResult);
          if (legacyDetail) return legacyDetail;
        } catch {
        }
      }
      const services = serviceRegistry.list().filter((service) => service.kind === "mitmproxy" && (!activeSessionId || service.sessionId === activeSessionId));
      for (const service of services) {
        const flowJsonl = typeof service.metadata?.flowJsonl === "string" ? service.metadata.flowJsonl : undefined;
        if (!flowJsonl) continue;
        const detail = await readProxyFlowDetail(flowJsonl, id);
        if (detail) return detail;
      }
      return undefined;
    },
    async listAvailableModels() {
      return modelChoicesFromCatalog(await buildModelCatalog(runtime.workspace, loadModelProfiles(runtime.workspace)));
    },
    async loadModelCatalog() {
      const catalog = await buildModelCatalog(runtime.workspace, loadModelProfiles(runtime.workspace));
      return {
        providers: await listModelProviders(runtime.workspace, catalog),
        models: modelChoicesFromCatalog(catalog)
      };
    },
    async probeModelProvider(input, signal) {
      return probeModelProvider(runtime.workspace, input, signal);
    },
    async saveModelProvider(input) {
      saveModelProvider(runtime.workspace, input);
      const catalog = await buildModelCatalog(runtime.workspace, loadModelProfiles(runtime.workspace));
      enqueue({ type: "sessions.changed" });
      return {
        providers: await listModelProviders(runtime.workspace, catalog),
        models: modelChoicesFromCatalog(catalog)
      };
    },
    async removeModelProvider(providerID) {
      const removed = removeModelProvider(runtime.workspace, providerID);
      const catalog = await buildModelCatalog(runtime.workspace, loadModelProfiles(runtime.workspace));
      const choices = modelChoicesFromCatalog(catalog);
      const validModels = new Set(choices.map((choice) => choice.model));
      const fallbackModel = choices.find((choice) => choice.verified)?.model ?? choices[0]?.model ?? HEURISTIC_MODEL_ID;
      let updatedSessions = 0;
      for (const session of store.listSessions(100_000, { includeArchived: true })) {
        if (!modelSelectionNeedsFallback(session.model, providerID, validModels)) continue;
        runtime.updateSession(session.id, { model: fallbackModel });
        updatedSessions += 1;
      }
      enqueue({ type: "sessions.changed" });
      if (activeSessionId && updatedSessions > 0) enqueue({ type: "snapshot.changed", sessionId: activeSessionId });
      return { ...removed, fallbackModel, updatedSessions };
    },
    async refreshMcp() {
      if (!activeSessionId) return;
      const session = runtime.loadSession(activeSessionId);
      await runtime.refreshMcp(session);
    },
    async listMcpStatuses() {
      return listMcpServerStatuses(activeSessionId);
    },
    async startContainer() {
      if (!activeSessionId) throw new Error("no active session to start a container for.");
      await runtime.startContainer(activeSessionId);
    },
    async stopContainer() {
      if (!activeSessionId) throw new Error("no active session to stop a container for.");
      await runtime.stopContainer(activeSessionId);
    },
    async loadSnapshot(sessionId) { return readSnapshot(sessionId); },
    async loadActivityState(sessionId) {
      return {
        backgroundActivities: summarizeBackgroundActivities(store, sessionId),
        browserContexts: browserContextManager.list(sessionId),
        subagents: summarizeSubagents(store, sessionId),
        pendingSteers: runtime.listPendingSteeringInputs(sessionId),
        queuedPrompts: runtime.listQueuedFollowupInputs(sessionId)
      };
    },
    async prompt(sessionId, input) {
      const session = runtime.loadSession(sessionId);
      try {
        return await runtime.prompt(session, input);
      } finally {
        flush();
      }
    },
    queueInput(sessionId, input) { return runtime.queueUserInput(sessionId, input); },
    takeBackQueuedInput(sessionId) { return runtime.takeBackQueuedUserInput(sessionId); },
    async inspectContext(sessionId, hypotheticalInput) {
      return runtime.inspectContext(runtime.loadSession(sessionId), hypotheticalInput);
    },
    steer(sessionId, input) {
      return runtime.injectUserInput(sessionId, input);
    },
    async compact(sessionId, instructions) {
      const session = runtime.loadSession(sessionId);
      return runtime.compactSession(session, instructions);
    },
    cancelCompaction(sessionId) { runtime.cancelCompaction(sessionId); },
    async clearSession(sessionId) {
      const cleared = await runtime.clearSession(sessionId);
      if (activeSessionId === sessionId) {
        seedTurnCache(sessionId);
        if (usePush) subscribeStore(sessionId, 0);
        else eventCursor = 0;
      }
      return cleared;
    },
    async loadFullMessages(sessionId) { return store.listMessages(sessionId, 1000); },
    async cancelTurn(turnId, reason) { return runtime.cancelTurn(turnId, reason); },
    setActiveSession(sessionId) {
      if (sessionId === activeSessionId) return;
      unsubscribeBrowserContexts?.();
      unsubscribeBrowserContexts = undefined;
      activeSessionId = sessionId;
      if (sessionId) {
        unsubscribeBrowserContexts = browserContextManager.subscribe(sessionId, () => {
          enqueue({ type: "snapshot.changed", sessionId });
        });
      }
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const event = pending[index]!;
        if (event.type !== "sessions.changed" && event.sessionId !== sessionId) pending.splice(index, 1);
      }
      if (usePush) {
        if (sessionId) {
          seedTurnCache(sessionId);
          subscribeStore(sessionId);
        } else {
          unsubscribeStore?.(); unsubscribeStore = undefined;
          eventSubscription?.close(); eventSubscription = undefined;
        }
      } else {
        stopFallback();
        if (sessionId) {
          seedTurnCache(sessionId);
          eventCursor = store.latestEventSequence(sessionId);
          startFallback();
        }
      }
    },
    getRunningTurnId(sessionId) {
      if (activeSessionId === sessionId && cachedRunningTurnId) return cachedRunningTurnId;
      try {
        const turns = store.listTurns(sessionId, 5);
        return turns.find((t) => isRunning(t.status))?.id;
      } catch { return undefined; }
    },
    event: {
      on(cb) { listeners.add(cb); return () => listeners.delete(cb); }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeStore?.(); unsubscribeStore = undefined;
      unsubscribeBrowserContexts?.(); unsubscribeBrowserContexts = undefined;
      eventSubscription?.close(); eventSubscription = undefined;
      stopFallback();
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      listeners.clear();
      pending.length = 0;
      await runtime.shutdown();
    }
  };
}

function transientStreamIdentity(event: TuiEvent): string | undefined {
  if (event.type !== "event.appended") return undefined;
  if (event.event.type !== "stream_text" && event.event.type !== "stream_reasoning") return undefined;
  const payload = event.event.payload as { turnId?: unknown; partId?: unknown } | undefined;
  if (typeof payload?.turnId !== "string" || typeof payload.partId !== "string") return undefined;
  return `${event.sessionId}:${payload.turnId}:${event.event.type}:${payload.partId}`;
}

function storeChangeIdentity(change: StoreChange): string {
  switch (change.kind) {
    case "part": return `part:${change.part.id}`;
    case "message": return `message:${change.message.id}`;
    case "toolCall": return `toolCall:${change.toolCall.id}`;
    case "evidence": return `evidence:${change.evidence.id}`;
    case "finding": return `finding:${change.finding.id}`;
    case "memory": return `memory:${change.item.id}`;
    case "todo": return `todo:${change.todo.id}`;
    case "note": return `note:${change.note.id}`;
    case "job": return `job:${change.job.id}`;
    case "turn": return `turn:${change.turn.id}`;
    case "session": return `session:${change.session.id}`;
    case "event":
    case "transientEvent":
      return `${change.kind}:${change.event.id}`;
  }
}

const ACTIVE_BACKGROUND_JOB_STATUSES = new Set<BackgroundJob["status"]>(["created", "starting", "running", "cancelling"]);

function summarizeBackgroundActivities(store: SqliteStore, sessionId: string): BackgroundActivitySummary[] {
  const counts = new Map<string, number>();
  for (const job of store.listJobs(sessionId, 10_000)) {
    if (!ACTIVE_BACKGROUND_JOB_STATUSES.has(job.status)) continue;
    if (job.kind === "agent") continue;
    const label = backgroundActivityLabel(store, job);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, count]) => ({ id: label, label, count }));
}

export function subagentActivityFromJob(job: BackgroundJob): SubagentActivity | undefined {
  if (job.kind !== "agent" || !job.childSessionId) return undefined;
  const summary = agentResultSummary(job.result);
  return {
    id: job.id,
    childSessionId: job.childSessionId,
    title: job.title?.trim() || job.lane?.trim() || "subagent task",
    ...(job.lane ? { lane: job.lane } : {}),
    mode: job.agentMode ?? "detached",
    status: job.status,
    ...(summary ? { summary } : {}),
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    updatedAt: job.updatedAt
  };
}

function summarizeSubagents(store: SqliteStore, sessionId: string): SubagentActivity[] {
  return store.listJobs(sessionId, 100)
    .map(subagentActivityFromJob)
    .filter((item): item is SubagentActivity => Boolean(item))
    .map((item) => {
      try {
        const child = store.loadSession(item.childSessionId);
        return {
          ...item,
          title: sessionDisplayName(child),
          ...(child.model ? { model: child.model } : {})
        };
      } catch {
        return item;
      }
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function summarizeAgentThreads(store: SqliteStore, sessionId: string): AgentThreadSummary[] {
  const rootSessionId = agentRootSessionId(store, sessionId);
  const root = store.loadSession(rootSessionId);
  const rootRunning = store.listTurns(root.id, 10).find((turn) => isRunning(turn.status));
  const threads: AgentThreadSummary[] = [{
    id: root.id,
    sessionId: root.id,
    role: "main",
    depth: 0,
    title: sessionDisplayName(root),
    mode: "attached",
    status: rootRunning ? "running" : "idle",
    ...(root.model ? { model: root.model } : {}),
    createdAt: root.createdAt,
    ...(rootRunning ? { startedAt: rootRunning.createdAt } : {}),
    updatedAt: root.updatedAt
  }];
  const pending: Array<{ sessionId: string; depth: number }> = [{ sessionId: root.id, depth: 1 }];
  const visited = new Set<string>([root.id]);
  while (pending.length > 0) {
    const parent = pending.shift()!;
    const latestByChild = new Map<string, BackgroundJob>();
    for (const job of store.listJobs(parent.sessionId, 10_000)) {
      if (job.kind !== "agent" || !job.childSessionId || latestByChild.has(job.childSessionId)) continue;
      latestByChild.set(job.childSessionId, job);
    }
    const jobs = [...latestByChild.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const job of jobs) {
      const childSessionId = job.childSessionId!;
      if (visited.has(childSessionId)) continue;
      visited.add(childSessionId);
      let child: Session;
      try {
        child = store.loadSession(childSessionId);
      } catch {
        continue;
      }
      const activity = subagentActivityFromJob(job)!;
      threads.push({
        id: child.id,
        sessionId: child.id,
        parentSessionId: parent.sessionId,
        role: "subagent",
        depth: parent.depth,
        title: sessionDisplayName(child),
        ...(activity.lane ? { lane: activity.lane } : {}),
        mode: activity.mode,
        status: activity.status,
        ...(child.model ? { model: child.model } : activity.model ? { model: activity.model } : {}),
        ...(activity.summary ? { summary: activity.summary } : {}),
        ...(activity.error ? { error: activity.error } : {}),
        createdAt: activity.createdAt,
        ...(activity.startedAt ? { startedAt: activity.startedAt } : {}),
        ...(activity.completedAt ? { completedAt: activity.completedAt } : {}),
        updatedAt: activity.updatedAt
      });
      pending.push({ sessionId: child.id, depth: parent.depth + 1 });
    }
  }
  return threads;
}

function agentRootSessionId(store: SqliteStore, sessionId: string): string {
  let current = sessionId;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const owner = store.findAgentJobByChildSessionId(current);
    if (!owner) return current;
    current = owner.sessionId;
  }
  return sessionId;
}

function agentResultSummary(result: unknown): string | undefined {
  if (typeof result === "string") return result.trim() || undefined;
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const record = result as Record<string, unknown>;
  const value = typeof record.response === "string"
    ? record.response
    : typeof record.output === "string"
      ? record.output
      : undefined;
  if (!value?.trim()) return undefined;
  return value.trim().slice(0, 1_200);
}

function backgroundActivityLabel(store: SqliteStore, job: BackgroundJob): string {
  if (job.kind === "agent") return "agent";
  if (job.toolCallId) {
    try {
      const namespace = store.loadToolCall(job.toolCallId).tool.split(/[._]/, 1)[0]?.trim().toLowerCase();
      if (namespace) return namespace;
    } catch {  }
  }
  return job.backendKind?.trim().toLowerCase() || "process";
}

export function modelSelectionNeedsFallback(
  selection: string | undefined,
  providerID: string,
  validModels: ReadonlySet<string>
): boolean {
  const usesProvider = selection === providerID || selection?.startsWith(`${providerID}:`) === true;
  return usesProvider && (!selection || !validModels.has(selection));
}
