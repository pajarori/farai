import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { AgentLifecycleEntry, AgentPromptResult, BackgroundJob, Message, MessageWithParts, Note, PendingSteerInput, PendingUserInput, QueuedUserInput, Session, SessionEvent, SessionMailboxItem, ToolCallRecord, ToolContext, ToolDefinition, ToolResult, Turn, UserInputAnswer, UserInputRequest } from "../types";
import { SqliteStore } from "../agent-store/sqlite-store";
import { getTool, listToolsForSession, refreshMcpTools } from "../agent-tools/registry";
import { formatMcpInventory, getMcpPrompt, getMcpPromptDescriptor, listMcpServerStatuses, probeMcpServer as probeMcpServerConfig, renderMcpPromptResult, renderMcpServerInstructionContext, requestMcpFormElicitation, startMcpServer, stopMcpServer, stopMcpToolsForSession, type McpRefreshInput, type McpServerProbeResult, type McpServerRuntimeStatus } from "../agent-tools/mcp-manager";
import { mcpServerFromInput, type SaveMcpServerInput } from "./mcp-server-management";
import { stopBrowserContextsForSession } from "../agent-tools/browser/context-manager";
import { disposableInboxManager, stopDisposableInboxesForSession } from "../agent-email/tempmail";
import { renderCtfNotes } from "../agent-report/markdown";
import { serviceRegistry } from "../agent-tools/services/registry";
import { containerNameForSession, KaliContainerBackend, type ContainerStatus } from "../agent-container/kali";
import { DockerContainerLifecycle, type ContainerLifecyclePort } from "../agent-container/lifecycle";
import type { ToolExecutionBackend } from "../agent-tools/shared/backend";
import { id, nowIso } from "../utils";
import { takeBytes } from "../agent-tools/shared/output-bound";
import { runCapturedProcess } from "../agent-tools/backends/captured-process";
import { INTERNAL_PROCESS_OUTPUT_MAX_BYTES } from "../agent-tools/backends/output-buffer";
import { renderModelToolResultEnvelope } from "./context-builder";
import { sanitizeToolOutput } from "../agent-tools/shared/output-sanitize";
import { buildChatRequest, ChatProviderPlanner, createChatProviderForSession, createPlannerForSessionAsync, PlannerHttpError, type ConversationEntry, type PlanStreamEvent, type PlannerAction, type PlannerInput, type PlannerProvider } from "./provider";
import type { ChatProvider, ProviderToolDef } from "./provider/protocol";
import { BoundedTextAccumulator, PROVIDER_TOOL_PREVIEW_MAX_BYTES, providerResponseLimits, utf8Prefix } from "./provider/stream-bounds";
import { buildSystemPrompt } from "./provider/system-prompt";
import { resolveContextWindow, resolveMaxOutputTokens, resolveMaxSteps, resolveMaxTurnMs } from "./model-registry";
import { defaultModelSelection } from "./model-catalog";
import { sessionManager } from "../agent-tools/shared/session-manager";
import { oastEvidenceForSession, parseOastEvents } from "../agent-tools/callback/oast-parser";
import { activeBackgroundJobs, processIdFromArgs, renderBackgroundJobs, stableValue, type ActiveBackgroundJob } from "./loop/background";
import { isDefaultSessionTitle, sessionDisplayName, titleFromPrompt } from "../session-title";
import { nonEmpty } from "./loop/history";
import { AUTO_COMPACT_MAX_FAILURES, MANUAL_COMPACT_MIN_TOKENS, autoCompactThreshold, estimateTokens, runModelCompaction } from "./loop/compaction";
import { loadHooks, runHooks, type HookRunner } from "./hooks/host";
import type { HookDefinition, HookEvent } from "./hooks/types";
import { callMcpServerTool } from "./../agent-tools/mcp-manager";
import type { PlannerContextBlock } from "./context-builder";
import { resolveLane } from "./subagents/lanes";
import { buildSubagentTaskPrompt, hasSharedWorkspaceEdits, resolveSubagentToolScope } from "./subagents/scope";
import { SubagentGate } from "./subagents/gate";
import { SessionActor } from "./session-actor";
import { SessionMailbox } from "./session-mailbox";
import { mailboxInputText, queuedInputAction, SessionInputQueue, type QueuedInputAction } from "./session-input-queue";
import { SessionMailboxDispatcher } from "./session-mailbox-dispatcher";
import { JobManager } from "./jobs/manager";
import { ContextEngine, formatContextManifest, type ContextManifest, type ContextProjection, type ContextRequest } from "./context-engine";
import { FileStateCache } from "./file-state";
import { projectConversationHistory } from "./history-projection";
import { loadConfig, type FaraiConfig } from "./config";
import { canonicalToolName } from "../tool-names";
import { LspManager } from "../agent-lsp";
import { BACKGROUND_MAILBOX_BATCH_SIZE, backgroundCompletionArtifact, renderMailboxItems } from "./mailbox-render";
import { browserObservationSignature } from "../agent-tools/browser/observation";
import { classifyModelRetry, MODEL_RETRY_MAX_ATTEMPTS, modelRetryDelayMs } from "./provider/retry";
import { isInternalMetaReasoning, normalizeReasoningSummary } from "./reasoning-summary";
import { KnowledgeStore } from "../agent-knowledge/store";
import { knowledgeDbPath } from "../agent-knowledge/paths";
import { calculateUsageCost, estimateMaximumRequestCost, normalizeUsageTokenCounts, type UsageTokenCounts } from "./model-pricing";
import { recordSessionLocation, removeSessionLocation } from "../session-catalog";
import { SessionUserInputCoordinator } from "./session-user-input";
import { resolveMcpPromptArguments } from "./mcp-prompts";
import {
  abortablePromise,
  leasedToolCapability,
  ToolDeadlineError,
  ToolExecutionDeadline,
  ToolExecutionGate,
  ToolExecutionLease,
  toolConcurrencyKey,
  toolForExecution,
  toolOperationTimeout
} from "./tool-execution-control";
import { validateToolArgs } from "./tool-input-validation";
import { normalizeToolResult } from "./tool-result-normalization";
import { atomicWriteFile } from "./atomic-file";
import { ToolCallJournal, type ToolErrorState } from "./tool-call-journal";

export { activeBackgroundJobs } from "./loop/background";
export type { ActiveBackgroundJob } from "./loop/background";

const REASONING_MAX_BYTES = 8 * 1024;
const STREAM_PERSIST_INTERVAL_MS = 2_000;
const LIVE_OUTPUT_MAX_BYTES = 2 * 1024;
const LIVE_OUTPUT_FLUSH_INTERVAL_MS = 150;
const LIVE_OUTPUT_INITIAL_DELAY_MS = 320;
const TOOL_HUMAN_RESULT_MAX_BYTES = 24 * 1024;
const LOOP_SUPERVISION_NO_PROGRESS_STEPS = 12;
const LOOP_SUPERVISION_STEER_INTERVAL = 5;
const LOOP_PATTERN_MAX_PERIOD = 8;
const PROGRESS_ACTION_TOOLS = new Set(["http_request", "subdomain_enum", "dir_enum", "port_scan", "nmap_scan", "fs_edit", "fs_write", "patch_apply", "code_write_script", "campaign_verify", "campaign_test", "callback_oast", "exploit_search"]);
const AUTO_COMPACTION_CONTINUATION = "[internal continuation after context compaction: Continue the active user task from the compacted prior context. Do not repeat, regenerate, or explain the summary. Resume with the exact next useful action.]";
const WRAPUP_MODEL_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_GRACE_PERIOD_MS = 2_000;
const SHUTDOWN_OPERATION_TIMEOUT_MS = 1_500;
const RUNTIME_LEASE_MS = 60_000;
const RUNTIME_HEARTBEAT_MS = 15_000;
const RESTART_TOOL_ERROR = "Interrupted by runtime restart; tool execution was not replayed.";
const STEP_LIMIT_WRAPUP_DIRECTIVE = "You have reached the maximum number of steps allowed for this turn, so tools are no longer available. Do not attempt to call any tool. In a few sentences, summarize what you accomplished, the key findings or evidence so far, any blockers, and the single most useful next step. This is your final message for this turn.";
const TIME_LIMIT_WRAPUP_DIRECTIVE = "You have reached the interactive wall-clock budget for this turn, so tools are no longer available. Do not attempt to call any tool. Concisely summarize completed work, proven evidence, active background jobs, remaining uncertainty, and the single best next action. This is your final message for this turn.";

function assertProviderToolIndex(index: number, max: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= max) throw new Error(`provider tool call index must be between 0 and ${max - 1}`);
}

const INTERNAL_META_STREAM_PREFIXES = [
  "the user",
  "user asked",
  "user wants",
  "user requested",
  "user said",
  "per my",
  "per the",
  "my communication",
  "my instruction",
  "my instructions",
  "my rules",
  "my task",
  "according to my",
  "according to the",
  "there's no dedicated tool",
  "there is no dedicated tool",
  "there's no specific tool",
  "there is no specific tool",
  "there's no matching tool",
  "there is no matching tool",
  "i have access to",
  "let me inspect the available tool",
  "let me check the available tool",
  "let me search the available tool",
  "i should report",
  "i will report",
  "i need to report",
  "i must report",
  "i can report",
  "we should report",
  "we will report",
  "we need to report",
  "we must report",
  "we can report"
] as const;

type ToolPlannerAction = Extract<PlannerAction, { kind: "tool" }>;
type ToolActionOutcome = { shouldContinue: boolean; resetAutoContinue?: boolean; cancelled?: boolean };
type StepControl = { cancelled?: boolean; timedOut?: boolean; empty?: boolean; shouldContinue: boolean };
type ProviderSlot = { contextMessage: Message; assistantMessage: Message };
type ProviderCatalogPayload = { key: string; tools: ProviderToolDef[] };
type StreamingPartsState = {
  textPartId?: string;
  textAccum: string;
  lastTextPersist?: number;
  reasoningPartId?: string;
  reasoningAccum?: string;
  lastReasoningPersist?: number;
};
type RenderedToolResult = { result: ToolResult; humanResult: string; modelResult: string };

function shouldBufferInitialTextStream(text: string): boolean {
  if (isInternalMetaReasoning(text)) return true;
  if (text.includes("\n")) return false;
  const normalized = text.trimStart().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return false;
  return INTERNAL_META_STREAM_PREFIXES.some((prefix) => prefix.startsWith(normalized));
}

class IneffectiveCompactionError extends Error {
  constructor(readonly preTokens: number, readonly postTokens: number) {
    super(`compaction did not reduce active context: ${preTokens} -> ${postTokens} estimated tokens`);
    this.name = "IneffectiveCompactionError";
  }
}

class ModelCallDeadlineError extends Error {
  constructor() {
    super("model call exceeded the turn deadline");
    this.name = "ModelCallDeadlineError";
  }
}

export type SessionPatch = Partial<Pick<Session, "title" | "provider" | "model" | "phase" | "campaignId" | "toolScope" | "workspace">> & {
  emailPrimaryId?: string | null;
  emailSecondaryId?: string | null;
};
export type ShutdownOptions = { gracePeriodMs?: number };
type RuntimeContainerBackend = Pick<KaliContainerBackend, "status" | "startPersistent" | "stopPersistent">;
export type AgentRuntimeOptions = {
  maxSteps?: number;
  maxTurnSeconds?: number;
  maxCostUsd?: number;
  maxConcurrentSubagents?: number;
  maxInputTokens?: number;
  inheritConfig?: boolean;
  enableKnowledge?: boolean;
  enableSkills?: boolean;
  enableHooks?: boolean;
  enableMcp?: boolean;
  enableProjectInstructions?: boolean;
  executionBackend?: ToolExecutionBackend;
  registerSessionCatalog?: boolean;
  containerBackendFactory?: (workspace: string, sessionId: string, timeoutMs?: number) => RuntimeContainerBackend;
  containerLifecycle?: ContainerLifecyclePort;
};
type PromptOptions = { signal?: AbortSignal };

export class AgentRuntime {
  readonly store: SqliteStore;
  readonly planner: PlannerProvider | undefined;
  private readonly chatProviderOverride: ChatProvider | undefined;
  private readonly turnControllers = new Map<string, AbortController[]>();
  private readonly activeToolControllers = new Set<AbortController>();
  private readonly activeToolLeases = new Set<ToolExecutionLease>();
  private readonly subagentControllers = new Map<string, AbortController>();
  private readonly shutdownController = new AbortController();
  private readonly actors = new Map<string, SessionActor>();
  private readonly steeringWaiters = new Map<string, Set<() => void>>();
  private readonly modelCallsByTurn = new Map<string, number>();
  private readonly providerCatalogs = new Map<string, ProviderToolDef[]>();
  private readonly streamingParts = new Map<string, StreamingPartsState>();
  private readonly toolInputPreviews = new Map<string, { id?: string; name: string; arguments: string; bytes: number; truncated: boolean }>();
  private readonly toolExecutionGate = new ToolExecutionGate();
  private readonly workspaceBindingGate = new ToolExecutionGate();
  private readonly subagentGate: SubagentGate;
  private readonly subagentWorkspaceMutationGate = new SubagentGate(1);
  private readonly pendingSteeringContext = new Map<string, string[]>();
  private readonly userInputs: SessionUserInputCoordinator;
  private readonly toolCalls: ToolCallJournal;
  private hooks: HookDefinition[] | undefined;
  private readonly firedSessionStart = new Set<string>();
  private readonly pendingHookContext = new Map<string, string[]>();
  private readonly resourceSessionIds = new Set<string>();
  private readonly autoCompactFailures = new Map<string, number>();
  private readonly compactionControllers = new Map<string, AbortController>();
  private readonly runtimeId = id();
  private readonly mailbox: SessionMailbox;
  private readonly inputQueue: SessionInputQueue;
  private readonly mailboxDispatcher: SessionMailboxDispatcher;
  private readonly jobs: JobManager;
  private readonly fileState = new FileStateCache();
  private readonly lsp: LspManager;
  private readonly contextEngine: ContextEngine;
  private readonly maxSteps: number;
  private readonly maxTurnMs: number;
  private readonly maxCostUsd: number | undefined;
  private readonly maxInputTokens: number | undefined;
  private readonly inheritConfig: boolean;
  private readonly knowledgeEnabled: boolean;
  private readonly hooksEnabled: boolean;
  private readonly mcpEnabled: boolean;
  private readonly executionBackend: ToolExecutionBackend | undefined;
  private readonly containerLifecycle: ContainerLifecyclePort | undefined;
  private readonly containerBackendFactory: (workspace: string, sessionId: string, timeoutMs?: number) => RuntimeContainerBackend;
  private readonly registerSessionCatalog: boolean;
  private knowledgeStore: KnowledgeStore | null | undefined;
  private recovered = false;
  private recoveryPromise: Promise<void> | undefined;
  private runtimeHeartbeat: ReturnType<typeof setInterval> | undefined;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;
  private shutdownFinalizationPromise: Promise<void> | undefined;

  constructor(readonly workspace: string, plannerOrProvider?: PlannerProvider | ChatProvider, options: AgentRuntimeOptions = {}) {
    this.inheritConfig = options.inheritConfig !== false;
    const config: FaraiConfig = this.inheritConfig ? loadConfig(workspace) : {};
    this.store = new SqliteStore(join(workspace, ".farai"));
    this.toolCalls = new ToolCallJournal(this.store, (sessionId, type, payload) => this.event(sessionId, type, payload));
    this.knowledgeEnabled = options.enableKnowledge !== false;
    this.hooksEnabled = options.enableHooks !== false;
    this.mcpEnabled = options.enableMcp !== false;
    this.executionBackend = options.executionBackend;
    this.containerLifecycle = options.containerLifecycle ?? (options.executionBackend || options.containerBackendFactory ? undefined : new DockerContainerLifecycle(this.runtimeId));
    this.containerBackendFactory = options.containerBackendFactory ?? ((containerWorkspace, rootSessionId, timeoutMs) => new KaliContainerBackend({
      workspace: containerWorkspace,
      rootWorkspace: this.workspace,
      rootSessionId,
      containerName: containerNameForSession(rootSessionId),
      ...(this.containerLifecycle ? { lifecycle: this.containerLifecycle } : {}),
      ...(timeoutMs ? { timeoutMs } : {})
    }));
    this.registerSessionCatalog = options.registerSessionCatalog !== false;
    this.contextEngine = new ContextEngine(workspace, this.store, this.fileState, () => this.knowledge(), options.enableSkills !== false, options.enableProjectInstructions !== false);
    this.lsp = new LspManager(workspace, config.lsp, {
      backendFactory: (sessionId, sessionWorkspace) => this.executionBackend instanceof KaliContainerBackend
        ? this.executionBackend
        : this.containerBackend(sessionWorkspace, sessionId) as KaliContainerBackend
    });
    this.subagentGate = new SubagentGate(options.maxConcurrentSubagents ?? config.maxConcurrentSubagents ?? 4);
    this.maxSteps = resolveMaxSteps(options.maxSteps ?? config.maxSteps);
    this.maxTurnMs = resolveMaxTurnMs(options.maxTurnSeconds ?? config.maxTurnSeconds);
    this.maxCostUsd = positiveFinite(options.maxCostUsd ?? config.maxCostUsd);
    this.maxInputTokens = positiveFinite(options.maxInputTokens);
    this.mailbox = new SessionMailbox(this.store, this.runtimeId);
    this.inputQueue = new SessionInputQueue(this.mailbox, (sessionId, type, payload) => this.event(sessionId, type, payload));
    this.userInputs = new SessionUserInputCoordinator({
      emitControl: (sessionId, payload) => this.event(sessionId, "control", payload),
      queueRecoveredAnswer: (sessionId, text, requestId) => this.queueRecoveredUserInput(sessionId, text, requestId)
    });
    this.mailboxDispatcher = new SessionMailboxDispatcher(this.mailbox, this.inputQueue, {
      runExclusive: (sessionId, work) => this.actor(sessionId).run(work),
      runPrompt: async (sessionId, text, promptOptions) => {
        await this.runPrompt(this.store.loadSession(sessionId), text, promptOptions);
      },
      clearSession: async (sessionId) => {
        this.cancelCompaction(sessionId);
        await this.cancelSessionJobs(sessionId);
        this.clearSessionState(sessionId);
      },
      emitConsumed: (sessionId, item, inputMode) => this.event(sessionId, "mailbox_consumed", {
        mailboxId: item.id,
        sequence: item.sequence,
        ...(inputMode ? { inputMode } : {})
      }),
      isShuttingDown: () => this.shuttingDown,
      isRecovered: () => this.recovered,
      isStoreOpen: () => this.store.isOpen()
    });
    this.jobs = new JobManager(this.runtimeId, this.store, sessionManager, (item, job) => {
      void this.recordJobCompletion(item, job);
    });
    if (plannerOrProvider && "stream" in plannerOrProvider) this.chatProviderOverride = plannerOrProvider;
    else this.planner = plannerOrProvider;
  }

  private knowledge(): KnowledgeStore | undefined {
    if (!this.knowledgeEnabled) return undefined;
    if (this.knowledgeStore === undefined) this.knowledgeStore = KnowledgeStore.openIfExists(knowledgeDbPath()) ?? null;
    return this.knowledgeStore ?? undefined;
  }

  async shutdown(options: ShutdownOptions = {}): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const shutdownSessionIds = new Set([...this.resourceSessionIds, ...this.actors.keys()]);
    this.shuttingDown = true;
    for (const actor of this.actors.values()) actor.close();
    this.shutdownController.abort("runtime shutdown");
    for (const controller of this.compactionControllers.values()) controller.abort("runtime shutdown");
    this.compactionControllers.clear();
    for (const controllers of this.turnControllers.values()) {
      for (const controller of controllers) controller.abort("runtime shutdown");
    }
    this.turnControllers.clear();
    for (const waiters of this.steeringWaiters.values()) for (const wake of waiters) wake();
    this.steeringWaiters.clear();
    for (const controller of this.activeToolControllers) controller.abort("runtime shutdown");
    this.userInputs.rejectAll(new Error("runtime shutdown"));
    for (const controller of this.subagentControllers.values()) controller.abort("runtime shutdown");
    const drain = Promise.allSettled([
      ...[...this.actors.values()].map((actor) => actor.idle()),
      this.workspaceBindingGate.idle(),
      this.toolExecutionGate.idle(),
      this.subagentGate.idle(),
      this.subagentWorkspaceMutationGate.idle(),
      ...(this.recoveryPromise ? [this.recoveryPromise] : [])
    ]);
    this.shutdownFinalizationPromise = (async () => {
      const failures: Error[] = [];
      const attempt = async (label: string, operation: () => Promise<unknown> | unknown): Promise<void> => {
        try {
          await withDeadlineMs(Promise.resolve().then(operation), SHUTDOWN_OPERATION_TIMEOUT_MS, label);
        } catch (error) {
          failures.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
        }
      };
      try {
        await drain;
        this.activeToolControllers.clear();
        this.activeToolLeases.clear();
        this.subagentControllers.clear();
        this.actors.clear();
        await attempt("lsp shutdown", () => this.lsp.shutdown());
        let ownedJobs: BackgroundJob[] = [];
        if (this.store.isOpen()) {
          await attempt("background job discovery", () => {
            ownedJobs = this.store.listJobsByRuntime(this.runtimeId)
              .filter((job) => !["succeeded", "failed", "cancelled", "lost"].includes(job.status));
          });
          for (const job of ownedJobs) {
            shutdownSessionIds.add(job.sessionId);
            if (job.childSessionId) shutdownSessionIds.add(job.childSessionId);
          }
          await Promise.all(ownedJobs.map((job) => attempt(`background job ${job.id} shutdown`, () => this.jobs.cancel(job.id, false))));
        }
        if (this.store.isOpen()) {
          await Promise.all([...shutdownSessionIds].map(async (sessionId) => {
            await Promise.all([
              attempt(`browser session ${sessionId} shutdown`, () => stopBrowserContextsForSession(sessionId)),
              attempt(`email session ${sessionId} shutdown`, () => this.stopSessionEmail(sessionId)),
              attempt(`mcp session ${sessionId} shutdown`, () => stopMcpToolsForSession(sessionId))
            ]);
            await attempt(`service session ${sessionId} unregister`, () => serviceRegistry.unregisterSession(sessionId));
          }));
        }
        this.resourceSessionIds.clear();
        await attempt("container shutdown", () => this.containerLifecycle?.suspendAll());
      } finally {
        this.stopRuntimeLease();
        await attempt("container lifecycle disposal", () => this.containerLifecycle?.dispose());
        await attempt("knowledge store shutdown", () => this.knowledgeStore?.close());
        this.knowledgeStore = null;
        await attempt("session store shutdown", () => this.store.close());
      }
      if (failures.length) throw new AggregateError(failures, "runtime shutdown completed with cleanup failures");
    })();
    void this.shutdownFinalizationPromise.catch(() => undefined);
    this.shutdownPromise = (async () => {
      const completed = await waitForShutdownFinalization(
        this.shutdownFinalizationPromise!,
        shutdownGracePeriod(options.gracePeriodMs)
      );
      if (!completed) {
        for (const lease of this.activeToolLeases) lease.revoke("runtime shutdown grace period expired");
      }
    })();
    return this.shutdownPromise;
  }

  private assertAcceptingWork(): void {
    if (this.shuttingDown) throw new Error("Farai runtime is shutting down");
  }

  pendingUserInput(sessionId: string): PendingUserInput | undefined {
    return this.userInputs.get(sessionId);
  }

  answerUserInput(sessionId: string, raw: string): UserInputAnswer {
    return this.userInputs.answer(sessionId, raw);
  }

  answerUserInputStructured(sessionId: string, answer: UserInputAnswer): UserInputAnswer {
    return this.userInputs.answerStructured(sessionId, answer);
  }

  cancelUserInput(sessionId: string): PendingUserInput {
    return this.userInputs.cancel(sessionId);
  }

  private requestUserInput(session: Session, input: UserInputRequest, signal?: AbortSignal): Promise<UserInputAnswer> {
    return this.userInputs.request(session.id, input, signal);
  }

  private mcpCallbacks(session: Session): Pick<McpRefreshInput, "onCatalogChange" | "handleElicitation"> {
    this.resourceSessionIds.add(session.id);
    return {
      onCatalogChange: (event) => this.event(session.id, "mcp_catalog_changed", event),
      handleElicitation: (server, request, signal) => requestMcpFormElicitation(
        server,
        request,
        (input, inputSignal) => this.requestUserInput(session, input, inputSignal),
        signal
      )
    };
  }

  private startRuntimeLease(): void {
    this.store.renewRuntimeLease(this.runtimeId, RUNTIME_LEASE_MS);
    this.containerLifecycle?.renew();
    if (this.runtimeHeartbeat) return;
    this.runtimeHeartbeat = setInterval(() => {
      if (this.shuttingDown || !this.store.isOpen()) return;
      try { this.store.renewRuntimeLease(this.runtimeId, RUNTIME_LEASE_MS); } catch {
      }
      try { this.containerLifecycle?.renew(); } catch {
      }
    }, RUNTIME_HEARTBEAT_MS);
    if (typeof this.runtimeHeartbeat === "object" && "unref" in this.runtimeHeartbeat) this.runtimeHeartbeat.unref();
  }

  private stopRuntimeLease(): void {
    if (this.runtimeHeartbeat) {
      clearInterval(this.runtimeHeartbeat);
      this.runtimeHeartbeat = undefined;
    }
    if (this.store.isOpen()) {
      try { this.store.releaseRuntimeLease(this.runtimeId); } catch {
      }
    }
  }

  async recover(): Promise<void> {
    if (this.recovered) return;
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = (async () => {
      await this.store.ensure();
      this.startRuntimeLease();
      void this.containerLifecycle?.reconcile().catch(() => undefined);
      const activeRuntimeIds = new Set(this.store.listActiveRuntimeIds());
      if (activeRuntimeIds.size === 1 && activeRuntimeIds.has(this.runtimeId)) {
        this.store.pruneOrphanedToolAttachments();
        this.store.pruneOrphanedDurableFiles();
      }
      this.store.reclaimMailboxClaims([...activeRuntimeIds]);
      const sessions = this.store.listSessions(10_000, { includeArchived: true });
      for (const session of sessions) {
        const turns = this.store.listTurns(session.id, 10_000);
        const newlyInterruptedTurns = new Set(turns
          .filter((turn) => turn.status === "running" && (!turn.runtimeId || !activeRuntimeIds.has(turn.runtimeId)))
          .map((turn) => turn.id));
        const interruptedTurns = new Set(turns
          .filter((turn) => newlyInterruptedTurns.has(turn.id) || (turn.status === "failed" && turn.errorSummary === "Interrupted by runtime restart."))
          .map((turn) => turn.id));
        for (const toolCall of this.store.listToolCalls(session.id, 10_000).reverse()) {
          if (!toolCall.turnId || !interruptedTurns.has(toolCall.turnId)) continue;
          if (toolCall.status !== "pending" && toolCall.status !== "running" && toolCall.status !== "error") continue;
          this.recordRecoveredToolError(toolCall, RESTART_TOOL_ERROR);
        }
        for (const turn of turns) {
          if (newlyInterruptedTurns.has(turn.id)) this.store.updateTurn(turn.id, { status: "failed", stopReason: "planner_error", errorSummary: "Interrupted by runtime restart." });
        }
        if (!session.archivedAt) {
          const pendingUserInput = this.userInputs.recover(session.id, this.store.listEvents(session.id, 10_000));
          const latestInterruptedTurn = [...turns].reverse().find((turn) => newlyInterruptedTurns.has(turn.id));
          if (latestInterruptedTurn && !pendingUserInput && !this.mailbox.hasQueued(session.id)) {
            this.inputQueue.enqueueFollowup(
              session.id,
              [
                "Continue the task that was interrupted by the runtime restart.",
                "Use the durable transcript and tool results as the source of truth.",
                "Do not blindly replay mutating calls; inspect current state first, then resume from the next useful action."
              ].join(" "),
              "plain",
              `runtime-recovery:${latestInterruptedTurn.id}`
            );
          }
        }
      }
      for (const job of this.store.listRecoverableJobs()) {
        if (job.runtimeId === this.runtimeId || activeRuntimeIds.has(job.runtimeId)) continue;
        if (job.kind === "agent" && job.childSessionId) {
          const response = this.completedAssistantText(job.childSessionId);
          if (response) {
            this.jobs.completeAgent(job.id, response, job.agentMode !== "attached");
            continue;
          }
        }
        this.jobs.markLost(job.id, "Background execution owner was lost during runtime restart. Durable session work is resumable, but the original in-memory process cannot be reattached.", job.agentMode !== "attached");
      }
      for (const job of this.store.listTerminalJobsMissingMailbox()) this.jobs.repairTerminalMailbox(job.id);
      for (const session of sessions) this.reconcileRecoveredBackgroundTools(session.id, activeRuntimeIds);
      this.recovered = true;
      for (const sessionId of this.store.listSessionsWithQueuedMailbox()) {
        const session = this.store.loadSession(sessionId);
        if (!session.archivedAt) void this.mailboxDispatcher.wakePending(sessionId);
      }
    })();
    try {
      await this.recoveryPromise;
    } catch (error) {
      this.stopRuntimeLease();
      throw error;
    } finally {
      this.recoveryPromise = undefined;
    }
  }

  private emitRecoverableToolError(toolCall: ToolCallRecord, stage: string, error: unknown): void {
    try {
      this.event(toolCall.sessionId, "planner_error", {
        toolCallId: toolCall.id,
        tool: toolCall.tool,
        error: `${stage}: ${error instanceof Error ? error.message : String(error)}`,
        recoverable: true
      });
    } catch {  }
  }

  private renderToolResult(tool: ToolDefinition, toolCall: ToolCallRecord, result: ToolResult): RenderedToolResult {
    const presentationErrors: Record<string, string> = {};
    let humanResult: string;
    let renderedForModel: string;
    try {
      humanResult = tool.renderHuman(result);
    } catch (error) {
      presentationErrors.human = error instanceof Error ? error.message : String(error);
      humanResult = result.output ?? result.summary;
    }
    try {
      renderedForModel = tool.renderModel(result);
    } catch (error) {
      presentationErrors.model = error instanceof Error ? error.message : String(error);
      renderedForModel = result.output ?? result.summary;
    }
    const renderedResult = Object.keys(presentationErrors).length
      ? { ...result, metadata: { ...result.metadata, presentationErrors } }
      : result;
    if (Object.keys(presentationErrors).length) {
      this.event(toolCall.sessionId, "planner_error", {
        toolCallId: toolCall.id,
        tool: toolCall.tool,
        error: `tool renderer fallback: ${Object.values(presentationErrors).join("; ")}`,
        recoverable: true
      });
    }
    return {
      result: renderedResult,
      humanResult: takeBytes(sanitizeToolOutput(humanResult), TOOL_HUMAN_RESULT_MAX_BYTES, "head"),
      modelResult: renderModelToolResultEnvelope(toolCall, renderedResult, renderedForModel)
    };
  }

  private recordRecoveredToolError(toolCall: ToolCallRecord, error: string, state: ToolErrorState = { interrupted: true, reason: "runtime_restart" }): ToolCallRecord {
    return this.toolCalls.settleError(toolCall, error, state, false);
  }

  private recordRecoveredToolSuccess(toolCall: ToolCallRecord, summary: string): ToolCallRecord {
    return this.toolCalls.settleRecoveredSuccess(toolCall, summary);
  }

  private reconcileRecoveredBackgroundTools(sessionId: string, activeRuntimeIds: ReadonlySet<string>): void {
    const turns = new Map(this.store.listTurns(sessionId, 10_000).map((turn) => [turn.id, turn]));
    const jobs = this.store.listJobs(sessionId, 10_000);
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const jobsByProcess = new Map(jobs.filter((job) => job.processId).map((job) => [job.processId!, job]));
    const jobsByToolCall = new Map(jobs.filter((job) => job.toolCallId).map((job) => [job.toolCallId!, job]));
    for (const toolCall of this.store.listToolCalls(sessionId, 10_000).reverse()) {
      if (toolCall.status !== "running_background" && !(toolCall.processId && (toolCall.status === "done" || toolCall.status === "error"))) continue;
      const owner = toolCall.turnId ? turns.get(toolCall.turnId) : undefined;
      if (owner?.status === "running" && owner.runtimeId && activeRuntimeIds.has(owner.runtimeId)) continue;
      const job = (toolCall.jobId ? jobsById.get(toolCall.jobId) : undefined)
        ?? (toolCall.processId ? jobsByProcess.get(toolCall.processId) : undefined)
        ?? jobsByToolCall.get(toolCall.id);
      if (!job) {
        if (toolCall.status === "done") this.recordRecoveredToolSuccess(toolCall, "background process completed before runtime recovery; final output was not replayed");
        else this.recordRecoveredToolError(toolCall, RESTART_TOOL_ERROR);
        continue;
      }
      if (job.status === "succeeded") {
        this.recordRecoveredToolSuccess(toolCall, recoveredJobSummary(job));
      } else if (job.status === "failed" || job.status === "cancelled" || job.status === "lost") {
        this.recordRecoveredToolError(toolCall, job.error ?? recoveredJobSummary(job), {
          interrupted: job.status === "cancelled" || job.status === "lost",
          cancelled: job.status === "cancelled",
          reason: `background_job_${job.status}`
        });
      }
    }
  }

  private completedAssistantText(sessionId: string): string | undefined {
    const turn = this.store.listTurns(sessionId, 1_000).at(-1);
    if (!turn || turn.status !== "completed") return undefined;
    const texts = this.store.listMessages(sessionId, 1_000)
      .filter((message) => message.role === "assistant" && message.turnId === turn.id)
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => (part.payload as { text?: unknown }).text)
      .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
    return texts.at(-1);
  }

  private async recordJobCompletion(item: SessionMailboxItem, job: BackgroundJob): Promise<void> {
    if (this.shuttingDown || !this.store.isOpen()) return;
    const type = job.status === "succeeded"
      ? "job_completed"
      : job.status === "cancelled"
        ? "job_cancelled"
        : job.status === "lost"
          ? "job_lost"
          : "job_failed";
    this.event(item.sessionId, type, { jobId: job.id, mailboxId: item.id, status: job.status, processId: job.processId });
    this.event(item.sessionId, "mailbox_queued", { mailboxId: item.id, kind: item.kind, sequence: item.sequence });
    const output = job.result && typeof job.result === "object" && "output" in job.result
      ? String((job.result as { output?: unknown }).output ?? "")
      : "";
    let tool: string | undefined;
    if (job.toolCallId) {
      try { tool = this.store.loadToolCall(job.toolCallId).tool; } catch {  }
    }
    if (tool === "callback_oast" && output) {
      const events = parseOastEvents(output);
      if (events.length) {
        for (const evidence of oastEvidenceForSession(job.sessionId, events)) this.store.saveEvidence(evidence, JSON.stringify(events));
      }
    }
    await this.fireHooks(this.store.loadSession(job.sessionId), "job.completed", tool, {
      jobId: job.id,
      processId: job.processId,
      tool,
      status: job.status
    });
    if (item.triggerPolicy === "wake" && this.recovered && !this.shuttingDown) void this.mailboxDispatcher.wakeCompletion(item.sessionId, "wake");
  }

  private get hookRunner(): HookRunner {
    return {
      mcp: async (hook, payload) => {
        const session = this.store.loadSession(payload.sessionId);
        const rootSessionId = this.rootSessionId(session);
        const result = await callMcpServerTool({
          workspace: session.workspace,
          configWorkspace: this.workspace,
          session,
          rootSessionId,
          rootWorkspace: this.workspace,
          ...(this.containerLifecycle ? { containerLifecycle: this.containerLifecycle } : {}),
          ...this.mcpCallbacks(session),
          server: hook.mcp!.server,
          tool: hook.mcp!.tool,
          args: payload
        });
        return typeof result === "string" ? result : JSON.stringify(result);
      }
    };
  }

  private async fireHooks(session: Session, event: HookEvent, subject: string | undefined, extra: Record<string, unknown> = {}): Promise<void> {
    if (!this.hooksEnabled) return;
    try {
      const hooks = this.hooks ?? (this.hooks = loadHooks(this.workspace));
      if (hooks.length === 0) return;
      const results = await runHooks(hooks, event, subject, { event, sessionId: session.id, ...extra }, this.hookRunner);
      const contexts = results.map((result) => result.additionalContext).filter((text): text is string => Boolean(text));
      if (contexts.length) {
        const queue = this.pendingHookContext.get(session.id) ?? [];
        queue.push(...contexts);
        this.pendingHookContext.set(session.id, queue);
      }
      for (const result of results) {
        if (result.error) this.event(session.id, "planner_error", { error: `hook ${event} failed: ${result.error}`, recoverable: true });
      }
    } catch (error) {
      this.event(session.id, "planner_error", { error: `hooks for ${event} failed: ${error instanceof Error ? error.message : String(error)}`, recoverable: true });
    }
  }

  private drainHookContext(sessionId: string): PlannerContextBlock[] {
    const queue = this.pendingHookContext.get(sessionId);
    if (!queue || queue.length === 0) return [];
    this.pendingHookContext.delete(sessionId);
    return queue.map((body) => ({ title: "Hook Context", body, stable: false }));
  }

  private drainSteeringContext(sessionId: string): PlannerContextBlock[] {
    const queue = this.pendingSteeringContext.get(sessionId);
    if (!queue || queue.length === 0) return [];
    this.pendingSteeringContext.delete(sessionId);
    return queue.map((body) => ({ title: "Steering Timing", body, stable: false }));
  }

  async createSession(options: Partial<Pick<Session, "title" | "provider" | "model" | "campaignId">> = {}): Promise<Session> {
    this.assertAcceptingWork();
    await this.recover();
    this.assertAcceptingWork();
    const model = defaultModelSelection();
    const session = await this.store.createSession({
      workspace: this.workspace,
      ...(model ? { model } : {}),
      ...options
    });
    return session;
  }

  listSessions(includeArchived = false): Session[] {
    return this.store.listSessions(100, { includeArchived });
  }

  loadSession(sessionId: string): Session {
    return this.store.loadSession(sessionId);
  }

  injectUserInput(sessionId: string, text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || this.shuttingDown) return false;
    const running = this.store.listTurns(sessionId, 5).some((turn) => turn.status === "running");
    if (!running) return false;
    if (!this.inputQueue.enqueueSteer(sessionId, trimmed)) return false;
    this.notifySteeringWaiters(sessionId);
    return true;
  }

  listPendingSteeringInputs(sessionId: string): PendingSteerInput[] {
    return this.inputQueue.listPendingSteers(sessionId);
  }

  queueUserInput(sessionId: string, text: string, action: QueuedInputAction = queuedInputAction(text)): QueuedUserInput | undefined {
    if (this.shuttingDown) return undefined;
    const queued = this.inputQueue.enqueueFollowup(sessionId, text, action);
    if (!queued) return undefined;
    if (!this.hasRunningTurn(sessionId) && !this.compactionControllers.has(sessionId)) void this.mailboxDispatcher.wakeQueuedInputs(sessionId);
    return queued;
  }

  private queueRecoveredUserInput(sessionId: string, text: string, requestId: string): void {
    if (this.shuttingDown) throw new Error("cannot resume recovered user input while Farai is shutting down");
    const queued = this.inputQueue.enqueueFollowup(
      sessionId,
      text,
      "plain",
      `recovered-user-input:${requestId}`
    );
    if (!queued) throw new Error("failed to persist recovered user input continuation");
    if (this.recovered && !this.hasRunningTurn(sessionId) && !this.compactionControllers.has(sessionId)) {
      void this.mailboxDispatcher.wakeQueuedInputs(sessionId);
    }
  }

  listQueuedUserInputs(sessionId: string): QueuedUserInput[] {
    return this.inputQueue.listQueuedUserInputs(sessionId);
  }

  listQueuedFollowupInputs(sessionId: string): QueuedUserInput[] {
    return this.inputQueue.listFollowups(sessionId);
  }

  takeBackQueuedUserInput(sessionId: string): QueuedUserInput | undefined {
    return this.inputQueue.takeBackLatestFollowup(sessionId);
  }

  hasRunningTurn(sessionId: string): boolean {
    return this.store.listTurns(sessionId, 5).some((turn) => turn.status === "running");
  }

  private agentLifecycleEntry(parentSessionId: string, child: Session): AgentLifecycleEntry {
    if (child.parentId !== parentSessionId) throw new Error(`subagent session ${child.id} does not belong to this parent`);
    const job = this.store.listJobs(parentSessionId, 10_000).find((candidate) => candidate.kind === "agent" && candidate.childSessionId === child.id);
    const result = job?.result && typeof job.result === "object" ? job.result as Record<string, unknown> : undefined;
    const running = this.hasRunningTurn(child.id) || Boolean(job && ["created", "starting", "running", "cancelling"].includes(job.status));
    return {
      sessionId: child.id,
      ...(child.title ? { title: child.title } : {}),
      ...(job?.lane ? { lane: job.lane } : {}),
      ...(job?.agentMode ? { mode: job.agentMode } : {}),
      ...(job ? { jobId: job.id } : {}),
      status: child.archivedAt ? "archived" : job?.status ?? "idle",
      running,
      archived: Boolean(child.archivedAt),
      ...(typeof result?.response === "string" ? { response: result.response } : {}),
      ...(job?.error ? { error: job.error } : {}),
      ...(job?.outputArtifactId ? { outputArtifactId: job.outputArtifactId } : {}),
      createdAt: child.createdAt,
      updatedAt: job?.updatedAt ?? child.updatedAt
    };
  }

  private listAgentLifecycleEntries(parentSessionId: string): AgentLifecycleEntry[] {
    return this.store.listSessions(10_000, { includeArchived: true })
      .filter((candidate) => candidate.parentId === parentSessionId)
      .map((candidate) => this.agentLifecycleEntry(parentSessionId, candidate))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private createProviderSlot(session: Session, turn: Turn): ProviderSlot {
    const contextMessage = this.store.createMessage({ sessionId: session.id, turnId: turn.id, role: "system" });
    const assistantMessage = this.store.createMessage({ sessionId: session.id, turnId: turn.id, role: "assistant" });
    return { contextMessage, assistantMessage };
  }

  private assembleContext(input: ContextRequest, catalogMessage?: Message): ContextProjection {
    const key = this.providerCatalogKey(input.session);
    const cacheKey = `${input.session.id}:${key}`;
    const pinned = this.providerCatalogs.get(cacheKey) ?? this.loadProviderCatalog(input.session.id, key);
    if (pinned) this.providerCatalogs.set(cacheKey, pinned);
    const projection = this.contextEngine.assemble({
      ...input,
      ...(pinned ? { advertisedTools: pinned } : {})
    });
    if (catalogMessage) {
      const tools = structuredClone(projection.toolCatalog);
      this.providerCatalogs.set(cacheKey, tools);
      if (!pinned || !sameProviderToolCatalog(pinned, tools)) {
        this.store.addPart({
          sessionId: input.session.id,
          turnId: catalogMessage.turnId,
          messageId: catalogMessage.id,
          type: "provider_catalog",
          payload: { key, tools } satisfies ProviderCatalogPayload
        });
      }
    }
    return projection;
  }

  private providerCatalogKey(session: Session): string {
    const promptHash = createHash("sha256").update(buildSystemPrompt({ session })).digest("hex").slice(0, 16);
    const identity = JSON.stringify({
      prompt: promptHash,
      provider: session.provider ?? "",
      model: session.model ?? "",
      scope: [...(session.toolScope ?? [])].map(canonicalToolName).sort()
    });
    return createHash("sha256").update(identity).digest("hex").slice(0, 24);
  }

  private loadProviderCatalog(sessionId: string, key: string): ProviderToolDef[] | undefined {
    for (const part of [...this.store.listPartsByType(sessionId, "provider_catalog", 1_000)].reverse()) {
      const payload = part.payload as Partial<ProviderCatalogPayload> | undefined;
      if (payload?.key !== key || !Array.isArray(payload.tools)) continue;
      const tools = payload.tools.filter(isProviderToolDef);
      if (tools.length === payload.tools.length) return structuredClone(tools);
    }
    return undefined;
  }

  private captureProviderContext(
    session: Session,
    turn: Turn,
    contextMessage: Message,
    text: string | undefined,
    previousHash: string | undefined
  ): { text: string; hash: string } | undefined {
    const normalized = text?.trim();
    if (!normalized) return undefined;
    const hash = createHash("sha256").update(normalized).digest("hex");
    if (hash === previousHash) return undefined;
    this.store.addPart({
      sessionId: session.id,
      turnId: turn.id,
      messageId: contextMessage.id,
      type: "provider_context",
      payload: { text: normalized, hash }
    });
    return { text: normalized, hash };
  }

  private latestProviderContextHash(sessionId: string): string | undefined {
    const messages = this.store.listContextMessages(sessionId, 100_000);
    for (const message of [...messages].reverse()) {
      for (const part of [...message.parts].reverse()) {
        if (part.type !== "provider_context") continue;
        const payload = part.payload as { text?: unknown; hash?: unknown };
        if (typeof payload.hash === "string" && payload.hash) return payload.hash;
        if (typeof payload.text === "string" && payload.text.trim()) {
          return createHash("sha256").update(payload.text.trim()).digest("hex");
        }
      }
    }
    return undefined;
  }

  private drainPendingUserInput(session: Session, turn: Turn): ProviderSlot | undefined {
    const items = this.inputQueue.claimSteers(session.id);
    if (items.length === 0) return undefined;
    for (const item of items) {
      const text = mailboxInputText(item);
      if (!text) continue;
      const userMessage = this.store.createMessage({ sessionId: session.id, turnId: turn.id, role: "user" });
      this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: userMessage.id, type: "text", payload: { text } });
      this.event(session.id, "text", { role: "user", text });
    }
    this.inputQueue.consumeSteers(session.id, items);
    const context = this.pendingSteeringContext.get(session.id) ?? [];
    context.push("The latest user message arrived while prior model/tool work was still running. Reconcile it against any tool results that completed afterward; if those results already satisfy the request, report them instead of repeating the work.");
    this.pendingSteeringContext.set(session.id, context);
    return this.createProviderSlot(session, turn);
  }

  reconcileBackgroundJobs(sessionId: string): number {
    let settled = 0;
    try {
      for (const job of activeBackgroundJobs(this.store.listToolCalls(sessionId, 200))) {
        if (!sessionManager.isTracked(job.processId)) {
          this.settleBackgroundProcess(sessionId, job.processId, "error");
          settled += 1;
        }
      }
    } catch {  }
    return settled;
  }

  cancelTurn(turnId: string, reason = "cancelled by user"): Turn {
    const turn = this.store.cancelTurn(turnId, reason);
    this.inputQueue.restorePendingSteersAfterCancellation(turn.sessionId);
    const controllers = this.turnControllers.get(turnId);
    if (controllers) {
      for (const c of controllers) { try { c.abort(reason); } catch {  } }
      this.turnControllers.delete(turnId);
    }
    this.event(turn.sessionId, "loop_stop", { turnId: turn.id, status: "cancelled", reason: "cancelled", errorSummary: reason });
    return turn;
  }

  private registerTurnController(turnId: string | undefined, timeoutMs?: number): { signal: AbortSignal; release: () => void; timedOut: () => boolean } {
    const controller = new AbortController();
    let deadlineReached = false;
    const timer = timeoutMs === undefined || !Number.isFinite(timeoutMs)
      ? undefined
      : setTimeout(() => {
          deadlineReached = true;
          controller.abort(new ModelCallDeadlineError());
        }, Math.max(0, timeoutMs));
    if (this.shuttingDown) controller.abort("runtime shutdown");
    if (!turnId) return {
      signal: controller.signal,
      timedOut: () => deadlineReached,
      release: () => { if (timer) clearTimeout(timer); }
    };
    const list = this.turnControllers.get(turnId) ?? [];
    list.push(controller);
    this.turnControllers.set(turnId, list);
    return {
      signal: controller.signal,
      timedOut: () => deadlineReached,
      release: () => {
        if (timer) clearTimeout(timer);
        const current = this.turnControllers.get(turnId);
        if (!current) return;
        const idx = current.indexOf(controller);
        if (idx !== -1) current.splice(idx, 1);
        if (current.length === 0) this.turnControllers.delete(turnId);
      }
    };
  }

  private waitForSteering(sessionId: string): { promise: Promise<void>; cancel: () => void } {
    let settled = false;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const wake = () => {
      if (settled) return;
      settled = true;
      this.steeringWaiters.get(sessionId)?.delete(wake);
      resolve();
    };
    const waiters = this.steeringWaiters.get(sessionId) ?? new Set<() => void>();
    waiters.add(wake);
    this.steeringWaiters.set(sessionId, waiters);
    return {
      promise,
      cancel: () => {
        if (settled) return;
        settled = true;
        waiters.delete(wake);
        if (waiters.size === 0) this.steeringWaiters.delete(sessionId);
      }
    };
  }

  private notifySteeringWaiters(sessionId: string): void {
    for (const wake of [...(this.steeringWaiters.get(sessionId) ?? [])]) wake();
  }

  updateSession(sessionId: string, patch: SessionPatch): Session {
    const session = this.store.updateSession(sessionId, patch);
    this.recordSession(session);
    return session;
  }

  async forkSession(sessionId: string, title?: string): Promise<Session> {
    const source = this.store.loadSession(sessionId);
    let session = await this.store.forkSession(sessionId, title);
    const temporaryIds = new Set(disposableInboxManager.list(source.id).map((inbox) => inbox.id));
    const patch: SessionPatch = {};
    if (session.emailPrimaryId && temporaryIds.has(session.emailPrimaryId)) patch.emailPrimaryId = null;
    if (session.emailSecondaryId && temporaryIds.has(session.emailSecondaryId)) patch.emailSecondaryId = null;
    if (Object.keys(patch).length > 0) session = this.store.updateSession(session.id, patch);
    this.recordSession(session);
    return session;
  }

  async archiveSession(sessionId: string): Promise<Session> {
    this.cancelCompaction(sessionId);
    for (const turn of this.store.listTurns(sessionId, 10_000)) {
      if (turn.status === "running") this.cancelTurn(turn.id, "session archived");
    }
    await this.cancelSessionJobs(sessionId);
    this.store.cancelMailbox(sessionId);
    const session = this.store.archiveSession(sessionId);
    await this.lsp.shutdownSession(sessionId).catch(() => {});
    await stopBrowserContextsForSession(sessionId).catch(() => {});
    await this.stopSessionEmail(sessionId).catch(() => {});
    await stopMcpToolsForSession(sessionId).catch(() => {});
    if (this.rootSessionId(session) === session.id) {
      for (const member of this.sessionTree(session.id).filter((candidate) => candidate.id !== session.id)) {
        await this.lsp.shutdownSession(member.id).catch(() => {});
        await stopBrowserContextsForSession(member.id).catch(() => {});
        await this.stopSessionEmail(member.id).catch(() => {});
        await stopMcpToolsForSession(member.id).catch(() => {});
      }
      await this.containerBackend(session.workspace, sessionId)
        .stopPersistent()
        .catch(() => {});
    }
    return session;
  }

  async clearSession(sessionId: string): Promise<Session> {
    this.cancelCompaction(sessionId);
    for (const turn of this.store.listTurns(sessionId, 1000)) {
      if (turn.status === "running") this.cancelTurn(turn.id, "conversation cleared");
    }
    await this.cancelSessionJobs(sessionId);
    return this.withSessionLock(sessionId, async () => this.clearSessionState(sessionId));
  }

  async discardSessionIfEmpty(sessionId: string): Promise<boolean> {
    const session = this.store.loadSession(sessionId);
    const rootSessionId = this.rootSessionId(session);
    if (rootSessionId !== session.id) return false;
    return this.withSessionLock(rootSessionId, async () => {
      if (this.store.isSessionResumable(rootSessionId)) return false;
      if (this.sessionTree(rootSessionId).length !== 1) return false;
      await this.lsp.shutdownSession(rootSessionId).catch(() => {});
      await stopBrowserContextsForSession(rootSessionId).catch(() => {});
      await this.stopSessionEmail(rootSessionId).catch(() => {});
      await stopMcpToolsForSession(rootSessionId).catch(() => {});
      serviceRegistry.unregisterSession(rootSessionId);
      await this.containerBackend(session.workspace, rootSessionId).stopPersistent().catch(() => undefined);
      const discarded = this.store.discardEmptyRootSession(rootSessionId);
      if (discarded && this.registerSessionCatalog) {
        try { removeSessionLocation(rootSessionId); } catch {  }
      }
      return discarded;
    });
  }

  async abortSessionTree(sessionId: string, reason = "run deadline exceeded", options: { stopContainers?: boolean } = {}): Promise<void> {
    const sessions = this.sessionTree(sessionId).reverse();
    const stoppedContainers = new Set<string>();
    for (const session of sessions) {
      this.cancelCompaction(session.id);
      for (const turn of this.store.listTurns(session.id, 10_000)) {
        if (turn.status === "running") this.cancelTurn(turn.id, reason);
      }
      this.store.cancelMailbox(session.id);
      await this.cancelSessionJobs(session.id);
      await this.lsp.shutdownSession(session.id).catch(() => {});
      await stopBrowserContextsForSession(session.id).catch(() => {});
      await this.stopSessionEmail(session.id).catch(() => {});
      await stopMcpToolsForSession(session.id).catch(() => {});
      serviceRegistry.unregisterSession(session.id);
      if (options.stopContainers !== false) {
        const rootSessionId = this.rootSessionId(session);
        if (!stoppedContainers.has(rootSessionId)) {
          stoppedContainers.add(rootSessionId);
          await this.containerBackend(session.workspace, session.id)
            .stopPersistent()
            .catch(() => {});
        }
      }
    }
  }

  private sessionTree(rootSessionId: string): Session[] {
    const sessions = this.store.listSessions(100_000, { includeArchived: true });
    const included = new Set([rootSessionId]);
    for (;;) {
      let changed = false;
      for (const session of sessions) {
        if (session.parentId && included.has(session.parentId) && !included.has(session.id)) {
          included.add(session.id);
          changed = true;
        }
      }
      if (!changed) break;
    }
    return sessions.filter((session) => included.has(session.id));
  }

  private sessionFamily(sessionId: string): Session[] {
    let root = this.store.loadSession(sessionId);
    while (root.parentId) root = this.store.loadSession(root.parentId);
    return this.sessionTree(root.id);
  }

  private async cancelSessionJobs(sessionId: string): Promise<void> {
    const jobs = this.store.listJobs(sessionId, 10_000)
      .filter((job) => job.runtimeId === this.runtimeId && !["succeeded", "failed", "cancelled", "lost"].includes(job.status));
    for (const job of jobs) {
      this.subagentControllers.get(job.id)?.abort("session closed");
      if (job.childSessionId) {
        for (const childTurn of this.store.listTurns(job.childSessionId, 10_000)) {
          if (childTurn.status === "running") this.cancelTurn(childTurn.id, "session closed");
        }
      }
    }
    await Promise.allSettled(jobs.map((job) => this.jobs.cancel(job.id, false)));
    for (const job of activeBackgroundJobs(this.store.listToolCalls(sessionId, 10_000))) {
      const persisted = this.store.findJobByProcessId(job.processId);
      if (!persisted && sessionManager.isTracked(job.processId)) await sessionManager.stop(job.processId).catch(() => {});
    }
  }

  private clearSessionState(sessionId: string): Session {
    this.pendingSteeringContext.delete(sessionId);
    this.pendingHookContext.delete(sessionId);
    this.firedSessionStart.delete(sessionId);
    this.autoCompactFailures.delete(sessionId);
    this.fileState.clear(sessionId);
    for (const turn of this.store.listTurns(sessionId, 1000)) {
      this.deleteStreamingParts(turn.id);
    }
    return this.store.clearSessionChat(sessionId);
  }

  containerStatus(sessionId: string): Promise<ContainerStatus> {
    return this.containerBackend(this.store.loadSession(sessionId).workspace, sessionId).status();
  }

  async startContainer(sessionId: string): Promise<void> {
    const result = await this.containerBackend(this.store.loadSession(sessionId).workspace, sessionId).startPersistent();
    if (result.exitCode !== 0) throw new Error(result.stderr || "Could not start Kali container");
  }

  async refreshMcp(session: Session, options: { force?: boolean } = {}): Promise<void> {
    if (!this.mcpEnabled) return;
    const rootSessionId = this.rootSessionId(session);
    await refreshMcpTools({
      workspace: session.workspace,
      configWorkspace: this.workspace,
      session,
      rootSessionId,
      rootWorkspace: this.workspace,
      ...(this.containerLifecycle ? { containerLifecycle: this.containerLifecycle } : {}),
      ...this.mcpCallbacks(session),
      background: true,
      includeResources: false,
      ...(options.force ? { force: true } : {}),
      onStartupEvent: (event) => this.event(session.id, event.type, event)
    });
  }

  async startMcpServer(session: Session, serverName: string): Promise<McpServerRuntimeStatus> {
    const rootSessionId = this.rootSessionId(session);
    return await startMcpServer({
      workspace: session.workspace,
      configWorkspace: this.workspace,
      session,
      rootSessionId,
      rootWorkspace: this.workspace,
      ...(this.containerLifecycle ? { containerLifecycle: this.containerLifecycle } : {}),
      ...this.mcpCallbacks(session),
      onStartupEvent: (event) => this.event(session.id, event.type, event)
    }, serverName);
  }

  async stopMcpServer(session: Session, serverName: string): Promise<McpServerRuntimeStatus> {
    const rootSessionId = this.rootSessionId(session);
    return await stopMcpServer({
      workspace: session.workspace,
      configWorkspace: this.workspace,
      session,
      rootSessionId,
      rootWorkspace: this.workspace,
      ...(this.containerLifecycle ? { containerLifecycle: this.containerLifecycle } : {})
    }, serverName);
  }

  async probeMcpServer(session: Session, input: SaveMcpServerInput, signal?: AbortSignal): Promise<McpServerProbeResult> {
    const rootSessionId = this.rootSessionId(session);
    return await probeMcpServerConfig({
      workspace: session.workspace,
      configWorkspace: this.workspace,
      session,
      rootSessionId,
      rootWorkspace: this.workspace,
      ...(signal ? { signal } : {}),
      ...(this.containerLifecycle ? { containerLifecycle: this.containerLifecycle } : {}),
      ...this.mcpCallbacks(session)
    }, mcpServerFromInput(input));
  }

  async invokeMcpPrompt(session: Session, server: string, prompt: string, positionals: string[], signal?: AbortSignal): Promise<string> {
    const rootSessionId = this.rootSessionId(session);
    const base: McpRefreshInput = {
      workspace: session.workspace,
      configWorkspace: this.workspace,
      session,
      rootSessionId,
      rootWorkspace: this.workspace,
      ...(signal ? { signal } : {}),
      ...(this.containerLifecycle ? { containerLifecycle: this.containerLifecycle } : {}),
      ...this.mcpCallbacks(session),
      onStartupEvent: (event) => this.event(session.id, event.type, event)
    };
    const descriptor = await getMcpPromptDescriptor({ ...base, server, prompt });
    const args = await resolveMcpPromptArguments(server, prompt, descriptor, positionals, (input) => this.requestUserInput(session, input, signal));
    return renderMcpPromptResult(server, prompt, await getMcpPrompt({ ...base, server, prompt, args }));
  }

  async stopContainer(sessionId: string): Promise<void> {
    const session = this.store.loadSession(sessionId);
    for (const member of this.sessionFamily(sessionId)) {
      await this.lsp.shutdownSession(member.id).catch(() => {});
      await stopBrowserContextsForSession(member.id).catch(() => {});
      await stopMcpToolsForSession(member.id).catch(() => {});
    }
    const result = await this.containerBackend(session.workspace, sessionId).stopPersistent();
    if (result.exitCode !== 0) throw new Error(result.stderr || "Could not stop Kali container");
  }

  private assertWorkspaceTransitionIdle(sessionId: string): void {
    const background = activeBackgroundJobs(this.store.listToolCalls(sessionId, 10_000));
    const jobs = this.store.listJobs(sessionId, 10_000).filter((job) => ["created", "starting", "running", "cancelling"].includes(job.status));
    if (background.length === 0 && jobs.length === 0) return;
    const labels = [
      ...background.map((job) => job.processId),
      ...jobs.map((job) => job.childSessionId ?? job.processId ?? job.id)
    ];
    throw new Error(`workspace transition requires all background work to finish or be stopped first: ${labels.join(", ")}`);
  }

  private async stopWorkspaceBoundServices(sessionId: string): Promise<void> {
    const operations: Array<{ name: string; run: () => Promise<unknown> }> = [
      { name: "browser contexts", run: () => stopBrowserContextsForSession(sessionId) },
      { name: "MCP servers", run: () => stopMcpToolsForSession(sessionId) },
      { name: "LSP servers", run: () => this.lsp.shutdownSession(sessionId) }
    ];
    const results = await Promise.all(operations.map(async (operation) => {
      try {
        await withDeadlineMs(operation.run(), 7_500, `${operation.name} shutdown`);
        return undefined;
      } catch (error) {
        return `${operation.name}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }));
    const failures = results.filter((result): result is string => Boolean(result));
    if (failures.length) throw new Error(`workspace services could not be stopped safely (${failures.join("; ")})`);
  }

  private containerBackend(workspace: string, sessionId: string, timeoutMs?: number): RuntimeContainerBackend {
    const rootSessionId = this.rootSessionId(this.store.loadSession(sessionId));
    return this.containerBackendFactory(workspace, rootSessionId, timeoutMs);
  }

  exportReport(sessionId: string, options: { write?: boolean } = {}): { markdown: string; path?: string } {
    const session = this.store.loadSession(sessionId);
    const markdown = renderCtfNotes({
      session,
      evidence: this.store.listEvidence(sessionId),
      findings: this.store.listFindings(sessionId),
      notes: this.store.listNotes(sessionId),
      todos: this.store.listTodos(sessionId),
      memory: this.store.listMemory(sessionId),
      ...(session.campaignId ? { campaign: this.store.campaignDossier(session.campaignId) } : {})
    });
    if (!options.write) return { markdown };
    const dir = join(this.workspace, ".farai", "reports");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const path = join(dir, `${sessionId}-${stamp}.md`);
    atomicWriteFile(path, markdown, 0o600);
    return { markdown, path };
  }

  private actor(sessionId: string): SessionActor {
    const existing = this.actors.get(sessionId);
    if (existing) return existing;
    const actor = new SessionActor();
    this.actors.set(sessionId, actor);
    return actor;
  }

  private withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.actor(sessionId).run(fn);
  }

  async prompt(session: Session, input: string, options: PromptOptions = {}): Promise<AgentPromptResult> {
    this.assertAcceptingWork();
    options.signal?.throwIfAborted();
    if (input.trim() === "/clear") {
      await this.recover();
      this.assertAcceptingWork();
      return { session: await this.clearSession(session.id), response: "conversation cleared", events: [] };
    }
    const item = this.inputQueue.schedulePrompt(session.id, input);
    try {
      await this.recover();
      this.assertAcceptingWork();
      options.signal?.throwIfAborted();
      const scheduled = this.withSessionLock(session.id, async () => {
        const current = this.store.loadSession(session.id);
        try {
          this.assertAcceptingWork();
          options.signal?.throwIfAborted();
          const claimed = this.mailbox.claimById(item.id);
          if (!claimed) throw new Error(`Prompt mailbox item is unavailable: ${item.id}`);
          const completionItems = input.trimStart().startsWith("/")
            ? []
            : this.mailbox.claim(current.id, "context", BACKGROUND_MAILBOX_BATCH_SIZE);
          try {
            const result = await this.runPrompt(current, input, { mailboxItems: completionItems });
            this.mailbox.consume([claimed]);
            this.mailbox.consume(completionItems);
            for (const completion of completionItems) {
              this.event(current.id, "mailbox_consumed", { mailboxId: completion.id, sequence: completion.sequence });
            }
            return result;
          } catch (error) {
            this.mailbox.release([claimed]);
            this.mailbox.release(completionItems);
            throw error;
          }
        } catch (error) {
          if ((this.shuttingDown || options.signal?.aborted) && this.store.isOpen()) {
            try { this.mailbox.cancel(item.id); } catch {  }
          }
          throw error;
        }
      });
      return await scheduled;
    } finally {
      this.inputQueue.finishScheduledPrompt(item.id);
    }
  }

  private async runPrompt(
    session: Session,
    input: string,
    options: { source?: "user" | "background"; mailboxItems?: SessionMailboxItem[] } = {}
  ): Promise<AgentPromptResult> {
    session = this.store.loadSession(session.id);
    const source = options.source ?? "user";
    const trimmed = input.trim();
    if (source === "user" && isDefaultSessionTitle(session.title)) {
      const title = titleFromPrompt(input);
      if (!isDefaultSessionTitle(title)) {
        session = this.store.updateSession(session.id, { title });
        this.recordSession(session);
      }
    }
    if (source === "user" && (trimmed === "/compact" || trimmed.startsWith("/compact "))) {
      const cursor = this.store.latestEventSequence(session.id);
      const instructions = trimmed.slice("/compact".length).trim() || undefined;
      const compacted = await this.compactSession(session, instructions);
      const events = this.store.listEventsAfter(session.id, cursor, 10_000);
      return { session: compacted, response: "context compacted", events };
    }
    this.hooks = undefined;
    this.reconcileBackgroundJobs(session.id);
    const turn = this.store.createTurn(session.id, source === "user" ? input : "background completion", this.runtimeId);
    this.recordSession(session);
    let contextMessage: Message;
    if (source === "user") {
      const userMessage = this.store.createMessage({ sessionId: session.id, turnId: turn.id, role: "user" });
      this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: userMessage.id, type: "text", payload: { text: input } });
      this.event(session.id, "text", { role: "user", text: input });
      contextMessage = this.store.createMessage({ sessionId: session.id, turnId: turn.id, role: "system" });
    } else {
      contextMessage = this.store.createMessage({ sessionId: session.id, turnId: turn.id, role: "system" });
      for (const item of options.mailboxItems ?? []) {
        this.store.addPart({
          sessionId: session.id,
          turnId: turn.id,
          messageId: contextMessage.id,
          type: "artifact",
          payload: backgroundCompletionArtifact(item)
        });
      }
    }
    const assistantMessage = this.store.createMessage({ sessionId: session.id, turnId: turn.id, role: "assistant" });
    const startedEvents = this.store.listEvents(session.id);
    if (!this.firedSessionStart.has(session.id)) {
      this.firedSessionStart.add(session.id);
      await this.fireHooks(session, "session.start", undefined, {});
    }
    if (source === "user") await this.fireHooks(session, "user.prompt", undefined, { text: input });
    const lower = input.toLowerCase();
    let response = "";

    if (source === "user" && input.trimStart().startsWith("!")) {
      const command = input.trimStart().slice(1).trim();
      if (!command) {
        response = "Usage: !<command>";
      } else {
        await this.runTool(session, "shell_exec", { command }, { turn, assistantMessage });
        response = "Shell command submitted.";
      }
      this.persistTextPart(session.id, turn.id, assistantMessage.id, response);
      this.stopTurn(turn, "completed", "final_response");
    } else if (source === "user" && lower.startsWith("/")) {
      response = await this.handleSlash(session, turn, assistantMessage, input);
      this.persistTextPart(session.id, turn.id, assistantMessage.id, response);
      this.stopTurn(turn, "completed", "final_response");
    } else {
      response = await this.runAgentLoop(session, turn, contextMessage, assistantMessage, input, source === "user", options.mailboxItems);
    }

    if (source === "user" && !this.shuttingDown && this.store.loadTurn(turn.id).status !== "cancelled") {
      void this.mailboxDispatcher.wakeQueuedInputs(session.id);
    }

    const cursor = startedEvents.at(-1)?.sequence ?? 0;
    return {
      session,
      response,
      events: this.store.listEventsAfter(session.id, cursor, 10_000)
    };
  }

  private async runAgentLoop(
    session: Session,
    turn: Turn,
    contextMessage: Message,
    assistantMessage: Message,
    input: string | undefined,
    userAuthored = true,
    mailboxItems: SessionMailboxItem[] = []
  ): Promise<string> {
    const responses: string[] = [];
    let planner: PlannerProvider;
    let chatProvider: ChatProvider | undefined;
    if (this.planner) {
      planner = this.planner;
    } else {
      chatProvider = this.chatProviderOverride ?? await createChatProviderForSession(session, this.workspace);
      planner = new ChatProviderPlanner(chatProvider);
    }
    this.store.updateTurn(turn.id, {
      plannerName: planner.name,
      provider: session.provider ?? planner.name,
      ...(session.model ? { model: session.model } : {})
    });

    let autoContinueStreak = 0;
    let resumeAfterCompaction = false;
    const maxSteps = this.maxSteps;
    const maxTurnMs = this.maxTurnMs;
    const loopStartedAt = Date.now();
    let timeBudgetWarned = false;
    let loopError: string | undefined;
    let lastProgress = this.progressSnapshot(session.id, turn.id);
    let stepsSinceProgress = 0;
    let lastSteerStep = Number.NEGATIVE_INFINITY;
    let loopSupervisionWarnings = 0;
    let lastProviderContextHash = this.latestProviderContextHash(session.id);
    try {
    for (let step = 0; ; step++) {
      let providerSlotReady = step === 0;
      const current = this.store.loadTurn(turn.id);
      if (current.status === "cancelled") {
        const text = "Turn cancelled.";
        responses.push(text);
        this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "error", payload: { text } });
        this.event(session.id, "loop_stop", { turnId: turn.id, reason: "cancelled" });
        return responses.join("\n");
      }
      session = this.store.loadSession(session.id);
      const elapsedMs = Date.now() - loopStartedAt;
      if (step > 0 && elapsedMs >= maxTurnMs) {
        responses.push(...await this.forceTimeLimitWrapUp(session, turn, assistantMessage, planner, maxTurnMs));
        break;
      }
      if (Number.isFinite(maxTurnMs) && !timeBudgetWarned && elapsedMs >= maxTurnMs * 0.75) {
        timeBudgetWarned = true;
        const secondsLeft = Math.max(1, Math.ceil((maxTurnMs - elapsedMs) / 1_000));
        const queue = this.pendingSteeringContext.get(session.id) ?? [];
        queue.push(`The interactive turn has about ${secondsLeft} seconds left. Prioritize the highest-value remaining action, preserve evidence, and conclude cleanly instead of starting broad new work.`);
        this.pendingSteeringContext.set(session.id, queue);
      }
      this.store.updateTurn(turn.id, { stepCount: step + 1 });
      if (step >= maxSteps) {
        responses.push(...await this.forceStepLimitWrapUp(session, turn, assistantMessage, planner, maxSteps));
        break;
      }
      const compactResult = await this.maybeAutoCompact(session, planner);
      if (compactResult.status === "ineffective") {
        const text = `Auto-compaction did not reduce active context (${compactResult.preTokens} -> ${compactResult.postTokens} estimated tokens); no provider request was sent.`;
        this.event(session.id, "planner_error", { turnId: turn.id, planner: planner.name, error: text, recoverable: false });
        if (userAuthored) {
          responses.push(text);
          this.persistTextPart(session.id, turn.id, assistantMessage.id, text);
          this.event(session.id, "text", { role: "assistant", text, planner: planner.name });
        }
        this.stopTurn(turn, "failed", "context_budget", text);
        break;
      }
      if (compactResult.status === "compacted") {
        resumeAfterCompaction = true;
        session = this.store.loadSession(session.id);
        ({ contextMessage, assistantMessage } = this.createProviderSlot(session, turn));
        providerSlotReady = true;
        lastProviderContextHash = undefined;
      }
      await this.refreshMcp(session).catch((error) => {
        this.event(session.id, "planner_error", {
          turnId: turn.id,
          planner: planner.name,
          error: `MCP refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          recoverable: true
        });
      });
      const injectedSlot = this.drainPendingUserInput(session, turn);
      if (injectedSlot) {
        ({ contextMessage, assistantMessage } = injectedSlot);
        providerSlotReady = true;
      }
      if (step > 0 && !providerSlotReady) {
        ({ contextMessage, assistantMessage } = this.createProviderSlot(session, turn));
      }
      if (step > 0) {
        const progress = this.progressSnapshot(session.id, turn.id);
        if (progress > lastProgress) { lastProgress = progress; stepsSinceProgress = 0; loopSupervisionWarnings = 0; }
        else stepsSinceProgress += 1;
        const repeating = this.repeatedToolSignature(session.id, turn.id);
        if ((repeating || stepsSinceProgress >= LOOP_SUPERVISION_NO_PROGRESS_STEPS) && step - lastSteerStep >= LOOP_SUPERVISION_STEER_INTERVAL) {
          lastSteerStep = step;
          stepsSinceProgress = 0;
          loopSupervisionWarnings += 1;
          this.maybeSteerStalledLoop(session, repeating);
          this.event(session.id, "loop_supervision", {
            turnId: turn.id,
            planner: planner.name,
            warning: loopSupervisionWarnings,
            cause: repeating ? "repeated_tool" : "no_progress",
            action: "steer"
          });
        }
      }
      const availableTools = listToolsForSession(session);
      const backgroundCompletion = step === 0 && input && !userAuthored
        ? `${input}\n\nThis completion is already terminal and was delivered automatically. Do not call session_poll for this job or process. Briefly report the outcome only when useful; otherwise return no visible text.`
        : undefined;
      const passiveCompletions = step === 0 && userAuthored && mailboxItems.length > 0
        ? renderMailboxItems(mailboxItems)
        : undefined;
      const mcpUsageMetadata = renderMcpServerInstructionContext(
        listMcpServerStatuses(session),
        availableTools.map((tool) => tool.name)
      );
      const context = this.assembleContext({
        session,
        ...(step === 0 && input && userAuthored && !resumeAfterCompaction ? { userText: input } : {}),
        availableTools,
        contextWindow: resolveContextWindow(planner.contextWindow),
        maxOutputTokens: resolveMaxOutputTokens(planner.maxOutputTokens),
        ...this.contextBudgetInput(),
        toolsEnabled: true,
        extraBlocks: [
          ...(mcpUsageMetadata ? [{ id: "mcp-server-usage-metadata", title: "MCP Server Usage Metadata", body: mcpUsageMetadata, stable: true }] : []),
          ...(passiveCompletions ? [{ title: "Completed Background Work", body: passiveCompletions, stable: false }] : []),
          ...(backgroundCompletion ? [{ title: "Background Completion", body: backgroundCompletion, stable: false }] : []),
          ...this.drainSteeringContext(session.id),
          ...this.drainHookContext(session.id)
        ]
      }, contextMessage);
      if (context.manifest.overBudget) {
        const text = `Context request ${context.manifest.estimatedTokens} tokens exceeds the hard ${context.manifest.requestBudget}-token budget after trimming; no provider request was sent.`;
        this.event(session.id, "planner_error", { turnId: turn.id, planner: planner.name, error: text, recoverable: false });
        if (userAuthored) {
          responses.push(text);
          this.persistTextPart(session.id, turn.id, assistantMessage.id, text);
          this.event(session.id, "text", { role: "assistant", text, planner: planner.name });
        }
        this.stopTurn(turn, "failed", "context_budget", text);
        break;
      }
      const costBudgetError = chatProvider ? this.costBudgetError(session, chatProvider, context.manifest) : undefined;
      if (costBudgetError) {
        this.event(session.id, "planner_error", { turnId: turn.id, planner: planner.name, error: costBudgetError, recoverable: false });
        if (userAuthored) {
          responses.push(costBudgetError);
          this.persistTextPart(session.id, turn.id, assistantMessage.id, costBudgetError);
          this.event(session.id, "text", { role: "assistant", text: costBudgetError, planner: planner.name });
        }
        this.stopTurn(turn, "failed", "cost_budget", costBudgetError);
        break;
      }
      const capturedContext = this.captureProviderContext(session, turn, contextMessage, context.volatileContext, lastProviderContextHash);
      if (capturedContext) lastProviderContextHash = capturedContext.hash;
      const history = [
        ...context.history,
        ...(capturedContext ? [{ role: "context" as const, text: capturedContext.text }] : []),
        ...(resumeAfterCompaction ? [{ role: "user" as const, text: AUTO_COMPACTION_CONTINUATION }] : [])
      ];
      const plannerInput: PlannerInput = {
        session,
        ...(step === 0 && input && userAuthored && !resumeAfterCompaction ? { userText: input } : {}),
        history,
        ...(session.summary ? { compactedSummary: session.summary } : {}),
        contextBlocks: context.contextBlocks,
        tools: context.tools,
        toolCatalog: context.toolCatalog,
        toolChoice: "auto"
      };
      resumeAfterCompaction = false;
      const autoContinue = { streak: autoContinueStreak };
      const remainingTurnMs = Number.isFinite(maxTurnMs)
        ? Math.max(0, maxTurnMs - (Date.now() - loopStartedAt))
        : undefined;
      const control = chatProvider
        ? await this.streamStep(chatProvider, plannerInput, session, turn, assistantMessage, planner.name, step, context.manifest, responses, autoContinue, userAuthored, remainingTurnMs)
        : await this.batchStep(planner, plannerInput, session, turn, assistantMessage, step, context.manifest, responses, autoContinue, userAuthored, remainingTurnMs);
      autoContinueStreak = autoContinue.streak;
      if (control.cancelled) return responses.join("\n");
      if (control.timedOut) {
        responses.push(...await this.forceTimeLimitWrapUp(session, turn, assistantMessage, planner, maxTurnMs));
        break;
      }
      if (control.empty) {
        if (userAuthored) {
          const text = "No further action selected.";
          responses.push(text);
          this.persistTextPart(session.id, turn.id, assistantMessage.id, text);
          this.event(session.id, "text", { role: "assistant", text, planner: planner.name });
        }
        this.stopTurn(turn, "completed", "no_actions");
        break;
      }
      if (!control.shouldContinue) {
        if (this.mailbox.hasQueued(session.id, "interrupt")) continue;
        this.stopTurn(turn, "completed", "final_response");
        break;
      }
    }

    if (responses.length === 0 && this.store.loadTurn(turn.id).status === "running") {
      if (userAuthored && !this.turnHasTranscriptOwnedActivity(session.id, turn.id)) {
        const text = "Completed without model-visible response.";
        responses.push(text);
        this.persistTextPart(session.id, turn.id, assistantMessage.id, text);
        this.stopTurn(turn, "completed", "final_response");
      } else {
        this.stopTurn(turn, "completed", "no_actions");
      }
    }
    } catch (error) {
      loopError = error instanceof Error ? error.message : String(error);
      const text = `Agent loop error: ${loopError}`;
      responses.push(text);
      try {
        this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "error", payload: { text } });
      } catch {  }
      this.event(session.id, "error", { turnId: turn.id, error: loopError });
    } finally {
      const finalTurn = this.store.loadTurn(turn.id);
      if (finalTurn.status === "running") {
        this.stopTurn(turn, "failed", "planner_error", loopError ?? "agent loop ended without a terminal state");
      }
    }
    return responses.join("\n");
  }

  private turnHasTranscriptOwnedActivity(sessionId: string, turnId: string): boolean {
    return this.store.listToolCalls(sessionId, 10_000).some((call) => {
      if (call.turnId !== turnId || !["agent_task", "agent_spawn", "agent_followup"].includes(call.tool)) return false;
      if (!call.args || typeof call.args !== "object" || Array.isArray(call.args)) return false;
      return (call.args as Record<string, unknown>).mode === "detached";
    });
  }

  private costBudgetError(session: Session, provider: ChatProvider, context: ContextManifest): string | undefined {
    if (this.maxCostUsd === undefined) return undefined;
    const rootSessionId = this.rootSessionId(session);
    const spent = this.store.usageSummaryTree(rootSessionId).totalCost;
    if (!provider.pricing) {
      return `cost budget blocked the next model request because pricing is unavailable for ${provider.model ?? session.model ?? provider.name}; no provider request was sent.`;
    }
    const projected = estimateMaximumRequestCost(
      context.estimatedTokens,
      resolveMaxOutputTokens(provider.maxOutputTokens),
      provider.pricing
    );
    if (spent + projected <= this.maxCostUsd) return undefined;
    return `cost budget blocked the next model request: $${spent.toFixed(6)} spent + up to $${projected.toFixed(6)} projected exceeds the hard $${this.maxCostUsd.toFixed(6)} run cap.`;
  }

  private rootSessionId(session: Session): string {
    let current = session;
    const visited = new Set<string>();
    while (current.parentId && !visited.has(current.id)) {
      visited.add(current.id);
      current = this.store.loadSession(current.parentId);
    }
    return current.id;
  }

  private persistModelUsage(provider: ChatProvider, session: Session, turn: Turn, usage: UsageTokenCounts | undefined, latencyMs: number): void {
    if (!usage) return;
    const cost = provider.pricing ? calculateUsageCost(usage, provider.pricing, provider.protocol) : 0;
    const normalized = normalizeUsageTokenCounts(usage, provider.protocol);
    this.store.saveUsage({
      sessionId: session.id,
      turnId: turn.id,
      provider: provider.name,
      model: provider.model ?? session.model ?? provider.name,
      inputTokens: normalized.inputTokens,
      outputTokens: normalized.outputTokens,
      cachedInputTokens: normalized.cachedInputTokens,
      cacheWriteInputTokens: normalized.cacheWriteInputTokens,
      ...(provider.pricing ? { pricing: provider.pricing } : {}),
      cost,
      latencyMs
    });
  }

  private async batchStep(
    planner: PlannerProvider,
    plannerInput: PlannerInput,
    session: Session,
    turn: Turn,
    assistantMessage: Message,
    step: number,
    context: ContextManifest,
    responses: string[],
    autoContinue: { streak: number },
    userAuthored: boolean,
    modelTimeoutMs?: number
  ): Promise<StepControl> {
    let actions: PlannerAction[];
    try {
      actions = await this.planWithRetry(planner, plannerInput, session, turn, assistantMessage, context, modelTimeoutMs, !userAuthored);
    } catch (error) {
      if (error instanceof ModelCallDeadlineError) return { timedOut: true, shouldContinue: false };
      throw error;
    }
    if (this.store.loadTurn(turn.id).status === "cancelled") return { cancelled: true, shouldContinue: false };
    if (actions.length === 0) return { empty: true, shouldContinue: false };
    let shouldContinue = false;
    let sawResponse = false;
    const hasToolAction = actions.some((action) => action.kind === "tool");
    const toolBatch: ToolPlannerAction[] = [];
    const flushToolBatch = async (): Promise<boolean> => {
      if (toolBatch.length === 0) return false;
      if (this.store.loadTurn(turn.id).status === "cancelled") { toolBatch.splice(0); return true; }
      const batch = toolBatch.splice(0);
      const outcomes = await Promise.all(batch.map((action) =>
        this.executePlannerToolAction(session, turn, assistantMessage, planner.name, action, step, sawResponse)
      ));
      for (const outcome of outcomes) {
        if (outcome.shouldContinue) shouldContinue = true;
        if (outcome.resetAutoContinue) autoContinue.streak = 0;
        if (outcome.cancelled) return true;
      }
      return false;
    };

    for (const action of actions) {
      if (action.kind === "tool") {
        toolBatch.push(action);
        continue;
      }
      if (await flushToolBatch()) return { cancelled: true, shouldContinue };
      if (action.kind === "reasoning") {
        this.finalizeReasoning(session, turn, assistantMessage, planner.name, action.text);
      } else if (action.kind === "respond") {
        sawResponse = true;
        if (hasToolAction && isInternalMetaReasoning(action.text)) {
          this.discardStreamingText(session.id, turn.id);
          shouldContinue = true;
          continue;
        }
        if (await this.applyRespond(session, turn, assistantMessage, planner.name, action.text, action.truncated ?? false, action.recoverable ?? false, responses, autoContinue)) shouldContinue = true;
      } else if (action.kind === "tool_parse_error") {
        this.recordToolParseError(session, turn, assistantMessage, step, action.toolCallId, action.tool, action.error, action.rawArguments);
        if (!sawResponse) shouldContinue = true;
      }
    }
    if (await flushToolBatch()) return { cancelled: true, shouldContinue };
    return { shouldContinue };
  }

  private async streamStep(
    provider: ChatProvider,
    plannerInput: PlannerInput,
    session: Session,
    turn: Turn,
    assistantMessage: Message,
    plannerName: string,
    step: number,
    context: ContextManifest,
    responses: string[],
    autoContinue: { streak: number },
    userAuthored: boolean,
    modelTimeoutMs?: number
  ): Promise<StepControl> {
    const { signal, release, timedOut } = this.registerTurnController(turn.id, modelTimeoutMs);
    const requestController = new AbortController();
    const relayTurnAbort = () => requestController.abort(signal.reason);
    if (signal.aborted) relayTurnAbort();
    else signal.addEventListener("abort", relayTurnAbort, { once: true });
    const request = buildChatRequest(plannerInput, requestController.signal);
    const providerLimits = providerResponseLimits(provider.maxOutputTokens);
    let lastError = "";
    this.deleteStreamingParts(turn.id);
    try {
      for (let attempt = 1; ; attempt += 1) {
        this.emitPlannerAttempt(session, turn, assistantMessage, plannerName, attempt, plannerInput, context);
        const dispatched: Array<Promise<ToolActionOutcome>> = [];
        const content = new BoundedTextAccumulator(providerLimits.contentBytes, "provider content", providerLimits.sseEvents);
        const reasoning = new BoundedTextAccumulator(providerLimits.reasoningBytes, "provider reasoning", providerLimits.sseEvents);
        let finishReason: string | undefined;
        let usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number } | undefined;
        const requestStarted = Date.now();
        let sawParseError = false;
        let interrupted = false;
        let providerEvents = 0;
        try {
          const iterator = provider.stream(request)[Symbol.asyncIterator]();
          for (;;) {
            const steering = this.waitForSteering(session.id);
            let next: IteratorResult<import("./provider/protocol").ProviderStreamEvent>;
            try {
              if (this.mailbox.hasQueued(session.id, "interrupt")) {
                interrupted = true;
                requestController.abort("steered by user");
                break;
              }
              const outcome = await Promise.race([
                abortablePromise(iterator.next(), signal).then((value) => ({ kind: "stream" as const, value })),
                steering.promise.then(() => ({ kind: "steer" as const }))
              ]);
              if (outcome.kind === "steer") {
                interrupted = true;
                requestController.abort("steered by user");
                break;
              }
              next = outcome.value;
            } finally {
              steering.cancel();
            }
            if (next.done) break;
            const event = next.value;
            providerEvents += 1;
            if (providerEvents > providerLimits.sseEvents) throw new Error(`provider stream exceeded the ${providerLimits.sseEvents}-event limit`);
            if (signal.aborted || this.store.loadTurn(turn.id).status === "cancelled") break;
            if (this.mailbox.hasQueued(session.id, "interrupt")) { interrupted = true; break; }
            if (event.type === "text_delta") {
              content.append(event.delta);
              this.applyStreamEvent(session, turn, assistantMessage, { kind: "text", delta: event.delta });
            } else if (event.type === "reasoning_delta") {
              reasoning.append(event.delta);
            } else if (event.type === "tool_call_delta") {
              assertProviderToolIndex(event.index, providerLimits.toolCalls);
              this.applyToolInputPreview(session.id, turn.id, event);
            } else if (event.type === "tool_call_complete") {
              assertProviderToolIndex(event.index, providerLimits.toolCalls);
              new BoundedTextAccumulator(providerLimits.toolArgumentsBytes, "provider tool arguments").append(event.arguments);
              this.finishToolInputPreview(session.id, turn.id, event.index, event.id, event.arguments);
              const toolCallId = event.id || undefined;
              const toolName = canonicalToolName(event.name);
              if (!toolName) {
                sawParseError = true;
                const error = "Provider emitted a tool call without a valid name.";
                const payload = { turnId: turn.id, step, tool: "tool", error, recoverable: true };
                this.event(session.id, "planner_error", payload);
                this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "planner_error", payload });
                continue;
              }
              let args: unknown;
              try {
                const parsed = JSON.parse(event.arguments || "{}") as unknown;
                args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
              } catch (error) {
                sawParseError = true;
                this.recordToolParseError(session, turn, assistantMessage, step, toolCallId ?? toolName, toolName, error instanceof Error ? error.message : String(error), event.arguments);
                continue;
              }
              const action: ToolPlannerAction = { kind: "tool", tool: toolName, args, rationale: "", ...(toolCallId ? { toolCallId } : {}) };
              dispatched.push(this.executePlannerToolAction(session, turn, assistantMessage, plannerName, action, step, false));
            } else if (event.type === "message_complete") {
              finishReason = event.finishReason;
            } else if (event.type === "usage") {
              usage = {
                ...usage,
                ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
                ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
                ...(event.cachedInputTokens !== undefined ? { cachedInputTokens: event.cachedInputTokens } : {}),
                ...(event.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: event.cacheWriteInputTokens } : {})
              };
            } else if (event.type === "error") {
              throw new PlannerHttpError(event.message, event.status ?? 0, event.retryAfterMs);
            }
          }
          if (signal.aborted || interrupted) void iterator.return?.();
        } catch (error) {
          this.persistModelUsage(provider, session, turn, usage, Date.now() - requestStarted);
          const outcomes = await Promise.allSettled(dispatched);
          this.clearToolInputPreviews(session.id, turn.id);
          lastError = error instanceof Error ? error.message : String(error);
          if (signal.aborted || this.store.loadTurn(turn.id).status === "cancelled") {
            const shouldContinue = this.collectOutcomes(outcomes, autoContinue);
            return timedOut()
              ? { timedOut: true, shouldContinue }
              : { cancelled: true, shouldContinue };
          }
          this.prepareStreamingRetry(session.id, turn.id);
          const retry = plannerRetryState(error, attempt, dispatched.length === 0);
          const errorPayload = {
            turnId: turn.id,
            planner: plannerName,
            attempt,
            maxAttempts: retry.maxAttempts,
            error: lastError,
            recoverable: retry.willRetry,
            ...(retry.willRetry ? {
              retrying: true,
              retryReason: retry.reason,
              nextAttempt: attempt + 1,
              retryDelayMs: retry.delayMs,
              nextRetryAt: Date.now() + retry.delayMs
            } : {})
          };
          this.event(session.id, "planner_error", errorPayload);
          this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "planner_error", payload: errorPayload });
          if (retry.willRetry) {
            await abortableSleep(retry.delayMs, signal);
            if (signal.aborted || this.store.loadTurn(turn.id).status === "cancelled") {
              return timedOut()
                ? { timedOut: true, shouldContinue: false }
                : { cancelled: true, shouldContinue: false };
            }
          }
          if (retry.willRetry) continue;
          this.store.updateTurn(turn.id, { errorSummary: lastError });
          const shouldContinueOnError = this.collectOutcomes(outcomes, autoContinue);
          const applied = await this.applyRespond(session, turn, assistantMessage, plannerName, `planner error: ${lastError}`, false, false, responses, autoContinue);
          return { shouldContinue: shouldContinueOnError || applied };
        }

        if (signal.aborted || this.store.loadTurn(turn.id).status === "cancelled") {
          await Promise.allSettled(dispatched);
          this.clearToolInputPreviews(session.id, turn.id);
          return timedOut()
            ? { timedOut: true, shouldContinue: false }
            : { cancelled: true, shouldContinue: false };
        }

        if (usage) {
          this.persistModelUsage(provider, session, turn, usage, Date.now() - requestStarted);
        }
        let shouldContinue = false;
        const completeReasoning = reasoning.text();
        const reasoningText = completeReasoning.trim() ? takeBytes(completeReasoning.trim(), REASONING_MAX_BYTES, "head") : undefined;
        if (reasoningText) this.finalizeReasoning(session, turn, assistantMessage, plannerName, reasoningText);
        const rawRespondText = content.text().trim();
        const respondText = dispatched.length > 0 && isInternalMetaReasoning(rawRespondText) ? "" : rawRespondText;
        if (!respondText && rawRespondText && dispatched.length > 0) this.discardStreamingText(session.id, turn.id);
        const outcomes = await Promise.all(dispatched);
        const toolCancelled = outcomes.some((outcome) => outcome.cancelled);
        for (const outcome of outcomes) {
          if (outcome.shouldContinue) shouldContinue = true;
          if (outcome.resetAutoContinue) autoContinue.streak = 0;
        }
        if (toolCancelled || signal.aborted || this.store.loadTurn(turn.id).status === "cancelled") {
          this.clearToolInputPreviews(session.id, turn.id);
          return timedOut()
            ? { timedOut: true, shouldContinue }
            : { cancelled: true, shouldContinue };
        }
        const truncated = finishReason === "length";
        if (respondText) {
          if (await this.applyRespond(session, turn, assistantMessage, plannerName, respondText, truncated, false, responses, autoContinue)) shouldContinue = true;
        } else if (dispatched.length === 0 && !sawParseError && !reasoningText && userAuthored) {
          const fallback = "Completed without model-visible response.";
          if (await this.applyRespond(session, turn, assistantMessage, plannerName, fallback, truncated, true, responses, autoContinue)) shouldContinue = true;
        } else if (respondText === "" && dispatched.length === 0 && !sawParseError && reasoningText) {
          if (await this.applyRespond(session, turn, assistantMessage, plannerName, reasoningText, truncated, true, responses, autoContinue)) shouldContinue = true;
        }
        if (sawParseError) shouldContinue = true;
        if (interrupted) shouldContinue = true;
        this.clearToolInputPreviews(session.id, turn.id);
        return { shouldContinue };
      }
    } finally {
      signal.removeEventListener("abort", relayTurnAbort);
      release();
    }
  }

  private applyToolInputPreview(
    sessionId: string,
    turnId: string,
    event: Extract<import("./provider/protocol").ProviderStreamEvent, { type: "tool_call_delta" }>
  ): void {
    const key = `${turnId}:${event.index}`;
    const existing = this.toolInputPreviews.get(key);
    const current = existing ?? { name: "", arguments: "", bytes: 0, truncated: false };
    if (event.id) current.id = event.id;
    if (event.name) current.name = event.name;
    if (event.argumentsDelta) {
      const remaining = PROVIDER_TOOL_PREVIEW_MAX_BYTES - current.bytes;
      const retained = utf8Prefix(event.argumentsDelta, remaining);
      current.arguments += retained;
      current.bytes += Buffer.byteLength(retained, "utf8");
      if (retained !== event.argumentsDelta) current.truncated = true;
    }
    this.toolInputPreviews.set(key, current);
    this.store.publishTransientEvent({
      id: `preview:${key}`,
      sessionId,
      type: existing ? "tool_input_delta" : "tool_input_start",
      payload: {
        previewId: `preview:${key}`,
        turnId,
        index: event.index,
        providerToolCallId: current.id,
        tool: current.name,
        rawArguments: current.arguments
      },
      createdAt: nowIso()
    });
  }

  private finishToolInputPreview(sessionId: string, turnId: string, index: number, providerToolCallId?: string, finalArguments?: string): void {
    const key = `${turnId}:${index}`;
    const current = this.toolInputPreviews.get(key);
    this.toolInputPreviews.delete(key);
    const rawArguments = finalArguments === undefined
      ? current?.arguments ?? ""
      : utf8Prefix(finalArguments, PROVIDER_TOOL_PREVIEW_MAX_BYTES);
    this.store.publishTransientEvent({
      id: `preview:${key}`,
      sessionId,
      type: "tool_input_end",
      payload: {
        previewId: `preview:${key}`,
        turnId,
        index,
        providerToolCallId: providerToolCallId || current?.id,
        tool: current?.name ?? "",
        rawArguments
      },
      createdAt: nowIso()
    });
  }

  private clearToolInputPreviews(sessionId: string, turnId: string): void {
    for (const key of [...this.toolInputPreviews.keys()]) {
      if (!key.startsWith(`${turnId}:`)) continue;
      const index = Number(key.slice(turnId.length + 1));
      this.finishToolInputPreview(sessionId, turnId, index);
    }
  }

  private collectOutcomes(outcomes: Array<PromiseSettledResult<ToolActionOutcome>>, autoContinue: { streak: number }): boolean {
    let shouldContinue = false;
    for (const settled of outcomes) {
      if (settled.status !== "fulfilled") continue;
      if (settled.value.shouldContinue) shouldContinue = true;
      if (settled.value.resetAutoContinue) autoContinue.streak = 0;
    }
    return shouldContinue;
  }

  private emitPlannerAttempt(session: Session, turn: Turn, assistantMessage: Message, plannerName: string, attempt: number, input: PlannerInput, context?: ContextManifest): void {
    const attemptPayload = this.plannerAttemptPayload(turn, plannerName, attempt, input, context);
    this.event(session.id, "planner_attempt", attemptPayload);
    this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "planner_attempt", payload: attemptPayload });
  }

  private plannerAttemptPayload(turn: Turn, plannerName: string, attempt: number, input: PlannerInput, context?: ContextManifest): Record<string, unknown> {
    const modelCall = (this.modelCallsByTurn.get(turn.id) ?? 0) + 1;
    this.modelCallsByTurn.set(turn.id, modelCall);
    return {
      turnId: turn.id,
      planner: plannerName,
      attempt,
      modelCall,
      step: this.store.loadTurn(turn.id).stepCount,
      request: (input.userText ?? "continue").slice(0, 240),
      ...(context ? {
        contextTokens: context.estimatedTokens,
        contextWindow: context.contextWindow,
        contextBudget: context.requestBudget,
        contextFragments: context.admitted,
        omittedContextFragments: context.omitted,
        directTools: context.tools.direct
      } : {})
    };
  }

  private finalizeReasoning(session: Session, turn: Turn, assistantMessage: Message, plannerName: string, text: string): void {
    const rationale = normalizeReasoningSummary(text);
    const state = this.streamingParts.get(turn.id);
    if (!rationale) {
      if (state?.reasoningPartId) this.store.updatePartPayload(state.reasoningPartId, { planner: plannerName, rationale: "" });
      if (state) {
        state.reasoningAccum = "";
        this.publishStreamingReasoning(session.id, turn.id, state);
        delete state.reasoningPartId;
        delete state.reasoningAccum;
        delete state.lastReasoningPersist;
      }
      return;
    }
    this.event(session.id, "reasoning_summary", { planner: plannerName, rationale });
    if (state?.reasoningPartId) {
      state.reasoningAccum = rationale;
      this.publishStreamingReasoning(session.id, turn.id, state);
      this.store.updatePartPayload(state.reasoningPartId, { planner: plannerName, rationale });
      delete state.reasoningPartId;
      delete state.reasoningAccum;
      delete state.lastReasoningPersist;
    } else {
      this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "reasoning_summary", payload: { planner: plannerName, rationale } });
    }
  }

  private async applyRespond(session: Session, turn: Turn, assistantMessage: Message, plannerName: string, text: string, truncated: boolean, recoverable: boolean, responses: string[], autoContinue: { streak: number }): Promise<boolean> {
    responses.push(text);
    const streamed = this.streamingParts.get(turn.id);
    if (streamed?.textPartId) {
      streamed.textAccum = text;
      this.publishStreamingText(session.id, turn.id, streamed);
      this.store.updatePartPayload(streamed.textPartId, { text });
      delete streamed.textPartId;
      streamed.textAccum = "";
    } else {
      this.persistTextPart(session.id, turn.id, assistantMessage.id, text);
    }
    this.event(session.id, "text", { role: "assistant", text, planner: plannerName, truncated, recoverable });
    if (truncated || recoverable) {
      autoContinue.streak += 1;
      return true;
    }
    return false;
  }

  private recordToolParseError(session: Session, turn: Turn, assistantMessage: Message, step: number, toolCallId: string, tool: string, error: string, rawArguments: string): void {
    const text = `Could not parse arguments for ${tool}: ${error}. Raw: ${rawArguments.slice(0, 500)}`;
    this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "tool_call", payload: { record: { id: toolCallId, tool, args: {} } } });
    this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "tool_result", payload: { toolCallId, tool, result: text } });
    const payload = { turnId: turn.id, step, tool, error: text, recoverable: true };
    this.event(session.id, "planner_error", payload);
    this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "planner_error", payload });
  }

  private async forceStepLimitWrapUp(
    session: Session,
    turn: Turn,
    assistantMessage: Message,
    planner: PlannerProvider,
    maxSteps: number
  ): Promise<string[]> {
    return this.forceTextOnlyWrapUp({
      session,
      turn,
      assistantMessage,
      planner,
      notice: `(Reached the ${maxSteps}-step limit for this turn — stopping and summarizing. Raise max_steps in ~/.local/pajarori/farai/config.toml to allow longer runs.)`,
      directive: STEP_LIMIT_WRAPUP_DIRECTIVE,
      stopReason: "step_limit"
    });
  }

  private async forceTimeLimitWrapUp(
    session: Session,
    turn: Turn,
    assistantMessage: Message,
    planner: PlannerProvider,
    maxTurnMs: number
  ): Promise<string[]> {
    const minutes = Math.max(1, Math.round(maxTurnMs / 60_000));
    return this.forceTextOnlyWrapUp({
      session,
      turn,
      assistantMessage,
      planner,
      notice: `(Reached the ${minutes}-minute interactive turn limit — stopping and summarizing. Raise max_turn_seconds in ~/.local/pajarori/farai/config.toml for longer runs.)`,
      directive: TIME_LIMIT_WRAPUP_DIRECTIVE,
      stopReason: "time_limit"
    });
  }

  private async forceTextOnlyWrapUp(input: {
    session: Session;
    turn: Turn;
    assistantMessage: Message;
    planner: PlannerProvider;
    notice: string;
    directive: string;
    stopReason: "step_limit" | "time_limit";
  }): Promise<string[]> {
    const responses: string[] = [];
    responses.push(input.notice);
    this.persistTextPart(input.session.id, input.turn.id, input.assistantMessage.id, input.notice);
    this.event(input.session.id, "text", { role: "assistant", text: input.notice, planner: input.planner.name });

    const projection = this.assembleContext({
      session: input.session,
      userText: input.directive,
      availableTools: listToolsForSession(input.session),
      contextWindow: resolveContextWindow(input.planner.contextWindow),
      maxOutputTokens: resolveMaxOutputTokens(input.planner.maxOutputTokens),
      ...this.contextBudgetInput(),
      toolsEnabled: false
    });
    if (projection.manifest.overBudget) {
      const fallback = "Stopped safely because the final text-only request could not fit the configured context budget.";
      responses.push(fallback);
      this.persistTextPart(input.session.id, input.turn.id, input.assistantMessage.id, fallback);
      this.event(input.session.id, "text", { role: "assistant", text: fallback, planner: input.planner.name });
      this.stopTurn(input.turn, "completed", input.stopReason);
      return responses;
    }
    const history = [
      ...projection.history,
      ...(projection.volatileContext ? [{ role: "context" as const, text: projection.volatileContext }] : [])
    ];
    history.push({ role: "user", text: input.directive });
    const plannerInput: PlannerInput = {
      session: input.session,
      userText: input.directive,
      history,
      ...(input.session.summary ? { compactedSummary: input.session.summary } : {}),
      contextBlocks: projection.contextBlocks,
      tools: projection.tools,
      toolCatalog: projection.toolCatalog,
      toolChoice: "none"
    };
    let actions: PlannerAction[] = [];
    try {
      actions = await this.planWithRetry(
        input.planner,
        plannerInput,
        input.session,
        input.turn,
        input.assistantMessage,
        projection.manifest,
        WRAPUP_MODEL_TIMEOUT_MS
      );
    } catch (error) {
      this.event(input.session.id, "planner_error", {
        turnId: input.turn.id,
        planner: input.planner.name,
        error: `Final text-only wrap-up failed: ${error instanceof Error ? error.message : String(error)}`,
        recoverable: false
      });
    }
    let responded = false;
    const autoContinue = { streak: 0 };
    for (const action of actions) {
      if (action.kind === "reasoning") {
        this.finalizeReasoning(input.session, input.turn, input.assistantMessage, input.planner.name, action.text);
      } else if (action.kind === "respond") {
        responded = true;
        await this.applyRespond(
          input.session,
          input.turn,
          input.assistantMessage,
          input.planner.name,
          action.text,
          action.truncated ?? false,
          false,
          responses,
          autoContinue
        );
      }
    }
    if (!responded) {
      const fallback = "Stopped safely; the final model-generated status was unavailable. Review the durable transcript, evidence, and active jobs before continuing.";
      await this.applyRespond(input.session, input.turn, input.assistantMessage, input.planner.name, fallback, false, false, responses, autoContinue);
    }
    this.stopTurn(input.turn, "completed", input.stopReason);
    return responses;
  }

  private async executePlannerToolAction(
    session: Session,
    turn: Turn,
    assistantMessage: Message,
    plannerName: string,
    action: ToolPlannerAction,
    step: number,
    sawResponse: boolean
  ): Promise<ToolActionOutcome> {
    const tool = getTool(action.tool, session);
    const scope = session.toolScope;
    if (!tool || (scope && !scope.includes(action.tool))) {
      const text = tool
        ? `Tool ${action.tool} is out of scope for this subagent lane; use only: ${scope!.join(", ")}`
        : `Planner requested unknown tool: ${action.tool}`;
      const toolCallId = action.toolCallId ?? action.tool;
      this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "tool_call", payload: { record: { id: toolCallId, tool: action.tool, args: action.args } } });
      this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "tool_result", payload: { toolCallId, tool: action.tool, result: text } });
      const payload = { turnId: turn.id, step, error: text, recoverable: true };
      this.event(session.id, "planner_error", payload);
      this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "planner_error", payload });
      return { shouldContinue: !sawResponse };
    }
    const validationError = validateToolArgs(tool.inputSchema, action.args);
    if (validationError) {
      const toolCallId = action.toolCallId ?? action.tool;
      const text = `Invalid arguments for ${action.tool}: ${validationError}. Re-issue the call with corrected arguments.`;
      this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "tool_call", payload: { record: { id: toolCallId, tool: action.tool, args: action.args } } });
      this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "tool_result", payload: { toolCallId, tool: action.tool, result: text } });
      const payload = { turnId: turn.id, step, tool: action.tool, error: text, recoverable: true };
      this.event(session.id, "planner_error", payload);
      this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "planner_error", payload });
      return { shouldContinue: true };
    }
    const rationale = normalizeReasoningSummary(action.rationale);
    if (rationale) {
      this.event(session.id, "reasoning_summary", { planner: plannerName, rationale });
      this.store.addPart({
        sessionId: session.id,
        turnId: turn.id,
        messageId: assistantMessage.id,
        type: "reasoning_summary",
        payload: { planner: plannerName, rationale }
      });
    }
    const gateController = this.registerTurnController(turn.id);
    try {
      const record = await this.runScheduledTool(
        session,
        action.tool,
        action.args,
        { turn, assistantMessage },
        action.toolCallId,
        gateController.signal
      );
      if (gateController.signal.aborted || this.store.loadTurn(turn.id).status === "cancelled") {
        return { shouldContinue: false, cancelled: true };
      }
      const detachedAgent = ["agent_spawn", "agent_followup"].includes(action.tool) && record.status === "running_background";
      return {
        shouldContinue: !detachedAgent && (record.status === "done" || record.status === "error" || record.status === "running_background"),
        resetAutoContinue: !detachedAgent && (record.status === "done" || record.status === "error" || record.status === "running_background")
      };
    } catch (error) {
      if (gateController.signal.aborted || this.store.loadTurn(turn.id).status === "cancelled") {
        return { shouldContinue: false, cancelled: true };
      }
      throw error;
    } finally {
      gateController.release();
    }
  }

  private estimatedActiveTokens(session: Session, planner?: PlannerProvider): number {
    const projected = this.assembleContext({
      session,
      availableTools: listToolsForSession(session),
      contextWindow: resolveContextWindow(planner?.contextWindow),
      maxOutputTokens: resolveMaxOutputTokens(planner?.maxOutputTokens),
      ...this.contextBudgetInput()
    }).manifest.estimatedTokens;
    const activeHistory = this.buildConversationHistory(session);
    const durable = estimateTokens({ summary: session.summary, history: activeHistory });
    return Math.max(projected, durable);
  }

  private progressSnapshot(sessionId: string, turnId: string): number {
    const evidence = this.store.listEvidence(sessionId).length;
    const findings = this.store.listFindings(sessionId).length;
    const notes = this.store.listNotes(sessionId).length;
    const observations = this.toolObservationSignatures(sessionId);
    const actions = new Set<string>();
    for (const call of this.store.listToolCalls(sessionId, 1_000)) {
      if (call.turnId !== turnId) continue;
      if (call.status === "error" || call.status === "pending") continue;
      const tool = canonicalToolName(call.tool);
      const observation = observations.get(call.id);
      if (observation) {
        actions.add(`${tool}:${observation}`);
        continue;
      }
      const browserAction = tool.startsWith("browser_") || tool.includes("_browser_");
      if (PROGRESS_ACTION_TOOLS.has(tool) || browserAction) actions.add(`${tool}:${stableValue(call.args)}`);
    }
    return evidence + findings + notes + actions.size;
  }

  private repeatedToolSignature(sessionId: string, turnId: string): boolean {
    const observations = this.toolObservationSignatures(sessionId);
    const signatures = this.store.listToolCalls(sessionId, LOOP_PATTERN_MAX_PERIOD * 2)
      .filter((call) => call.turnId === turnId && call.status !== "pending")
      .map((call) => `${canonicalToolName(call.tool)}:${observations.get(call.id) ?? stableValue(call.args)}`);
    for (let period = 1; period <= Math.min(LOOP_PATTERN_MAX_PERIOD, Math.floor(signatures.length / 2)); period += 1) {
      const repetitions = period <= 2 ? 3 : 2;
      const required = period * repetitions;
      if (signatures.length < required) continue;
      const pattern = signatures.slice(0, period);
      if (period > 1 && new Set(pattern).size === 1) continue;
      let repeated = true;
      for (let index = period; index < required; index += 1) {
        if (signatures[index] !== pattern[index % period]) {
          repeated = false;
          break;
        }
      }
      if (repeated) return true;
    }
    return false;
  }

  private toolObservationSignatures(sessionId: string): Map<string, string> {
    const observations = new Map<string, string>();
    for (const part of this.store.listPartsByType(sessionId, "tool_result", 1_000)) {
      const payload = part.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
      const record = payload as Record<string, unknown>;
      const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
      if (!toolCallId) continue;
      const toolResult = record.toolResult;
      if (!toolResult || typeof toolResult !== "object" || Array.isArray(toolResult)) continue;
      const result = toolResult as Record<string, unknown>;
      const metadata = result.metadata;
      const stored = metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>).observationSignature
        : undefined;
      if (typeof stored === "string" && stored) {
        observations.set(toolCallId, stored);
        continue;
      }
      const tool = canonicalToolName(record.tool);
      const output = result.output;
      if ((tool.startsWith("browser_") || tool.includes("_browser_")) && typeof output === "string" && output) {
        observations.set(toolCallId, browserObservationSignature(tool, output));
        continue;
      }
      if (typeof output === "string" && output.trim()) {
        const normalized = output.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\s+/g, " ").trim();
        observations.set(toolCallId, `output:${createHash("sha256").update(normalized).digest("hex")}`);
      }
    }
    return observations;
  }

  private maybeSteerStalledLoop(session: Session, repeating: boolean): void {
    const queue = this.pendingSteeringContext.get(session.id) ?? [];
    queue.push(repeating
      ? "You are repeating the same tool call or a periodic sequence of equivalent calls. Stop the cycle — those observations are already in context. Do not navigate to the same URL, request the same browser entry, or snapshot unchanged state again. Change phase and use the existing results for analysis, evidence, a genuinely different action, or a concise final status."
      : "You have gone several steps without new progress — no new evidence, findings, notes, requests, or edits. Stop re-reading or re-analyzing what you already have. Take a concrete action against the target using what is already in your context, or state the blocker and stop.");
    this.pendingSteeringContext.set(session.id, queue);
  }

  private recordSession(session: Session): void {
    if (!this.registerSessionCatalog) return;
    try { recordSessionLocation(session); } catch {  }
  }

  private async stopSessionEmail(sessionId: string): Promise<void> {
    const ids = new Set(disposableInboxManager.list(sessionId).map((inbox) => inbox.id));
    if (ids.size > 0) {
      const session = this.store.loadSession(sessionId);
      const patch: SessionPatch = {};
      if (session.emailPrimaryId && ids.has(session.emailPrimaryId)) patch.emailPrimaryId = null;
      if (session.emailSecondaryId && ids.has(session.emailSecondaryId)) patch.emailSecondaryId = null;
      if (Object.keys(patch).length > 0) this.updateSession(sessionId, patch);
    }
    await stopDisposableInboxesForSession(sessionId);
  }

  private async maybeAutoCompact(session: Session, planner: PlannerProvider): Promise<
    | { status: "compacted" | "ok" }
    | { status: "ineffective"; preTokens: number; postTokens: number }
  > {
    if ((this.autoCompactFailures.get(session.id) ?? 0) >= AUTO_COMPACT_MAX_FAILURES) return { status: "ok" };
    const estimated = this.estimatedActiveTokens(session, planner);
    const latestUsage = this.store.latestUsage(session.id, session.model);
    const boundary = this.store.latestCompactionBoundary(session.id);
    const actual = latestUsage && (!boundary || latestUsage.createdAt > boundary.createdAt) ? latestUsage.inputTokens : 0;
    const threshold = autoCompactThreshold(resolveContextWindow(planner.contextWindow), resolveMaxOutputTokens(planner.maxOutputTokens));
    const preCompactTokens = Math.max(estimated, actual);
    if (preCompactTokens < threshold) return { status: "ok" };
    if (boundary && this.buildConversationHistory(session).length === 0) return { status: "ok" };
    try {
      this.event(session.id, "compaction", { stage: "started", trigger: "auto" });
      await this.compactSessionWithPlanner(session, planner, { trigger: "auto", preCompactTokens });
      this.autoCompactFailures.delete(session.id);
      const compacted = this.store.latestCompactionBoundary(session.id);
      const postCompactTokens = compacted?.postCompactTokens ?? 0;
      if (postCompactTokens >= preCompactTokens) {
        this.event(session.id, "planner_error", {
          error: `auto-compact was ineffective: ${preCompactTokens} -> ${postCompactTokens} estimated tokens`,
          recoverable: false
        });
        return { status: "ineffective", preTokens: preCompactTokens, postTokens: postCompactTokens };
      }
      return { status: "compacted" };
    } catch (error) {
      if (error instanceof IneffectiveCompactionError) {
        this.event(session.id, "planner_error", {
          error: `auto-compact was ineffective: ${error.preTokens} -> ${error.postTokens} estimated tokens`,
          recoverable: false
        });
        return { status: "ineffective", preTokens: error.preTokens, postTokens: error.postTokens };
      }
      const failures = (this.autoCompactFailures.get(session.id) ?? 0) + 1;
      this.autoCompactFailures.set(session.id, failures);
      this.event(session.id, "planner_error", {
        error: `auto-compact failed: ${error instanceof Error ? error.message : String(error)}`,
        recoverable: failures < AUTO_COMPACT_MAX_FAILURES,
        failures
      });
      return { status: "ok" };
    }
  }

  private deleteStreamingParts(turnId: string): void {
    this.streamingParts.delete(turnId);
  }

  private publishStreamingText(sessionId: string, turnId: string, state: StreamingPartsState): void {
    if (!state.textPartId) return;
    this.store.publishTransientEvent({
      id: id(),
      sessionId,
      type: "stream_text",
      payload: { turnId, partId: state.textPartId, text: state.textAccum },
      createdAt: nowIso()
    });
  }

  private publishStreamingReasoning(sessionId: string, turnId: string, state: StreamingPartsState): void {
    if (!state.reasoningPartId) return;
    const rationale = normalizeReasoningSummary(state.reasoningAccum ?? "");
    this.store.publishTransientEvent({
      id: id(),
      sessionId,
      type: "stream_reasoning",
      payload: { turnId, partId: state.reasoningPartId, rationale },
      createdAt: nowIso()
    });
  }

  private applyStreamEvent(session: Session, turn: Turn, assistantMessage: Message, event: PlanStreamEvent): void {
    const now = Date.now();
    const state = this.streamingParts.get(turn.id) ?? { textAccum: "" };
    if (event.kind === "reasoning") {
      state.reasoningAccum = (state.reasoningAccum ?? "") + event.delta;
      const rationale = normalizeReasoningSummary(state.reasoningAccum);
      if (!rationale || (!state.reasoningPartId && rationale.length < 24 && !rationale.includes("\n"))) {
        this.streamingParts.set(turn.id, state);
        return;
      }
      if (!state.reasoningPartId) {
        const part = this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "reasoning_summary", payload: { rationale } });
        state.reasoningPartId = part.id;
        state.lastReasoningPersist = now;
      } else if (now - (state.lastReasoningPersist ?? 0) >= STREAM_PERSIST_INTERVAL_MS) {
        this.store.updatePartPayload(state.reasoningPartId, { rationale });
        state.lastReasoningPersist = now;
      }
      this.publishStreamingReasoning(session.id, turn.id, state);
      this.streamingParts.set(turn.id, state);
      return;
    }
    state.textAccum += event.delta;
    if (!state.textPartId) {
      if (shouldBufferInitialTextStream(state.textAccum)) {
        this.streamingParts.set(turn.id, state);
        return;
      }
      if (!state.reasoningPartId && state.reasoningAccum) {
        const rationale = normalizeReasoningSummary(state.reasoningAccum);
        if (rationale) {
          const reasoningPart = this.store.addPart({
            sessionId: session.id,
            turnId: turn.id,
            messageId: assistantMessage.id,
            type: "reasoning_summary",
            payload: { rationale }
          });
          state.reasoningPartId = reasoningPart.id;
          state.lastReasoningPersist = now;
          this.publishStreamingReasoning(session.id, turn.id, state);
        }
      }
      const part = this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "text", payload: { text: state.textAccum } });
      state.textPartId = part.id;
      state.lastTextPersist = now;
    } else if (now - (state.lastTextPersist ?? 0) >= STREAM_PERSIST_INTERVAL_MS) {
      this.store.updatePartPayload(state.textPartId, { text: state.textAccum });
      state.lastTextPersist = now;
    }
    this.publishStreamingText(session.id, turn.id, state);
    this.streamingParts.set(turn.id, state);
  }

  private discardStreamingText(sessionId: string, turnId: string): void {
    const state = this.streamingParts.get(turnId);
    if (!state) return;
    if (state.textPartId) this.store.updatePartPayload(state.textPartId, { text: "" });
    state.textAccum = "";
    this.publishStreamingText(sessionId, turnId, state);
    delete state.textPartId;
    delete state.lastTextPersist;
  }

  private prepareStreamingRetry(sessionId: string, turnId: string): void {
    const state = this.streamingParts.get(turnId);
    if (!state) return;
    if (state.textPartId) this.store.updatePartPayload(state.textPartId, { text: "" });
    if (state.reasoningPartId) this.store.updatePartPayload(state.reasoningPartId, { rationale: "" });
    state.textAccum = "";
    state.reasoningAccum = "";
    this.publishStreamingText(sessionId, turnId, state);
    this.publishStreamingReasoning(sessionId, turnId, state);
    delete state.reasoningPartId;
    delete state.reasoningAccum;
    delete state.lastReasoningPersist;
    state.lastTextPersist = Date.now();
  }

  private async planWithRetry(
    planner: PlannerProvider,
    input: PlannerInput,
    session: Session,
    turn: Turn,
    assistantMessage: Message,
    context?: ContextManifest,
    timeoutMs?: number,
    allowEmpty = false
  ): Promise<PlannerAction[]> {
    let lastError = "";
    const { signal, release, timedOut } = this.registerTurnController(turn.id, timeoutMs);
    this.deleteStreamingParts(turn.id);
    const onStreamEvent = (event: PlanStreamEvent) => this.applyStreamEvent(session, turn, assistantMessage, event);
    try {
      for (let attempt = 1; ; attempt += 1) {
        const attemptPayload = this.plannerAttemptPayload(turn, planner.name, attempt, input, context);
        this.event(session.id, "planner_attempt", attemptPayload);
        this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "planner_attempt", payload: attemptPayload });
        try {
          const actions = await abortablePromise(planner.plan(input, { signal, onStreamEvent }), signal);
          return this.validatePlannerActions(actions, allowEmpty);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          if (signal.aborted || this.store.loadTurn(turn.id).status === "cancelled") {
            if (timedOut()) throw new ModelCallDeadlineError();
            lastError = "cancelled";
            break;
          }
          this.prepareStreamingRetry(session.id, turn.id);
          const retry = plannerRetryState(error, attempt, true);
          const errorPayload = {
            turnId: turn.id,
            planner: planner.name,
            attempt,
            maxAttempts: retry.maxAttempts,
            error: lastError,
            recoverable: retry.willRetry,
            ...(retry.willRetry ? {
              retrying: true,
              retryReason: retry.reason,
              nextAttempt: attempt + 1,
              retryDelayMs: retry.delayMs,
              nextRetryAt: Date.now() + retry.delayMs
            } : {})
          };
          this.event(session.id, "planner_error", errorPayload);
          this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "planner_error", payload: errorPayload });
          if (!retry.willRetry) break;
          await abortableSleep(retry.delayMs, signal);
          if (signal.aborted || this.store.loadTurn(turn.id).status === "cancelled") {
            if (timedOut()) throw new ModelCallDeadlineError();
            break;
          }
        }
      }
    } finally {
      release();
    }
    if (this.store.loadTurn(turn.id).status === "cancelled") return [];
    this.store.updateTurn(turn.id, { errorSummary: lastError });
    return [{ kind: "respond", text: `planner error: ${lastError}` }];
  }

  private persistTextPart(sessionId: string, turnId: string, messageId: string, text: string): void {
    this.store.addPart({ sessionId, turnId, messageId, type: "text", payload: { text } });
  }

  private validatePlannerActions(actions: PlannerAction[], allowEmpty = false): PlannerAction[] {
    if (!Array.isArray(actions)) throw new PlannerOutputValidationError("planner actions must be an array");
    if (actions.length === 0) {
      if (allowEmpty) return [];
      throw new PlannerOutputValidationError("planner returned no actions");
    }
    return actions.map((action): PlannerAction => {
      if (!action || typeof action !== "object") throw new PlannerOutputValidationError("planner action must be an object");
      if (action.kind === "reasoning") {
        if (typeof action.text !== "string" || action.text.trim().length === 0) throw new PlannerOutputValidationError("reasoning action requires non-empty text");
        return action;
      }
      if (action.kind === "respond") {
        if (typeof action.text !== "string" || action.text.trim().length === 0) throw new PlannerOutputValidationError("respond action requires non-empty text");
        return action;
      }
      if (action.kind === "tool") {
        if (typeof action.tool !== "string" || action.tool.trim().length === 0) throw new PlannerOutputValidationError("tool action requires tool name");
        if (!action.args || typeof action.args !== "object" || Array.isArray(action.args)) throw new PlannerOutputValidationError("tool action requires args object");
        return { ...action, tool: canonicalToolName(action.tool), rationale: action.rationale || "" };
      }
      if (action.kind === "tool_parse_error") {
        if (typeof action.tool !== "string" || action.tool.trim().length === 0) throw new PlannerOutputValidationError("tool_parse_error action requires tool name");
        return { ...action, tool: canonicalToolName(action.tool) };
      }
      throw new PlannerOutputValidationError(`unknown planner action kind: ${(action as { kind?: unknown }).kind}`);
    });
  }

  private stopTurn(turn: Turn, status: Turn["status"], reason: NonNullable<Turn["stopReason"]>, errorSummary?: string): Turn {
    const current = this.store.loadTurn(turn.id);
    if (current.status !== "running") return current;
    this.event(turn.sessionId, "loop_stop", { turnId: turn.id, status, reason, ...(errorSummary ? { errorSummary } : {}) });
    const updated = this.store.updateTurn(turn.id, { status, stopReason: reason, ...(errorSummary ? { errorSummary } : {}) });
    this.modelCallsByTurn.delete(turn.id);
    this.deleteStreamingParts(turn.id);
    void this.fireHooks({ id: turn.sessionId } as Session, "turn.stop", undefined, { turnId: turn.id, status, reason });
    return updated;
  }

  async runTool(
    session: Session,
    toolName: string,
    args: unknown,
    owner?: { turn: Turn; assistantMessage: Message },
    providerToolCallId?: string
  ): Promise<ToolCallRecord> {
    return await this.runScheduledTool(session, toolName, args, owner, providerToolCallId);
  }

  private async runScheduledTool(
    session: Session,
    toolName: string,
    args: unknown,
    owner?: { turn: Turn; assistantMessage: Message },
    providerToolCallId?: string,
    signal?: AbortSignal
  ): Promise<ToolCallRecord> {
    this.assertAcceptingWork();
    await this.recover();
    this.assertAcceptingWork();
    session = this.store.loadSession(session.id);
    this.resourceSessionIds.add(session.id);
    let tool = toolForExecution(session, toolName);
    let schedulingTool = tool;
    const workspaceTransition = isWorkspaceTransitionTool(schedulingTool);
    const gateSignal = signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;
    try {
      return await this.workspaceBindingGate.run(
        `session-workspace:${session.id}`,
        !workspaceTransition,
        async () => {
          session = this.store.loadSession(session.id);
          tool = toolForExecution(session, toolName);
          schedulingTool = tool;
          return await this.toolExecutionGate.run(
            toolConcurrencyKey(schedulingTool, session, session.workspace),
            schedulingTool.parallel,
            async () => {
              gateSignal.throwIfAborted();
              if (owner && this.store.loadTurn(owner.turn.id).status === "cancelled") throw new Error("turn cancelled before tool start");
              return await this.runToolUnderGate(session, tool, args, owner, providerToolCallId);
            },
            gateSignal
          );
        },
        gateSignal
      );
    } catch (error) {
      const ownerCancelled = owner ? this.store.loadTurn(owner.turn.id).status === "cancelled" : false;
      if (gateSignal.aborted || ownerCancelled) {
        const message = gateSignal.reason ? String(gateSignal.reason) : "turn cancelled before tool start";
        return this.recordRejectedToolCall(session, tool, args, message, {
          interrupted: true,
          cancelled: true,
          reason: this.shuttingDown ? "runtime_shutdown" : "turn_cancelled_before_tool_start"
        }, owner, providerToolCallId);
      }
      throw error;
    }
  }

  private recordRejectedToolCall(
    session: Session,
    tool: ToolDefinition,
    args: unknown,
    message: string,
    state: ToolErrorState,
    owner?: { turn: Turn; assistantMessage: Message },
    providerToolCallId?: string
  ): ToolCallRecord {
    const toolCall = this.toolCalls.begin({
      sessionId: session.id,
      tool: tool.name,
      args,
      ...(owner ? { owner: { turnId: owner.turn.id, messageId: owner.assistantMessage.id } } : {}),
      ...(providerToolCallId ? { providerToolCallId } : {})
    });
    return this.toolCalls.settleError(toolCall, message, state);
  }

  private async runToolUnderGate(
    session: Session,
    tool: ToolDefinition,
    args: unknown,
    owner?: { turn: Turn; assistantMessage: Message },
    providerToolCallId?: string
  ): Promise<ToolCallRecord> {
    const toolCall = this.toolCalls.begin({
      sessionId: session.id,
      tool: tool.name,
      args,
      ...(owner ? { owner: { turnId: owner.turn.id, messageId: owner.assistantMessage.id } } : {}),
      ...(providerToolCallId ? { providerToolCallId } : {})
    });
    await this.executeToolUnderGate(session, toolCall.id, owner);
    return this.store.loadToolCall(toolCall.id);
  }

  async executeTool(
    session: Session,
    toolCallId: string,
    owner?: { turn: Turn; assistantMessage: Message }
  ): Promise<ToolCallRecord> {
    this.assertAcceptingWork();
    await this.recover();
    this.assertAcceptingWork();
    session = this.store.loadSession(session.id);
    const toolCall = this.store.loadToolCall(toolCallId);
    if (toolCall.sessionId !== session.id) throw new Error(`Tool call ${toolCallId} belongs to another session`);
    let tool = toolForExecution(session, toolCall.tool);
    let schedulingTool = tool;
    const workspaceTransition = isWorkspaceTransitionTool(schedulingTool);
    const turnId = owner?.turn.id ?? toolCall.turnId;
    const gateController = turnId ? this.registerTurnController(turnId) : undefined;
    const gateSignal = gateController
      ? AbortSignal.any([gateController.signal, this.shutdownController.signal])
      : this.shutdownController.signal;
    try {
      return await this.workspaceBindingGate.run(
        `session-workspace:${session.id}`,
        !workspaceTransition,
        async () => {
          session = this.store.loadSession(session.id);
          tool = toolForExecution(session, toolCall.tool);
          schedulingTool = tool;
          return await this.toolExecutionGate.run(
            toolConcurrencyKey(schedulingTool, session, session.workspace),
            schedulingTool.parallel,
            async () => {
              gateSignal.throwIfAborted();
              if (turnId && this.store.loadTurn(turnId).status === "cancelled") throw new Error("turn cancelled before tool start");
              return await this.executeToolUnderGate(session, toolCallId, owner);
            },
            gateSignal
          );
        },
        gateSignal
      );
    } catch (error) {
      if (!gateSignal.aborted && (!turnId || this.store.loadTurn(turnId).status !== "cancelled")) throw error;
      const cancelled = this.store.loadToolCall(toolCallId);
      if (cancelled.status === "pending") {
        const message = turnId ? "turn cancelled before tool start" : String(gateSignal.reason ?? "tool gate cancelled before start");
        return this.toolCalls.settleError(cancelled, message, {
          interrupted: true,
          cancelled: true,
          reason: this.shuttingDown ? "runtime_shutdown" : turnId ? "turn_cancelled_before_tool_start" : "tool_gate_cancelled"
        });
      }
      return cancelled;
    } finally {
      gateController?.release();
    }
  }

  private async executeToolUnderGate(
    session: Session,
    toolCallId: string,
    owner?: { turn: Turn; assistantMessage: Message }
  ): Promise<ToolCallRecord> {
    let toolCall = this.store.loadToolCall(toolCallId);
    if (toolCall.status !== "pending") return toolCall;
    const tool = toolForExecution(session, toolCall.tool);
    toolCall = this.toolCalls.markRunning(toolCall);
    const controller = new AbortController();
    this.activeToolControllers.add(controller);
    const lease = new ToolExecutionLease();
    this.activeToolLeases.add(lease);
    const deadline = new ToolExecutionDeadline(tool.name, tool.timeoutMs, controller.signal);
    const turnId = owner?.turn.id ?? toolCall.turnId;
    const messageId = owner?.assistantMessage.id ?? toolCall.messageId;
    if (turnId) {
      const list = this.turnControllers.get(turnId) ?? [];
      list.push(controller);
      this.turnControllers.set(turnId, list);
    }
    let liveRawOutputBuffer = "";
    let lastLiveFlush = 0;
    let liveOutputVisible = false;
    let liveOutputSettled = false;
    let liveOutputTimer: ReturnType<typeof setTimeout> | undefined;
    const timelinePartId = toolCall.timelinePartId;
    const flushLiveOutput = (): void => {
      if (!lease.isActive() || !timelinePartId || liveOutputSettled || !liveRawOutputBuffer) return;
      liveOutputVisible = true;
      lastLiveFlush = Date.now();
      this.store.updatePartPayload(timelinePartId, { record: { ...toolCall, liveOutput: sanitizeToolOutput(liveRawOutputBuffer) } });
    };
    const settleLiveOutput = (): void => {
      liveOutputSettled = true;
      if (liveOutputTimer) clearTimeout(liveOutputTimer);
      liveOutputTimer = undefined;
    };
    const onOutputChunk = timelinePartId
      ? (chunk: string): void => {
          liveRawOutputBuffer = takeBytes(liveRawOutputBuffer + chunk, LIVE_OUTPUT_MAX_BYTES, "tail");
          if (!liveOutputVisible) {
            liveOutputTimer ??= setTimeout(() => {
              liveOutputTimer = undefined;
              flushLiveOutput();
            }, LIVE_OUTPUT_INITIAL_DELAY_MS);
            return;
          }
          const now = Date.now();
          if (now - lastLiveFlush < LIVE_OUTPUT_FLUSH_INTERVAL_MS) return;
          flushLiveOutput();
        }
      : undefined;
    const context: ToolContext = {
      session,
      workspace: session.workspace,
      rootWorkspace: this.workspace,
      toolCallId: toolCall.id,
      now: nowIso,
      fileState: leasedToolCapability(this.fileState, lease),
      lsp: leasedToolCapability(this.lsp.forSession(session.id, session.workspace), lease),
      ...(this.knowledge() ? { knowledge: leasedToolCapability(this.knowledge()!, lease) } : {}),
      store: leasedToolCapability(this.store as unknown as ToolContext["store"], lease),
      signal: deadline.signal,
      timeoutMs: toolOperationTimeout(tool.timeoutMs),
      executionBackend: this.executionBackend ?? this.containerBackend(session.workspace, session.id) as unknown as ToolExecutionBackend,
      availableTools: () => {
        lease.assertActive();
        return listToolsForSession(session);
      },
      requestUserInput: (input, signal) => this.requestUserInput(session, input, signal ?? deadline.signal),
      agentControl: {
        list: () => {
          lease.assertActive();
          return this.listAgentLifecycleEntries(session.id);
        },
        wait: async (sessionIds, timeoutMs, signal) => {
          lease.assertActive();
          const wanted = sessionIds?.length ? new Set(sessionIds) : undefined;
          const started = Date.now();
          while (true) {
            lease.assertActive();
            if (signal?.aborted) throw signal.reason ?? new Error("agent wait cancelled");
            const entries = this.listAgentLifecycleEntries(session.id).filter((entry) => !wanted || wanted.has(entry.sessionId));
            if (wanted) {
              const missing = [...wanted].filter((id) => !entries.some((entry) => entry.sessionId === id));
              if (missing.length) throw new Error(`unknown child session: ${missing.join(", ")}`);
            }
            if (entries.length === 0 || entries.some((entry) => !entry.running) || Date.now() - started >= timeoutMs) return entries;
            await new Promise<void>((resolve) => setTimeout(resolve, 200));
          }
        },
        message: (childSessionId, text) => {
          lease.assertActive();
          const child = this.store.loadSession(childSessionId);
          if (child.parentId !== session.id) throw new Error(`subagent session ${childSessionId} does not belong to this parent`);
          if (!this.injectUserInput(childSessionId, text)) throw new Error(`subagent session ${childSessionId} is not currently running; use agent_followup to start a new turn`);
          return "delivered";
        },
        interrupt: async (childSessionId, reason = "interrupted by parent agent") => {
          lease.assertActive();
          const child = this.store.loadSession(childSessionId);
          if (child.parentId !== session.id) throw new Error(`subagent session ${childSessionId} does not belong to this parent`);
          if (child.archivedAt) throw new Error(`subagent session ${childSessionId} is closed`);
          const job = this.store.listJobs(session.id, 10_000).find((candidate) => candidate.kind === "agent" && candidate.childSessionId === childSessionId && ["created", "starting", "running", "cancelling"].includes(candidate.status));
          if (job) {
            this.subagentControllers.get(job.id)?.abort(reason);
            for (const childTurn of this.store.listTurns(childSessionId, 10_000)) if (childTurn.status === "running") this.cancelTurn(childTurn.id, reason);
            await this.jobs.cancel(job.id, false);
          } else {
            const runningTurn = this.store.listTurns(childSessionId, 10_000).find((candidate) => candidate.status === "running");
            if (!runningTurn) throw new Error(`subagent session ${childSessionId} is not currently running`);
            this.cancelTurn(runningTurn.id, reason);
          }
          return this.agentLifecycleEntry(session.id, this.store.loadSession(childSessionId));
        },
        close: async (childSessionId) => {
          lease.assertActive();
          const child = this.store.loadSession(childSessionId);
          if (child.parentId !== session.id) throw new Error(`subagent session ${childSessionId} does not belong to this parent`);
          if (!child.archivedAt) await this.archiveSession(childSessionId);
          return this.agentLifecycleEntry(session.id, this.store.loadSession(childSessionId));
        }
      },
      worktreeControl: {
        enter: async ({ name, ref, branch }) => {
          lease.assertActive();
          if (session.workspace !== this.workspace) throw new Error(`session is already using an isolated worktree: ${session.workspace}`);
          this.assertWorkspaceTransitionIdle(session.id);
          const safeName = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
          if (!safeName) throw new Error("worktree name must contain a letter or number");
          const root = (await runHostGit(this.workspace, ["rev-parse", "--show-toplevel"])).trim();
          if (realpathSync(root) !== realpathSync(this.workspace)) throw new Error(`Farai workspace is not the Git repository root: ${root}`);
          const worktreesRoot = join(this.workspace, ".farai", "worktrees");
          mkdirSync(worktreesRoot, { recursive: true });
          const path = join(worktreesRoot, safeName);
          const registered = await registeredWorktree(this.workspace, path);
          if (existsSync(path) && !registered) throw new Error(`worktree path already exists but is not a registered Git worktree: ${path}`);
          if (!existsSync(path) && registered) throw new Error(`worktree registration exists but its directory is missing: ${path}; repair or prune it before re-entry`);
          if (registered) {
            if (ref || branch) throw new Error("ref and branch can only be specified when creating a new worktree");
            const familyIds = new Set(this.sessionFamily(session.id).map((candidate) => candidate.id));
            const owners = this.store.listSessions(100_000, { includeArchived: true }).filter((candidate) => !familyIds.has(candidate.id) && candidate.workspace === path);
            if (owners.length) throw new Error(`worktree is already active in session ${owners.map((owner) => owner.id).join(", ")}`);
            await this.stopWorkspaceBoundServices(session.id);
            this.updateSession(session.id, { workspace: path });
            this.fileState.clear(session.id);
            return { path, ref: registered.ref, ...(registered.branch ? { branch: registered.branch } : {}), created: false };
          }
          const baseRef = ref ?? "HEAD";
          const addArgs = branch
            ? ["worktree", "add", "-b", branch, path, baseRef]
            : ["worktree", "add", "--detach", path, baseRef];
          await this.stopWorkspaceBoundServices(session.id);
          await runHostGit(this.workspace, addArgs);
          this.updateSession(session.id, { workspace: path });
          this.fileState.clear(session.id);
          return { path, ref: baseRef, ...(branch ? { branch } : {}), created: true };
        },
        exit: async ({ remove = false } = {}) => {
          lease.assertActive();
          const current = this.store.loadSession(session.id);
          if (current.workspace === this.workspace) throw new Error("session is not inside an isolated worktree");
          this.assertWorkspaceTransitionIdle(session.id);
          const worktreesRoot = join(this.workspace, ".farai", "worktrees");
          const managedPath = relative(worktreesRoot, current.workspace);
          if (!managedPath || managedPath.startsWith("..") || isAbsolute(managedPath)) {
            throw new Error(`refusing to leave an unmanaged worktree: ${current.workspace}`);
          }
          if (remove) {
            const family = this.sessionFamily(session.id);
            const familyIds = new Set(family.map((candidate) => candidate.id));
            const owners = this.store.listSessions(100_000, { includeArchived: true }).filter((candidate) => !familyIds.has(candidate.id) && candidate.workspace === current.workspace);
            if (owners.length) throw new Error(`worktree is still referenced by session ${owners.map((owner) => owner.id).join(", ")}`);
            for (const member of family.filter((candidate) => candidate.workspace === current.workspace)) this.assertWorkspaceTransitionIdle(member.id);
            const dirtyBeforeCleanup = await runHostGit(current.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
            if (dirtyBeforeCleanup.trim()) throw new Error("worktree has uncommitted or untracked changes; leave it preserved or clean it before removal");
          }
          const affected = remove
            ? this.sessionFamily(session.id).filter((candidate) => candidate.workspace === current.workspace)
            : [current];
          await Promise.all(affected.map((member) => this.stopWorkspaceBoundServices(member.id)));
          if (remove) {
            const dirtyAfterCleanup = await runHostGit(current.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
            if (dirtyAfterCleanup.trim()) throw new Error("workspace services changed the worktree during shutdown; removal was refused");
            await runHostGit(this.workspace, ["worktree", "remove", current.workspace]);
          }
          for (const member of affected) {
            this.updateSession(member.id, { workspace: this.workspace });
            this.fileState.clear(member.id);
          }
          return { path: current.workspace, root: this.workspace, removed: remove };
        }
      },
      cancelJob: async (jobId) => {
        lease.assertActive();
        const job = this.store.loadJob(jobId);
        if (job.sessionId !== session.id) throw new Error(`background job ${job.id} belongs to another session`);
        this.subagentControllers.get(job.id)?.abort("background agent cancelled");
        if (job.childSessionId) {
          for (const childTurn of this.store.listTurns(job.childSessionId, 10_000)) {
            if (childTurn.status === "running") this.cancelTurn(childTurn.id, "background agent cancelled");
          }
        }
        return this.jobs.cancel(jobId, false);
      },
      delegateSession: async ({ title, prompt, lane, tools, model, mode = "attached", sessionId: resumeSessionId, linkToolCall = true }) => {
        lease.assertActive();
        const previousJob = resumeSessionId
          ? this.store.listJobs(session.id, 10_000).find((job) => job.kind === "agent" && job.childSessionId === resumeSessionId)
          : undefined;
        const effectiveLane = lane ?? previousJob?.lane;
        const laneDef = effectiveLane ? resolveLane(this.workspace, effectiveLane) : undefined;
        if (effectiveLane && !laneDef) throw new Error(`unknown subagent lane: ${effectiveLane}`);
        let child: Session;
        let scopedTools: string[] | undefined;
        let editsSharedWorkspace: boolean;
        if (resumeSessionId) {
          child = this.store.loadSession(resumeSessionId);
          if (child.parentId !== session.id) throw new Error(`subagent session ${resumeSessionId} does not belong to this parent`);
          if (child.archivedAt) throw new Error(`subagent session ${resumeSessionId} is closed`);
          const active = this.store.listJobs(session.id, 10_000).some((job) => (
            job.kind === "agent"
            && job.childSessionId === child.id
            && ["created", "starting", "running", "cancelling"].includes(job.status)
          ));
          if (active || this.hasRunningTurn(child.id)) throw new Error(`subagent session ${child.id} is already running`);
          const requestedTools = tools ?? laneDef?.tools;
          scopedTools = requestedTools
            ? resolveSubagentToolScope({ parent: session, availableTools: listToolsForSession(session), requestedTools })
            : child.toolScope;
          editsSharedWorkspace = hasSharedWorkspaceEdits(scopedTools);
          const childModel = model ?? laneDef?.model;
          if (childModel && childModel !== child.model) child = this.updateSession(child.id, { model: childModel });
          if (requestedTools && scopedTools?.length) child = this.updateSession(child.id, { toolScope: scopedTools });
        } else {
          const requestedTools = tools ?? laneDef?.tools;
          scopedTools = resolveSubagentToolScope({
            parent: session,
            availableTools: listToolsForSession(session),
            ...(requestedTools ? { requestedTools } : {})
          });
          editsSharedWorkspace = hasSharedWorkspaceEdits(scopedTools);
          const childModel = model ?? laneDef?.model;
          child = await this.forkSession(session.id, title);
          if (childModel && childModel !== child.model) this.updateSession(child.id, { model: childModel });
          if (scopedTools?.length) this.updateSession(child.id, { toolScope: scopedTools });
        }
        const workerPrompt = buildSubagentTaskPrompt({
          title,
          task: prompt,
          ...(effectiveLane ? { lane: effectiveLane } : {}),
          ...(laneDef?.prompt ? { lanePrompt: laneDef.prompt } : {}),
          parentSessionId: session.id,
          ...(scopedTools?.length ? { tools: scopedTools } : {})
        });
        const job = this.jobs.startAgent({
          sessionId: session.id,
          ...(turnId ? { turnId } : {}),
          ...(mode === "detached" && linkToolCall ? { toolCallId: toolCall.id } : {}),
          childSessionId: child.id,
          title,
          ...(effectiveLane ? { lane: effectiveLane } : {}),
          mode
        });
        const agentController = new AbortController();
        this.subagentControllers.set(job.id, agentController);
        const cancelChild = () => {
          for (const childTurn of this.store.listTurns(child.id, 10_000)) {
            if (childTurn.status === "running") this.cancelTurn(childTurn.id, "parent subagent task cancelled");
          }
        };
        agentController.signal.addEventListener("abort", cancelChild, { once: true });
        const abortFromParent = mode === "attached" && context.signal
          ? () => agentController.abort(context.signal?.reason ?? new Error("parent subagent task cancelled"))
          : undefined;
        if (context.signal?.aborted && abortFromParent) abortFromParent();
        else if (context.signal && abortFromParent) context.signal.addEventListener("abort", abortFromParent, { once: true });
        this.event(session.id, "artifact", {
          kind: "campaign_worker_started",
          jobId: job.id,
          childSessionId: child.id,
          parentSessionId: session.id,
          title,
          mode,
          ...(effectiveLane ? { lane: effectiveLane } : {})
        });
        const run = async (): Promise<string> => {
          try {
            const execute = async () => {
              if (!this.store.isOpen() || !this.hasJob(job.id)) throw new Error("subagent job is unavailable");
              const current = this.store.loadJob(job.id);
              if (["succeeded", "failed", "cancelled", "lost"].includes(current.status)) throw new Error(`subagent job is already ${current.status}`);
              this.jobs.markAgentRunning(job.id);
              const result = await this.prompt(child, workerPrompt, { signal: agentController.signal });
              const childTurn = this.store.listTurns(child.id, 1)[0];
              if (!childTurn) throw new Error("subagent ended without a recorded turn");
              if (childTurn.status !== "completed" || childTurn.errorSummary) {
                throw new Error(childTurn.errorSummary ?? `subagent turn ended with status ${childTurn.status}`);
              }
              const response = this.completedAssistantText(child.id) ?? result.response;
              if (!this.store.isOpen() || !this.hasJob(job.id) || this.store.loadJob(job.id).status !== "running") return response;
              this.event(session.id, "artifact", {
                kind: "campaign_worker_finished",
                jobId: job.id,
                childSessionId: child.id,
                parentSessionId: session.id,
                mode,
                ...(effectiveLane ? { lane: effectiveLane } : {}),
                responseBytes: Buffer.byteLength(response, "utf8"),
                evidenceCount: this.store.listEvidence(child.id).length,
                findingCount: this.store.listFindings(child.id).length
              });
              this.jobs.completeAgent(job.id, response, mode === "detached");
              return response;
            };
            const gated = () => session.parentId
              ? execute()
              : this.subagentGate.run(execute, agentController.signal);
            return editsSharedWorkspace && !session.parentId
              ? await this.subagentWorkspaceMutationGate.run(gated, agentController.signal)
              : await gated();
          } catch (error) {
            if (this.store.isOpen() && this.hasJob(job.id)) {
              const current = this.store.loadJob(job.id);
              if (!["succeeded", "failed", "cancelled", "lost"].includes(current.status)) {
                if (agentController.signal.aborted) await this.jobs.cancel(job.id, false);
                else this.jobs.failAgent(job.id, error instanceof Error ? error.message : String(error), mode === "detached");
              }
            }
            throw error;
          } finally {
            agentController.signal.removeEventListener("abort", cancelChild);
            if (context.signal && abortFromParent) context.signal.removeEventListener("abort", abortFromParent);
            this.subagentControllers.delete(job.id);
          }
        };
        if (mode === "attached") return { sessionId: child.id, jobId: job.id, response: await run() };
        void run().catch(() => undefined);
        return { sessionId: child.id, jobId: job.id };
      },
      ...(onOutputChunk ? { onOutputChunk } : {})
    };
    const releaseController = () => {
      deadline.dispose();
      lease.revoke("tool execution finished");
      this.activeToolLeases.delete(lease);
      this.activeToolControllers.delete(controller);
      if (!turnId) return;
      const list = this.turnControllers.get(turnId);
      if (!list) return;
      const idx = list.indexOf(controller);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) this.turnControllers.delete(turnId);
    };
    let result: ToolResult;
    await this.fireHooks(session, "tool.pre", toolCall.tool, { tool: toolCall.tool, toolCallId: toolCall.id, args: toolCall.args });
    try {
      lease.assertActive();
      result = await deadline.run(() => tool.run(toolCall.args, context));
    } catch (error) {
      settleLiveOutput();
      releaseController();
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = error instanceof ToolDeadlineError;
      const cancelled = deadline.signal.aborted && !timedOut;
      toolCall = this.toolCalls.settleError(toolCall, message, {
        interrupted: timedOut || cancelled,
        cancelled,
        timedOut,
        reason: timedOut ? "tool_deadline" : cancelled ? this.shuttingDown ? "runtime_shutdown" : "tool_cancelled" : "tool_failure"
      });
      const processId = processIdFromArgs(toolCall.args);
      if (processId) {
        try { this.settleBackgroundProcess(session.id, processId, "error"); }
        catch (postError) { this.emitRecoverableToolError(toolCall, "background settlement after tool failure", postError); }
      }
      await this.fireHooks(session, "tool.post", toolCall.tool, {
        tool: toolCall.tool,
        toolCallId: toolCall.id,
        status: "error",
        ok: false,
        summary: message,
        error: message,
        interrupted: timedOut || cancelled,
        timedOut,
        cancelled
      });
      return toolCall;
    }
    settleLiveOutput();
    releaseController();
    let rendered: RenderedToolResult;
    try {
      result = this.store.persistToolResultAttachments(session.id, this.boundToolOutput(session.id, toolCall, result));
      if (result.evidence) {
        for (const evidence of result.evidence) {
          const saved = this.store.saveEvidence(evidence, result.output);
          toolCall.evidenceIds.push(saved.id);
          if (turnId && messageId) {
            this.store.addPart({
              sessionId: session.id,
              turnId,
              messageId,
              type: "artifact",
              payload: { kind: "evidence", evidence: saved, toolCallId: toolCall.id }
            });
          }
        }
      }
      toolCall = { ...toolCall, status: completedToolCallStatus(result) };
      if (result.processId) toolCall.processId = result.processId;
      if (result.jobId) toolCall.jobId = result.jobId;
      if (result.outputArtifactId) toolCall.outputArtifactId = result.outputArtifactId;
      if (result.processId && toolCall.status === "running_background") {
        const job = this.jobs.attachProcess({
          sessionId: session.id,
          ...(turnId ? { turnId } : {}),
          toolCallId: toolCall.id,
          processId: result.processId,
          backendKind: sessionManager.getBackendKind(result.processId) ?? "unknown"
        });
        toolCall = { ...toolCall, jobId: job.id };
        result = { ...result, jobId: job.id };
      }
      rendered = this.renderToolResult(tool, toolCall, result);
      let persistedResult: ToolResult;
      try {
        persistedResult = JSON.parse(JSON.stringify(rendered.result)) as ToolResult;
      } catch (error) {
        const serializationError = error instanceof Error ? error.message : String(error);
        persistedResult = {
          ok: rendered.result.ok,
          summary: rendered.result.summary,
          ...(rendered.result.output ? { output: rendered.result.output } : {}),
          ...(rendered.result.status ? { status: rendered.result.status } : {}),
          ...(rendered.result.outputArtifactId ? { outputArtifactId: rendered.result.outputArtifactId } : {}),
          ...(rendered.result.jobId ? { jobId: rendered.result.jobId } : {}),
          ...(rendered.result.processId ? { processId: rendered.result.processId } : {}),
          metadata: { serializationError }
        };
        this.event(session.id, "planner_error", {
          toolCallId: toolCall.id,
          tool: toolCall.tool,
          error: `tool result serialization fallback: ${serializationError}`,
          recoverable: true
        });
      }
      const terminalPayload = {
        toolCallId: toolCall.id,
        tool: toolCall.tool,
        result: rendered.modelResult,
        humanResult: rendered.humanResult,
        toolResult: persistedResult
      };
      JSON.stringify(terminalPayload);
      if (result.outputArtifactId && turnId && messageId) {
        this.store.addPart({
          sessionId: session.id,
          turnId,
          messageId,
          type: "tool_progress",
          payload: {
            toolCallId: toolCall.id,
            artifactId: result.outputArtifactId,
            bytes: outputArtifactBytes(result),
            path: outputArtifactPath(result)
          }
        });
      }
      toolCall = this.store.settleToolCall(toolCall, { type: "tool_result", payload: terminalPayload }).toolCall;
    } catch (error) {
      const message = `tool result processing failed: ${error instanceof Error ? error.message : String(error)}`;
      toolCall = this.toolCalls.settleError(toolCall, message, { reason: "result_processing_failure" });
      await this.fireHooks(session, "tool.post", toolCall.tool, {
        tool: toolCall.tool,
        toolCallId: toolCall.id,
        status: "error",
        ok: false,
        summary: message,
        error: message,
        interrupted: false,
        timedOut: false,
        cancelled: false
      });
      return toolCall;
    }
    try {
      if (result.processId && (toolCall.status === "done" || toolCall.status === "error")) {
        this.settleBackgroundProcess(session.id, result.processId, toolCall.status);
      }
      if (result.outputArtifactId) {
        this.event(session.id, "tool_progress", {
          toolCallId: toolCall.id,
          artifactId: result.outputArtifactId,
          bytes: outputArtifactBytes(result),
          path: outputArtifactPath(result)
        });
      }
      this.event(session.id, "tool_result", { toolCallId: toolCall.id, tool: toolCall.tool, result: rendered.result, humanResult: rendered.humanResult });
    } catch (postError) {
      this.emitRecoverableToolError(toolCall, "post-settlement tool reporting failed", postError);
    }
    await this.fireHooks(session, "tool.post", toolCall.tool, { tool: toolCall.tool, toolCallId: toolCall.id, status: toolCall.status, ok: result.ok, summary: result.summary });
    return toolCall;
  }

  private hasJob(jobId: string): boolean {
    try {
      this.store.loadJob(jobId);
      return true;
    } catch {
      return false;
    }
  }

  private settleBackgroundProcess(sessionId: string, processId: string, status: "done" | "error"): void {
    this.store.settleBackgroundProcess(sessionId, processId, status);
  }

  private boundToolOutput(sessionId: string, toolCall: ToolCallRecord, result: ToolResult): ToolResult {
    return normalizeToolResult(result, {
      sessionId,
      toolCallId: toolCall.id,
      saveOutputArtifact: (input) => this.store.saveOutputArtifact(input)
    });
  }

  private event(sessionId: string, type: SessionEvent["type"], payload: unknown): void {
    this.store.appendEvent({ id: id(), sessionId, type, payload, createdAt: nowIso() });
  }

  private async handleSlash(session: Session, turn: Turn, assistantMessage: Message, input: string): Promise<string> {
    const [command, ...rest] = input.trim().split(/\s+/);
    if (command === "/scan") {
      const target = rest[0];
      if (!target) return "Usage: /scan <target>";
      await this.runTool(session, "port_scan", { target }, { turn, assistantMessage });
      return `Scan requested for ${target}.`;
    }
    if (command === "/shell") {
      const commandText = rest.join(" ");
      if (!commandText) return "Usage: /shell <command>";
      await this.runTool(session, "shell_exec", { command: commandText }, { turn, assistantMessage });
      return "Shell command submitted.";
    }
    if (command === "/note") {
      const note: Note = { id: id(), sessionId: session.id, text: rest.join(" "), tags: ["manual"], createdAt: nowIso() };
      this.store.addNote(note);
      this.event(session.id, "artifact", { kind: "note", note });
      this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "artifact", payload: { kind: "note", note } });
      return "Note saved.";
    }
    if (command === "/todos") {
      const todos = this.store.listTodos(session.id);
      if (todos.length === 0) return "No todos.";
      return todos.map((todo) => `${todo.id}\t${todo.status}\t${todo.priority}\t${todo.text}`).join("\n");
    }
    if (command === "/events") {
      return this.store
        .listEvents(session.id, 20)
        .slice(-20)
        .map((event) => `${event.createdAt}\t${event.type}\t${JSON.stringify(event.payload).slice(0, 160)}`)
        .join("\n");
    }
    if (command === "/tools") {
      const calls = this.store.listToolCalls(session.id, 20);
      if (calls.length === 0) return "No tool calls.";
      return calls.map((call) => `${call.id}\t${call.tool}\t${call.status}`).join("\n");
    }
    if (command === "/mcp") {
      const rootSessionId = this.rootSessionId(session);
      await refreshMcpTools({
        workspace: session.workspace,
        configWorkspace: this.workspace,
        session,
        rootSessionId,
        rootWorkspace: this.workspace,
        ...(this.containerLifecycle ? { containerLifecycle: this.containerLifecycle } : {}),
        ...this.mcpCallbacks(session),
        background: true,
        force: true,
        includeResources: false,
        onStartupEvent: (event) => this.event(session.id, event.type, event)
      }).catch((error) => {
        this.event(session.id, "planner_error", {
          turnId: turn.id,
          error: `MCP refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          recoverable: true
        });
      });
      const text = this.renderMcpStatus(session);
      this.store.addPart({
        sessionId: session.id,
        turnId: turn.id,
        messageId: assistantMessage.id,
        type: "artifact",
        payload: { kind: "mcp_inventory", statuses: listMcpServerStatuses(session), text }
      });
      return text;
    }
    if (command === "/context") return formatContextManifest(this.inspectContext(session));
    if (command === "/status") return this.summary(session);
    if (command === "/campaign") {
      if (!session.campaignId) {
        const campaigns = this.store.listCampaigns(this.workspace);
        return campaigns.length ? campaigns.map((item) => `${item.id}\t${item.status}\t${item.name} (${item.kind})`).join("\n") : "No campaigns. Use campaign_create or ask Farai to start one.";
      }
      const dossier = this.store.campaignDossier(session.campaignId, rest.join(" "));
      return JSON.stringify(dossier, null, 2);
    }
    if (command === "/memory") {
      const kind = rest[0];
      const items = this.store.listMemory(session.id).filter((item) => !kind || item.kind === kind);
      return items.length ? items.map((item) => `${item.kind}\t${item.key}\t${JSON.stringify(item.value)}`).join("\n") : "No memory items.";
    }
    if (command === "/evidence") {
      const items = this.store.listEvidence(session.id);
      return items.length ? items.map((item) => `${item.id}\t${item.title}\t${item.summary}`).join("\n") : "No evidence.";
    }
    if (command === "/findings") {
      const items = this.store.listFindings(session.id);
      return items.length ? items.map((item) => `${item.severity}\t${item.title}\t${item.target}`).join("\n") : "No findings.";
    }
    if (command === "/report") {
      if (rest[0] === "save") return `Report saved: ${this.exportReport(session.id, { write: true }).path}`;
      return this.exportReport(session.id).markdown;
    }
    return `Unknown command ${command}. Try /mcp, /scan, /shell, /note, /todos, /events, /tools, /context, /status, /campaign, /memory, /evidence, /findings, /report.`;
  }

  private renderMcpStatus(session: Session): string {
    return formatMcpInventory(listMcpServerStatuses(session));
  }

  private freestyleGuidance(session: Session, input: string): string {
    return [
      "Freestyle ready.",
      "I can research, write helper code, run recon, collect evidence, and draft reports.",
      "Use natural language, or commands: /scan, /shell, /note, /report.",
      `Last request understood as: ${input}`
    ].join("\n");
  }

  summary(session: Session): string {
    const evidence = this.store.listEvidence(session.id);
    const notes = this.store.listNotes(session.id);
    const findings = this.store.listFindings(session.id);
    const todos = this.store.listTodos(session.id, { limit: 10 });
    return [
      `session: ${sessionDisplayName(session)}`,
      `Evidence: ${evidence.length}`,
      `Notes: ${notes.length}`,
      `Findings: ${findings.length}`,
      `Todos: ${todos.filter((todo) => todo.status !== "done" && todo.status !== "cancelled").length}`,
      "",
      ...todos.slice(0, 5).map((todo) => `- todo ${todo.id}: [${todo.status}/${todo.priority}] ${todo.text}`),
      ...evidence.slice(-5).map((item) => `- evidence ${item.id}: ${item.title} — ${item.summary.slice(0, 120)}`)
    ].join("\n");
  }

  async compactSession(session: Session, customInstructions?: string): Promise<Session> {
    const planner = this.planner ?? await createPlannerForSessionAsync(session, this.workspace);
    const controller = new AbortController();
    this.compactionControllers.get(session.id)?.abort("new compaction started");
    this.compactionControllers.set(session.id, controller);
    try {
      return await this.compactSessionWithPlanner(session, planner, { trigger: "manual", ...(customInstructions ? { customInstructions } : {}), signal: controller.signal });
    } finally {
      if (this.compactionControllers.get(session.id) === controller) this.compactionControllers.delete(session.id);
      if (!this.shuttingDown) void this.mailboxDispatcher.wakeQueuedInputs(session.id);
    }
  }

  cancelCompaction(sessionId: string): void {
    this.compactionControllers.get(sessionId)?.abort("compaction cancelled");
  }

  async compactSessionWithPlanner(
    session: Session,
    planner: PlannerProvider,
    options: { trigger?: "manual" | "auto"; customInstructions?: string; preCompactTokens?: number; signal?: AbortSignal } = {}
  ): Promise<Session> {
    session = this.store.loadSession(session.id);
    const trigger = options.trigger ?? "manual";
    if (options.signal?.aborted) throw new Error(`compaction cancelled: ${String(options.signal.reason ?? "aborted")}`);
    const previousBoundary = this.store.latestCompactionBoundary(session.id);
    const afterMessageRowId = previousBoundary?.throughMessageRowId ?? 0;
    const throughMessageRowId = this.store.maxMessageRowId(session.id);
    if (throughMessageRowId <= afterMessageRowId) throw new Error("not enough conversation history to compact");
    const availableTools = listToolsForSession(session);
    const context = this.assembleContext({
      session,
      availableTools,
      contextWindow: resolveContextWindow(planner.contextWindow),
      maxOutputTokens: resolveMaxOutputTokens(planner.maxOutputTokens),
      ...this.contextBudgetInput(),
      toolsEnabled: false
    });
    const snapshotMessages = this.store.listMessagesBetweenRows(session.id, afterMessageRowId, throughMessageRowId, Number.MAX_SAFE_INTEGER);
    const history = [
      ...projectConversationHistory(snapshotMessages, { full: true }).entries,
      ...(context.volatileContext ? [{ role: "context" as const, text: context.volatileContext }] : [])
    ];
    const compactableTokens = estimateTokens({ summary: session.summary, history });
    const preTokens = options.preCompactTokens ?? estimateTokens({ summary: session.summary, history, context: context.contextBlocks });
    if (trigger === "manual" && compactableTokens < MANUAL_COMPACT_MIN_TOKENS) {
      throw new Error(`not enough conversation to compact (${compactableTokens} tokens; minimum ${MANUAL_COMPACT_MIN_TOKENS})`);
    }
    let summary: string;
    if (planner.compactionMode === "deterministic") {
      summary = this.buildCompactSummary(session, snapshotMessages);
    } else {
      try {
        summary = await runModelCompaction({
          planner,
          plannerInput: {
            session,
            history,
            ...(session.summary ? { compactedSummary: session.summary } : {}),
            contextBlocks: context.contextBlocks,
            tools: [],
            toolCatalog: context.toolCatalog,
            toolChoice: "none"
          },
          ...(options.customInstructions ? { customInstructions: options.customInstructions } : {}),
          ...(options.signal ? { signal: options.signal } : {})
        });
      } catch (error) {
        if (trigger !== "auto" || options.signal?.aborted) throw error;
        summary = this.buildCompactSummary(session, snapshotMessages);
        this.event(session.id, "planner_error", {
          error: `model compaction failed; used deterministic fallback: ${error instanceof Error ? error.message : String(error)}`,
          recoverable: true
        });
      }
    }
    if (options.signal?.aborted) throw new Error(`compaction cancelled: ${String(options.signal.reason ?? "aborted")}`);
    const postTokens = estimateTokens({ summary, context: context.contextBlocks });
    if (postTokens >= preTokens) throw new IneffectiveCompactionError(preTokens, postTokens);
    this.store.commitCompaction({
      sessionId: session.id,
      trigger,
      summary,
      throughMessageRowId,
      preCompactTokens: preTokens,
      postCompactTokens: postTokens,
      expectedPreviousBoundaryId: previousBoundary?.id ?? null
    });
    this.autoCompactFailures.delete(session.id);
    return this.store.loadSession(session.id);
  }

  private buildCompactSummary(session: Session, messages: MessageWithParts[]): string {
    const evidence = this.store.listEvidence(session.id).slice(-20);
    const notes = this.store.listNotes(session.id).slice(-20);
    const findings = this.store.listFindings(session.id);
    const memory = this.store.listMemory(session.id).slice(0, 30);
    const todos = this.store.listTodos(session.id, { limit: 30 });
    const toolCalls = this.store.listToolCalls(session.id, 20);
    const backgroundJobs = activeBackgroundJobs(this.store.listToolCalls(session.id, 200));
    const attempts = session.campaignId ? this.store.listTestAttempts(session.campaignId).slice(0, 8) : [];
    const recentMessages = messages.slice(-40);
    const latestUserRequests = recentMessages
      .filter((message) => message.role === "user")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => ((part.payload as { text?: string }).text ?? "").trim())
      .filter(Boolean)
      .slice(-8);
    const latestAssistantText = recentMessages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => ((part.payload as { text?: string }).text ?? "").trim())
      .filter(Boolean)
      .slice(-6);
    return [
      `session summary for ${sessionDisplayName(session)}`,
      `Provider/model: ${session.provider ?? "env"}/${session.model ?? "env"}`,
      ...(session.summary ? ["", "Prior compacted context:", takeBytes(session.summary, 24 * 1024, "head")] : []),
      "",
      "Recent user requests:",
      ...nonEmpty(latestUserRequests.map((text) => `- ${text.slice(0, 240)}`)),
      "",
      "Recent assistant outcomes:",
      ...nonEmpty(latestAssistantText.map((text) => `- ${text.slice(0, 240)}`)),
      "",
      "Open todos:",
      ...nonEmpty(todos.filter((todo) => todo.status !== "done" && todo.status !== "cancelled").map((todo) => `- [${todo.status}/${todo.priority}] ${todo.text}`)),
      "",
      "Notes:",
      ...nonEmpty(notes.map((note) => `- ${note.text}`)),
      "",
      "Memory:",
      ...nonEmpty(memory.map((item) => `- ${item.kind}:${item.key}=${JSON.stringify(item.value).slice(0, 160)}`)),
      "",
      "Evidence:",
      ...nonEmpty(evidence.map((item) => `- ${item.id}: ${item.title} — ${item.summary.slice(0, 180)}`)),
      "",
      "Findings:",
      ...nonEmpty(findings.map((finding) => `- ${finding.severity}: ${finding.title} on ${finding.target}`)),
      ...(attempts.length > 0 ? ["", "Campaign test attempts:", ...attempts.map((attempt) => `- ${attempt.status}/${attempt.evidenceLevel}: ${attempt.title} on ${attempt.target}`)] : []),
      "",
      "Recent tools:",
      ...nonEmpty(toolCalls.map((call) => `- ${call.tool} ${call.status}`)),
      "",
      "Active background jobs:",
      ...renderBackgroundJobs(backgroundJobs),
      "",
      "Next-step guidance:",
      ...nonEmpty([
        ...todos.filter((todo) => todo.status !== "done" && todo.status !== "cancelled").slice(0, 5).map((todo) => `- Continue todo: ${todo.text}`),
        ...(toolCalls[0] ? [`- Last tool was ${toolCalls[0].tool} with status ${toolCalls[0].status}; continue from that result.`] : []),
        ...(backgroundJobs.length ? ["- Poll an existing relevant background job before starting an equivalent task."] : [])
      ])
    ].join("\n");
  }

  contextSummary(session: Session): string {
    const messages = this.store.listMessages(session.id, 25);
    const evidence = this.store.listEvidence(session.id).slice(-10);
    const notes = this.store.listNotes(session.id).slice(-10);
    const memory = this.store.listMemory(session.id).slice(0, 20);
    const todos = this.store.listTodos(session.id, { limit: 20 });
    const toolCalls = this.store.listToolCalls(session.id, 20);
    return JSON.stringify({
      durableSummary: session.summary,
      summaryUpdatedAt: session.summaryUpdatedAt,
      recentMessages: messages.slice(-12).map((message) => ({
        role: message.role,
        parts: message.parts.map((part) => ({ type: part.type, payload: part.payload })).slice(-3)
      })),
      evidence: evidence.map((item) => ({ id: item.id, title: item.title, summary: item.summary })),
      notes: notes.map((note) => note.text),
      memory: memory.map((item) => ({ kind: item.kind, key: item.key, value: item.value })),
      todos: todos.map((todo) => ({ id: todo.id, text: todo.text, status: todo.status, priority: todo.priority })),
      toolCalls: toolCalls.map((call) => ({ id: call.id, tool: call.tool, status: call.status })),
      activeBackgroundJobs: activeBackgroundJobs(this.store.listToolCalls(session.id, 200))
    });
  }

  inspectContext(session: Session, hypotheticalInput?: string): ContextManifest {
    return this.assembleContext({
      session: this.store.loadSession(session.id),
      ...(hypotheticalInput?.trim() ? { userText: hypotheticalInput.trim() } : {}),
      availableTools: listToolsForSession(session),
      contextWindow: resolveContextWindow(this.planner?.contextWindow),
      maxOutputTokens: resolveMaxOutputTokens(this.planner?.maxOutputTokens),
      ...this.contextBudgetInput()
    }).manifest;
  }

  private contextBudgetInput(): { maxInputTokens?: number } {
    const maxInputTokens = this.maxInputTokens ?? (this.inheritConfig ? loadConfig(this.workspace).context?.maxInputTokens : undefined);
    return maxInputTokens ? { maxInputTokens } : {};
  }

  private buildConversationHistory(session: Session, limitMessages = Number.MAX_SAFE_INTEGER): ConversationEntry[] {
    return projectConversationHistory(this.store.listContextMessages(session.id, limitMessages), { full: true }).entries;
  }
}

function plannerRetryState(error: unknown, attempt: number, safeToReplay: boolean): { willRetry: boolean; maxAttempts: number; delayMs: number; reason: string } {
  if (error instanceof PlannerOutputValidationError) {
    const maxAttempts = 2;
    return {
      willRetry: safeToReplay && attempt < maxAttempts,
      maxAttempts,
      delayMs: 0,
      reason: "invalid_output"
    };
  }
  const decision = classifyModelRetry(error);
  const maxAttempts = decision.retryable ? MODEL_RETRY_MAX_ATTEMPTS : 1;
  const willRetry = safeToReplay && decision.retryable && attempt < maxAttempts;
  return {
    willRetry,
    maxAttempts,
    delayMs: willRetry ? modelRetryDelayMs(error, attempt) : 0,
    reason: decision.reason
  };
}

class PlannerOutputValidationError extends Error {
  override name = "PlannerOutputValidationError";
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => { clearTimeout(timer); cleanup(); resolve(); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isProviderToolDef(value: unknown): value is ProviderToolDef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tool = value as Partial<ProviderToolDef>;
  return typeof tool.name === "string"
    && typeof tool.description === "string"
    && !!tool.parameters
    && typeof tool.parameters === "object"
    && !Array.isArray(tool.parameters);
}

function sameProviderToolCatalog(left: ProviderToolDef[], right: ProviderToolDef[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function completedToolCallStatus(result: ToolResult): ToolCallRecord["status"] {
  if (result.status === "running_background") return "running_background";
  return result.ok ? "done" : "error";
}

function recoveredJobSummary(job: BackgroundJob): string {
  if (job.result && typeof job.result === "object") {
    if ("response" in job.result) return String((job.result as { response?: unknown }).response ?? "background agent completed.");
    if ("output" in job.result) return String((job.result as { output?: unknown }).output ?? "background process completed.");
  }
  return `background job ${job.status}.`;
}

function outputArtifactBytes(result: ToolResult): unknown {
  const artifact = result.metadata?.outputArtifact;
  if (artifact && typeof artifact === "object" && "bytes" in artifact) {
    return (artifact as { bytes?: unknown }).bytes;
  }
  return result.metadata?.fullOutputBytes;
}

function outputArtifactPath(result: ToolResult): unknown {
  const artifact = result.metadata?.outputArtifact;
  if (artifact && typeof artifact === "object" && "path" in artifact) {
    return (artifact as { path?: unknown }).path;
  }
  return result.metadata?.fullOutputArtifactPath;
}

function shutdownGracePeriod(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SHUTDOWN_GRACE_PERIOD_MS;
  return Math.max(0, value);
}

function waitForShutdownFinalization(finalization: Promise<void>, gracePeriodMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(false);
    }, gracePeriodMs);
    finalization.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function withDeadlineMs<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function positiveFinite(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isWorkspaceTransitionTool(tool: ToolDefinition): boolean {
  const name = canonicalToolName(tool.name);
  return name === "worktree_enter" || name === "worktree_exit";
}

async function runHostGit(cwd: string, args: string[]): Promise<string> {
  const result = await runCapturedProcess("git", args, {
    cwd,
    timeoutMs: 30_000,
    maxOutputBytes: INTERNAL_PROCESS_OUTPUT_MAX_BYTES
  });
  if (result.timedOut) throw new Error(`git ${args[0] ?? "command"} timed out`);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed with exit code ${result.exitCode}`);
  return result.stdout;
}

async function registeredWorktree(root: string, wantedPath: string): Promise<{ ref: string; branch?: string } | undefined> {
  const output = await runHostGit(root, ["worktree", "list", "--porcelain"]);
  let path = "";
  let ref = "";
  let branch: string | undefined;
  const match = (): { ref: string; branch?: string } | undefined => {
    if (!sameExistingPath(path, wantedPath) || !ref) return undefined;
    return { ref, ...(branch ? { branch } : {}) };
  };
  for (const line of `${output}\n`.split("\n")) {
    if (!line) {
      const found = match();
      if (found) return found;
      path = "";
      ref = "";
      branch = undefined;
    } else if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      ref = line.slice("HEAD ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      branch = line.slice("branch refs/heads/".length);
    }
  }
  return undefined;
}

function sameExistingPath(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}
