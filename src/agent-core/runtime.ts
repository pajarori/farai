import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentPromptResult, BackgroundJob, Message, MessageWithParts, Note, QueuedUserInput, Session, SessionEvent, SessionMailboxItem, ToolCallRecord, ToolContext, ToolDefinition, ToolResult, Turn } from "../types";
import { SqliteStore } from "../agent-store/sqlite-store";
import { getTool, listToolsForSession, refreshMcpTools } from "../agent-tools/registry";
import { formatMcpInventory, listMcpServerStatuses, stopMcpToolsForSession } from "../agent-tools/mcp-manager";
import { stopBrowserContextsForSession } from "../agent-tools/browser/context-manager";
import { renderCtfNotes } from "../agent-report/markdown";
import { serviceRegistry } from "../agent-tools/services/registry";
import { containerNameForSession, KaliContainerBackend, type ContainerStatus } from "../agent-container/kali";
import type { ToolExecutionBackend } from "../agent-tools/shared/backend";
import { id, nowIso } from "../utils";
import { takeBytes } from "../agent-tools/shared/output-bound";
import { renderModelToolResultEnvelope } from "./context-builder";
import { sanitizeToolOutput } from "../agent-tools/shared/output-sanitize";
import { buildChatRequest, buildToolsPayload, ChatProviderPlanner, createChatProviderForSession, createPlannerForSessionAsync, PlannerHttpError, type ConversationEntry, type PlanStreamEvent, type PlannerAction, type PlannerInput, type PlannerProvider } from "./provider";
import type { ChatProvider, ProviderToolDef } from "./provider/protocol";
import { buildSystemPrompt } from "./provider/system-prompt";
import { resolveContextWindow, resolveMaxOutputTokens, resolveMaxSteps, resolveMaxTurnMs } from "./model-registry";
import { defaultModelSelection } from "./model-catalog";
import { sessionManager } from "../agent-tools/shared/session-manager";
import { oastEvidenceForSession, parseOastEvents } from "../agent-tools/callback/oast-parser";
import { activeBackgroundJobs, findEquivalentBackgroundJob, processIdFromArgs, renderBackgroundJobs, stableValue, type ActiveBackgroundJob } from "./loop/background";
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
import { JobManager } from "./jobs/manager";
import { ContextEngine, formatContextManifest, mergeProviderToolCatalog, type ContextManifest, type ContextProjection, type ContextRequest } from "./context-engine";
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
import { calculateUsageCost, estimateMaximumRequestCost, type UsageTokenCounts } from "./model-pricing";
import { recordSessionLocation } from "../session-catalog";

export { activeBackgroundJobs } from "./loop/background";
export type { ActiveBackgroundJob } from "./loop/background";

const TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
const REASONING_MAX_BYTES = 8 * 1024;
const STREAM_RENDER_INTERVAL_MS = 100;
const STREAM_PERSIST_INTERVAL_MS = 2_000;
const MAX_RECOVERABLE_AUTO_CONTINUE = 3;
const LIVE_OUTPUT_MAX_BYTES = 2 * 1024;
const LIVE_OUTPUT_FLUSH_INTERVAL_MS = 150;
const LIVE_OUTPUT_INITIAL_DELAY_MS = 320;
const TOOL_OUTPUT_HEAD_BYTES = 24 * 1024;
const TOOL_OUTPUT_TAIL_BYTES = 24 * 1024;
const TOOL_HUMAN_RESULT_MAX_BYTES = 24 * 1024;
const BACKGROUND_COMPLETION_MAX_STEPS = 1;
const LOOP_SUPERVISION_NO_PROGRESS_STEPS = 12;
const LOOP_SUPERVISION_STEER_INTERVAL = 5;
const LOOP_PATTERN_MAX_PERIOD = 8;
const PROGRESS_ACTION_TOOLS = new Set(["http_request", "subdomain_enum", "dir_enum", "port_scan", "nmap_scan", "fs_edit", "fs_write", "patch_apply", "code_write_script", "campaign_verify", "campaign_test", "callback_oast", "exploit_search"]);
const AUTO_COMPACTION_CONTINUATION = "[internal continuation after context compaction: Continue the active user task from the compacted prior context. Do not repeat, regenerate, or explain the summary. Resume with the exact next useful action.]";
const WRAPUP_MODEL_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_GRACE_PERIOD_MS = 2_000;
const RUNTIME_LEASE_MS = 60_000;
const RUNTIME_HEARTBEAT_MS = 15_000;
const RESTART_TOOL_ERROR = "Interrupted by runtime restart; tool execution was not replayed.";
const STEP_LIMIT_WRAPUP_DIRECTIVE = "You have reached the maximum number of steps allowed for this turn, so tools are no longer available. Do not attempt to call any tool. In a few sentences, summarize what you accomplished, the key findings or evidence so far, any blockers, and the single most useful next step. This is your final message for this turn.";
const TIME_LIMIT_WRAPUP_DIRECTIVE = "You have reached the interactive wall-clock budget for this turn, so tools are no longer available. Do not attempt to call any tool. Concisely summarize completed work, proven evidence, active background jobs, remaining uncertainty, and the single best next action. This is your final message for this turn.";

type ToolPlannerAction = Extract<PlannerAction, { kind: "tool" }>;
type ToolActionOutcome = { shouldContinue: boolean; resetAutoContinue?: boolean; cancelled?: boolean };
type StepControl = { cancelled?: boolean; timedOut?: boolean; empty?: boolean; shouldContinue: boolean };
type QueuedInputAction = QueuedUserInput["action"];
type ProviderSlot = { contextMessage: Message; assistantMessage: Message };
type ProviderCatalogPayload = { key: string; tools: ProviderToolDef[] };
type StreamingPartsState = {
  textPartId?: string;
  textAccum: string;
  lastTextRender?: number;
  lastTextPersist?: number;
  reasoningPartId?: string;
  reasoningAccum?: string;
  lastReasoningRender?: number;
};
type ToolErrorState = {
  interrupted?: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  quarantined?: boolean;
  reason?: string;
};
type RenderedToolResult = { result: ToolResult; humanResult: string; modelResult: string };

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

class ToolDeadlineError extends Error {
  constructor(readonly tool: string, readonly timeoutMs: number) {
    super(`Tool ${tool} timed out after ${timeoutMs}ms`);
    this.name = "ToolDeadlineError";
  }
}

class ToolScopeQuarantinedError extends Error {
  constructor(readonly scope: string, readonly cause: Error) {
    super(`Tool concurrency scope ${scope} is quarantined after: ${cause.message}`);
    this.name = "ToolScopeQuarantinedError";
  }
}

export type SessionPatch = Partial<Pick<Session, "title" | "provider" | "model" | "phase" | "campaignId" | "toolScope">>;
export type ShutdownOptions = { gracePeriodMs?: number };
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
  private readonly wakePromises = new Map<string, Promise<void>>();
  private readonly queuedInputWakePromises = new Map<string, Promise<void>>();
  private readonly scheduledPromptMailboxIds = new Set<string>();
  private readonly modelCallsByTurn = new Map<string, number>();
  private readonly providerCatalogs = new Map<string, ProviderToolDef[]>();
  private readonly streamingParts = new Map<string, StreamingPartsState>();
  private readonly toolInputPreviews = new Map<string, { id?: string; name: string; arguments: string }>();
  private readonly toolExecutionGate = new ToolExecutionGate();
  private readonly subagentGate: SubagentGate;
  private readonly subagentWorkspaceMutationGate = new SubagentGate(1);
  private readonly pendingSteeringContext = new Map<string, string[]>();
  private hooks: HookDefinition[] | undefined;
  private readonly firedSessionStart = new Set<string>();
  private readonly pendingHookContext = new Map<string, string[]>();
  private readonly autoCompactFailures = new Map<string, number>();
  private readonly compactionControllers = new Map<string, AbortController>();
  private readonly runtimeId = id();
  private readonly mailbox: SessionMailbox;
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
    this.knowledgeEnabled = options.enableKnowledge !== false;
    this.hooksEnabled = options.enableHooks !== false;
    this.mcpEnabled = options.enableMcp !== false;
    this.executionBackend = options.executionBackend;
    this.registerSessionCatalog = options.registerSessionCatalog !== false;
    this.contextEngine = new ContextEngine(workspace, this.store, this.fileState, () => this.knowledge(), options.enableSkills !== false, options.enableProjectInstructions !== false);
    this.lsp = new LspManager(workspace, config.lsp);
    this.subagentGate = new SubagentGate(options.maxConcurrentSubagents ?? config.maxConcurrentSubagents ?? 4);
    this.maxSteps = resolveMaxSteps(options.maxSteps ?? config.maxSteps);
    this.maxTurnMs = resolveMaxTurnMs(options.maxTurnSeconds ?? config.maxTurnSeconds);
    this.maxCostUsd = positiveFinite(options.maxCostUsd ?? config.maxCostUsd);
    this.maxInputTokens = positiveFinite(options.maxInputTokens);
    this.mailbox = new SessionMailbox(this.store, this.runtimeId);
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
    this.shuttingDown = true;
    for (const actor of this.actors.values()) actor.close();
    this.shutdownController.abort("runtime shutdown");
    for (const controller of this.compactionControllers.values()) controller.abort("runtime shutdown");
    this.compactionControllers.clear();
    for (const controllers of this.turnControllers.values()) {
      for (const controller of controllers) controller.abort("runtime shutdown");
    }
    this.turnControllers.clear();
    for (const controller of this.activeToolControllers) controller.abort("runtime shutdown");
    for (const controller of this.subagentControllers.values()) controller.abort("runtime shutdown");
    const drain = Promise.allSettled([
      ...[...this.actors.values()].map((actor) => actor.idle()),
      this.toolExecutionGate.idle(),
      this.subagentGate.idle(),
      this.subagentWorkspaceMutationGate.idle(),
      ...(this.recoveryPromise ? [this.recoveryPromise] : [])
    ]);
    this.shutdownFinalizationPromise = (async () => {
      let shutdownError: unknown;
      try {
        await drain;
        this.activeToolControllers.clear();
        this.activeToolLeases.clear();
        this.subagentControllers.clear();
        this.actors.clear();
        await this.lsp.shutdown();
        if (this.store.isOpen()) {
          const ownedJobs = this.store.listJobsByRuntime(this.runtimeId)
            .filter((job) => !["succeeded", "failed", "cancelled", "lost"].includes(job.status));
          await Promise.allSettled(ownedJobs.map((job) => this.jobs.cancel(job.id, false)));
        }
        if (this.store.isOpen()) {
          for (const session of this.store.listSessions(10_000, { includeArchived: true })) {
            await stopBrowserContextsForSession(session.id);
            await stopMcpToolsForSession(session.id);
            serviceRegistry.unregisterSession(session.id);
          }
        }
      } catch (error) {
        shutdownError = error;
      } finally {
        this.stopRuntimeLease();
        this.knowledgeStore?.close();
        this.knowledgeStore = null;
        this.store.close();
      }
      if (shutdownError) throw shutdownError;
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

  private startRuntimeLease(): void {
    this.store.renewRuntimeLease(this.runtimeId, RUNTIME_LEASE_MS);
    if (this.runtimeHeartbeat) return;
    this.runtimeHeartbeat = setInterval(() => {
      if (this.shuttingDown || !this.store.isOpen()) return;
      try { this.store.renewRuntimeLease(this.runtimeId, RUNTIME_LEASE_MS); } catch {
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
      const activeRuntimeIds = new Set(this.store.listActiveRuntimeIds());
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
        this.jobs.markLost(job.id, "Background execution owner was lost during runtime restart. The original work was not replayed.", job.agentMode !== "attached");
      }
      for (const job of this.store.listTerminalJobsMissingMailbox()) this.jobs.repairTerminalMailbox(job.id);
      for (const session of sessions) this.reconcileRecoveredBackgroundTools(session.id, activeRuntimeIds);
      this.recovered = true;
      for (const sessionId of this.store.listSessionsWithQueuedMailbox()) {
        const session = this.store.loadSession(sessionId);
        if (!session.archivedAt) void this.wakePendingMailbox(sessionId);
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

  private settleToolError(toolCall: ToolCallRecord, error: string, state: ToolErrorState = {}, emitEvent = true): ToolCallRecord {
    const payload = {
      toolCallId: toolCall.id,
      tool: toolCall.tool,
      error,
      interrupted: state.interrupted ?? false,
      cancelled: state.cancelled ?? false,
      timedOut: state.timedOut ?? false,
      ...(state.quarantined !== undefined ? { quarantined: state.quarantined } : {}),
      ...(state.reason ? { reason: state.reason } : {})
    };
    const settled = this.store.settleToolCall(
      { ...toolCall, status: "error" },
      { type: "error", payload }
    ).toolCall;
    if (emitEvent) {
      try { this.event(toolCall.sessionId, "error", payload); } catch {  }
    }
    return settled;
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
    return this.settleToolError(toolCall, error, state, false);
  }

  private recordRecoveredToolSuccess(toolCall: ToolCallRecord, summary: string): ToolCallRecord {
    return this.store.settleToolCall(
      { ...toolCall, status: "done" },
      { type: "tool_result", payload: { toolCallId: toolCall.id, tool: toolCall.tool, result: `status: done\nsummary: ${summary}` } }
    ).toolCall;
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
    if (item.triggerPolicy === "wake" && this.recovered && !this.shuttingDown) void this.wakeCompletionSession(item.sessionId, "wake");
  }

  private get hookRunner(): HookRunner {
    return {
      mcp: async (hook, payload) => {
        const session = this.store.loadSession(payload.sessionId);
        const result = await callMcpServerTool({ workspace: this.workspace, session, server: hook.mcp!.server, tool: hook.mcp!.tool, args: payload });
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
    this.mailbox.enqueue({
      sessionId,
      kind: "user",
      payload: { text: trimmed, inputMode: "steer" },
      triggerPolicy: "interrupt",
      dedupeKey: `steer:${id()}`
    });
    return true;
  }

  queueUserInput(sessionId: string, text: string, action: QueuedInputAction = queuedInputAction(text)): QueuedUserInput | undefined {
    const trimmed = text.trim();
    if (!trimmed || this.shuttingDown) return undefined;
    const item = this.mailbox.enqueue({
      sessionId,
      kind: "user",
      payload: { text: trimmed, inputMode: "queued_followup", action },
      triggerPolicy: "queue",
      dedupeKey: `queued-input:${id()}`
    });
    this.event(sessionId, "mailbox_queued", { mailboxId: item.id, kind: item.kind, sequence: item.sequence, inputMode: "queued_followup", action });
    if (!this.hasRunningTurn(sessionId) && !this.compactionControllers.has(sessionId)) void this.wakeQueuedUserInputs(sessionId);
    return queuedUserInput(item);
  }

  listQueuedUserInputs(sessionId: string): QueuedUserInput[] {
    return this.mailbox.queued(sessionId).map(queuedUserInput).filter((item): item is QueuedUserInput => Boolean(item));
  }

  takeBackQueuedUserInput(sessionId: string): QueuedUserInput | undefined {
    const item = [...this.mailbox.queued(sessionId)].reverse().find((candidate) => queuedFollowupUserInput(candidate));
    if (!item || !this.mailbox.cancel(item.id)) return undefined;
    this.event(sessionId, "mailbox_consumed", { mailboxId: item.id, sequence: item.sequence, disposition: "taken_back" });
    return queuedFollowupUserInput(item);
  }

  hasRunningTurn(sessionId: string): boolean {
    return this.store.listTurns(sessionId, 5).some((turn) => turn.status === "running");
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
    const items = this.mailbox.claim(session.id, "interrupt");
    if (items.length === 0) return undefined;
    for (const item of items) {
      const text = mailboxText(item);
      if (!text) continue;
      const userMessage = this.store.createMessage({ sessionId: session.id, turnId: turn.id, role: "user" });
      this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: userMessage.id, type: "text", payload: { text } });
      this.event(session.id, "text", { role: "user", text });
    }
    this.mailbox.consume(items);
    const context = this.pendingSteeringContext.get(session.id) ?? [];
    context.push("The latest user message arrived while prior model/tool work was still running. Reconcile it against any tool results that completed afterward; if those results already satisfy the request, report them instead of repeating the work.");
    this.pendingSteeringContext.set(session.id, context);
    return this.createProviderSlot(session, turn);
  }

  private drainQueuedFollowupMessages(session: Session, turn: Turn): ProviderSlot | undefined {
    const candidates = this.mailbox.queued(session.id).filter((item) => {
      const queued = queuedFollowupUserInput(item);
      return queued?.action === "plain";
    });
    const items = candidates.map((item) => this.mailbox.claimById(item.id)).filter((item): item is SessionMailboxItem => Boolean(item));
    if (items.length === 0) return undefined;
    for (const item of items) {
      const text = mailboxText(item);
      if (!text) continue;
      const userMessage = this.store.createMessage({ sessionId: session.id, turnId: turn.id, role: "user" });
      this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: userMessage.id, type: "text", payload: { text } });
      this.event(session.id, "text", { role: "user", text, queued: true });
    }
    this.mailbox.consume(items);
    const context = this.pendingSteeringContext.get(session.id) ?? [];
    context.push("Queued user follow-up messages were delivered at a safe boundary after the prior model/tool step. Treat them as newer intent and do not repeat tool work that already completed.");
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

  updateSession(sessionId: string, patch: SessionPatch): Session {
    const session = this.store.updateSession(sessionId, patch);
    this.recordSession(session);
    return session;
  }

  async forkSession(sessionId: string, title?: string): Promise<Session> {
    const session = await this.store.forkSession(sessionId, title);
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
    await stopMcpToolsForSession(sessionId).catch(() => {});
    await new KaliContainerBackend({ workspace: this.workspace, containerName: containerNameForSession(sessionId) })
      .stopPersistent()
      .catch(() => {});
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

  async abortSessionTree(sessionId: string, reason = "run deadline exceeded", options: { stopContainers?: boolean } = {}): Promise<void> {
    const sessions = this.sessionTree(sessionId).reverse();
    for (const session of sessions) {
      this.cancelCompaction(session.id);
      for (const turn of this.store.listTurns(session.id, 10_000)) {
        if (turn.status === "running") this.cancelTurn(turn.id, reason);
      }
      this.store.cancelMailbox(session.id);
      await this.cancelSessionJobs(session.id);
      await this.lsp.shutdownSession(session.id).catch(() => {});
      await stopBrowserContextsForSession(session.id).catch(() => {});
      await stopMcpToolsForSession(session.id).catch(() => {});
      serviceRegistry.unregisterSession(session.id);
      if (options.stopContainers !== false) {
        await new KaliContainerBackend({ workspace: this.workspace, containerName: containerNameForSession(session.id) })
          .stopPersistent()
          .catch(() => {});
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
      this.streamingParts.delete(turn.id);
    }
    return this.store.clearSessionChat(sessionId);
  }

  containerStatus(sessionId: string): Promise<ContainerStatus> {
    return new KaliContainerBackend({ workspace: this.workspace, containerName: containerNameForSession(sessionId) }).status();
  }

  async startContainer(sessionId: string): Promise<void> {
    const result = await new KaliContainerBackend({ workspace: this.workspace, containerName: containerNameForSession(sessionId) }).startPersistent();
    if (result.exitCode !== 0) throw new Error(result.stderr || "Could not start Kali container");
  }

  async refreshMcp(session: Session): Promise<void> {
    if (!this.mcpEnabled) return;
    await refreshMcpTools({
      workspace: this.workspace,
      session,
      background: true,
      includeResources: false,
      onStartupEvent: (event) => this.event(session.id, event.type, event)
    });
  }

  async stopContainer(sessionId: string): Promise<void> {
    await stopBrowserContextsForSession(sessionId).catch(() => {});
    await stopMcpToolsForSession(sessionId).catch(() => {});
    const result = await new KaliContainerBackend({ workspace: this.workspace, containerName: containerNameForSession(sessionId) }).stopPersistent();
    if (result.exitCode !== 0) throw new Error(result.stderr || "Could not stop Kali container");
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
    writeFileSync(path, markdown);
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
    const item = this.mailbox.enqueue({
      sessionId: session.id,
      kind: "user",
      payload: { text: input, inputMode: "turn" },
      triggerPolicy: "queue",
      dedupeKey: `prompt:${id()}`
    });
    this.scheduledPromptMailboxIds.add(item.id);
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
      this.scheduledPromptMailboxIds.delete(item.id);
    }
  }

  private wakeQueuedInput(sessionId: string): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    return this.actor(sessionId).run(async () => {
      const items = this.mailbox.claim(sessionId, "interrupt");
      if (items.length === 0) return;
      const text = items.map(mailboxText).filter(Boolean).join("\n\n");
      try {
        await this.runPrompt(this.store.loadSession(sessionId), text);
        this.mailbox.consume(items);
      } catch {
        this.mailbox.release(items);
      }
    }).catch(() => undefined);
  }

  private wakePendingMailbox(sessionId: string): Promise<void> {
    const queued = this.mailbox.queued(sessionId);
    const nextUserInput = queued.find((item) => item.kind === "user" && item.triggerPolicy === "queue");
    if (nextUserInput && !this.scheduledPromptMailboxIds.has(nextUserInput.id)) {
      return this.wakeQueuedUserInputs(sessionId);
    }
    if (queued.some((item) => item.triggerPolicy === "wake")) return this.wakeCompletionSession(sessionId, "wake");
    if (queued.some((item) => item.triggerPolicy === "interrupt")) return this.wakeQueuedInput(sessionId);
    if (queued.some((item) => item.triggerPolicy === "context")) return this.wakeCompletionSession(sessionId, "context");
    return Promise.resolve();
  }

  private wakeQueuedUserInputs(sessionId: string): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    const existing = this.queuedInputWakePromises.get(sessionId);
    if (existing) return existing;
    const wake = this.actor(sessionId).run(async () => {
      while (!this.shuttingDown) {
        const item = this.mailbox.queued(sessionId).find((candidate) =>
          candidate.kind === "user"
          && candidate.triggerPolicy === "queue"
        );
        if (!item) return;
        if (this.scheduledPromptMailboxIds.has(item.id)) return;
        const claimed = this.mailbox.claimById(item.id);
        if (!claimed) continue;
        const text = mailboxText(claimed);
        if (!text) {
          this.mailbox.consume([claimed]);
          continue;
        }
        const completionItems = text.trimStart().startsWith("/")
          ? []
          : this.mailbox.claim(sessionId, "context", BACKGROUND_MAILBOX_BATCH_SIZE);
        try {
          if (text.trim() === "/clear") {
            this.cancelCompaction(sessionId);
            await this.cancelSessionJobs(sessionId);
            this.clearSessionState(sessionId);
            return;
          }
          await this.runPrompt(this.store.loadSession(sessionId), text, { mailboxItems: completionItems });
          this.mailbox.consume([claimed]);
          this.mailbox.consume(completionItems);
          this.event(sessionId, "mailbox_consumed", { mailboxId: claimed.id, sequence: claimed.sequence });
          for (const completion of completionItems) {
            this.event(sessionId, "mailbox_consumed", { mailboxId: completion.id, sequence: completion.sequence });
          }
        } catch {
          this.mailbox.release([claimed]);
          this.mailbox.release(completionItems);
          return;
        }
      }
    });
    const tracked = wake.catch(() => undefined).finally(() => {
      if (this.queuedInputWakePromises.get(sessionId) === tracked) this.queuedInputWakePromises.delete(sessionId);
      if (this.shuttingDown || !this.store.isOpen()) return;
      const nextUserInput = this.mailbox.queued(sessionId).find((item) => item.kind === "user" && item.triggerPolicy === "queue");
      const hasDeliverable = Boolean(nextUserInput && !this.scheduledPromptMailboxIds.has(nextUserInput.id));
      if (hasDeliverable) void this.wakeQueuedUserInputs(sessionId);
      else if (this.recovered) void this.wakePendingMailbox(sessionId);
    });
    this.queuedInputWakePromises.set(sessionId, tracked);
    return tracked;
  }

  private wakeCompletionSession(sessionId: string, triggerPolicy: "wake" | "context"): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    const existing = this.wakePromises.get(sessionId);
    if (existing) return existing;
    const wake = this.actor(sessionId).run(async () => {
      while (!this.shuttingDown) {
        let items: SessionMailboxItem[];
        try {
          items = this.mailbox.claim(sessionId, triggerPolicy, BACKGROUND_MAILBOX_BATCH_SIZE);
        } catch {
          return;
        }
        if (items.length === 0) return;
        const text = renderMailboxItems(items);
        try {
          await this.runPrompt(this.store.loadSession(sessionId), text, { source: "background", mailboxItems: items });
          this.mailbox.consume(items);
          for (const item of items) this.event(sessionId, "mailbox_consumed", { mailboxId: item.id, sequence: item.sequence });
        } catch {
          if (this.store.isOpen()) {
            try { this.mailbox.release(items); } catch {  }
          }
          return;
        }
      }
    });
    const tracked = wake.catch(() => undefined).finally(() => {
      if (this.wakePromises.get(sessionId) === tracked) this.wakePromises.delete(sessionId);
      if (this.shuttingDown || !this.store.isOpen()) return;
      try {
        void this.wakePendingMailbox(sessionId);
      } catch {  }
    });
    this.wakePromises.set(sessionId, tracked);
    return tracked;
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

    if (source === "user" && lower.startsWith("/")) {
      response = await this.handleSlash(session, turn, assistantMessage, input);
      this.persistTextPart(session.id, turn.id, assistantMessage.id, response);
      this.stopTurn(turn, "completed", "final_response");
    } else {
      response = await this.runAgentLoop(session, turn, contextMessage, assistantMessage, input, source === "user", options.mailboxItems);
    }

    if (source === "user" && !this.shuttingDown) void this.wakeQueuedUserInputs(session.id);

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
      chatProvider = this.chatProviderOverride ?? await createChatProviderForSession(session);
      planner = new ChatProviderPlanner(chatProvider);
    }
    this.store.updateTurn(turn.id, {
      plannerName: planner.name,
      provider: session.provider ?? planner.name,
      ...(session.model ? { model: session.model } : {})
    });

    let autoContinueStreak = 0;
    let resumeAfterCompaction = false;
    let canDrainQueuedFollowups = false;
    const maxSteps = userAuthored ? this.maxSteps : BACKGROUND_COMPLETION_MAX_STEPS;
    const maxTurnMs = userAuthored ? this.maxTurnMs : Number.POSITIVE_INFINITY;
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
      const elapsedMs = Date.now() - loopStartedAt;
      if (step > 0 && elapsedMs >= maxTurnMs) {
        responses.push(...await this.forceTimeLimitWrapUp(session, turn, assistantMessage, planner, maxTurnMs));
        break;
      }
      if (!timeBudgetWarned && elapsedMs >= maxTurnMs * 0.75) {
        timeBudgetWarned = true;
        const secondsLeft = Math.max(1, Math.ceil((maxTurnMs - elapsedMs) / 1_000));
        const queue = this.pendingSteeringContext.get(session.id) ?? [];
        queue.push(`The interactive turn has about ${secondsLeft} seconds left. Prioritize the highest-value remaining action, preserve evidence, and conclude cleanly instead of starting broad new work.`);
        this.pendingSteeringContext.set(session.id, queue);
      }
      this.store.updateTurn(turn.id, { stepCount: step + 1 });
      if (step >= maxSteps) {
        if (userAuthored) responses.push(...await this.forceStepLimitWrapUp(session, turn, assistantMessage, planner, maxSteps));
        else this.stopTurn(turn, "completed", "no_actions");
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
      if (canDrainQueuedFollowups) {
        const queuedSlot = this.drainQueuedFollowupMessages(session, turn);
        if (queuedSlot) {
          ({ contextMessage, assistantMessage } = queuedSlot);
          providerSlotReady = true;
        }
        canDrainQueuedFollowups = false;
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
      const context = this.assembleContext({
        session,
        ...(step === 0 && input && userAuthored && !resumeAfterCompaction ? { userText: input } : {}),
        availableTools,
        contextWindow: resolveContextWindow(planner.contextWindow),
        maxOutputTokens: resolveMaxOutputTokens(planner.maxOutputTokens),
        ...this.contextBudgetInput(),
        toolsEnabled: userAuthored,
        extraBlocks: [
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
        toolChoice: userAuthored ? "auto" : "none"
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
      canDrainQueuedFollowups = true;
    }

    if (responses.length === 0) {
      if (userAuthored && !this.turnHasTranscriptOwnedActivity(session.id, turn.id)) {
        const text = "Completed without model-visible response.";
        responses.push(text);
        this.persistTextPart(session.id, turn.id, assistantMessage.id, text);
        this.stopTurn(turn, "completed", "final_response");
      } else if (this.store.loadTurn(turn.id).status === "running") {
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
      if (call.turnId !== turnId || call.tool !== "agent_task") return false;
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
    this.store.saveUsage({
      sessionId: session.id,
      turnId: turn.id,
      provider: provider.name,
      model: provider.model ?? session.model ?? provider.name,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      ...(usage.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: usage.cacheWriteInputTokens } : {}),
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
    toolsAllowed: boolean,
    modelTimeoutMs?: number
  ): Promise<StepControl> {
    let actions: PlannerAction[];
    try {
      actions = await this.planWithRetry(planner, plannerInput, session, turn, assistantMessage, context, modelTimeoutMs, !toolsAllowed);
    } catch (error) {
      if (error instanceof ModelCallDeadlineError) return { timedOut: true, shouldContinue: false };
      throw error;
    }
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
        if (toolsAllowed) toolBatch.push(action);
        else this.recordDisabledToolCall(session, turn, assistantMessage, step, action.toolCallId ?? action.tool, action.tool, action.args);
        continue;
      }
      if (await flushToolBatch()) return { cancelled: true, shouldContinue };
      if (action.kind === "reasoning") {
        this.finalizeReasoning(session, turn, assistantMessage, planner.name, action.text);
      } else if (action.kind === "respond") {
        sawResponse = true;
        if (hasToolAction && isInternalMetaReasoning(action.text)) {
          this.discardStreamingText(turn.id);
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
    const request = buildChatRequest(plannerInput, signal);
    let lastError = "";
    this.streamingParts.delete(turn.id);
    try {
      for (let attempt = 1; ; attempt += 1) {
        this.emitPlannerAttempt(session, turn, assistantMessage, plannerName, attempt, plannerInput, context);
        const dispatched: Array<Promise<ToolActionOutcome>> = [];
        let content = "";
        let reasoning = "";
        let finishReason: string | undefined;
        let usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number } | undefined;
        const requestStarted = Date.now();
        let sawParseError = false;
        let interrupted = false;
        try {
          const iterator = provider.stream(request)[Symbol.asyncIterator]();
          for (;;) {
            const next = await abortablePromise(iterator.next(), signal);
            if (next.done) break;
            const event = next.value;
            if (signal.aborted || this.store.loadTurn(turn.id).status === "cancelled") break;
            if (this.mailbox.hasQueued(session.id, "interrupt")) { interrupted = true; break; }
            if (event.type === "text_delta") {
              content += event.delta;
              this.applyStreamEvent(session, turn, assistantMessage, { kind: "text", delta: event.delta });
            } else if (event.type === "reasoning_delta") {
              reasoning += event.delta;
            } else if (event.type === "tool_call_delta") {
              this.applyToolInputPreview(session.id, turn.id, event);
            } else if (event.type === "tool_call_complete") {
              this.finishToolInputPreview(session.id, turn.id, event.index, event.id);
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
              if (!userAuthored) {
                this.recordDisabledToolCall(session, turn, assistantMessage, step, toolCallId ?? toolName, toolName, args);
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
          if (signal.aborted) void iterator.return?.();
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
          this.prepareStreamingRetry(turn.id);
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
        const reasoningText = reasoning.trim() ? takeBytes(reasoning.trim(), REASONING_MAX_BYTES, "head") : undefined;
        if (reasoningText) this.finalizeReasoning(session, turn, assistantMessage, plannerName, reasoningText);
        const rawRespondText = content.trim();
        const respondText = dispatched.length > 0 && isInternalMetaReasoning(rawRespondText) ? "" : rawRespondText;
        if (!respondText && rawRespondText && dispatched.length > 0) this.discardStreamingText(turn.id);
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
      release();
    }
  }

  private applyToolInputPreview(
    sessionId: string,
    turnId: string,
    event: Extract<import("./provider/protocol").ProviderStreamEvent, { type: "tool_call_delta" }>
  ): void {
    const key = `${turnId}:${event.index}`;
    const current = this.toolInputPreviews.get(key) ?? { name: "", arguments: "" };
    if (event.id) current.id = event.id;
    if (event.name) current.name = event.name;
    if (event.argumentsDelta) current.arguments += event.argumentsDelta;
    this.toolInputPreviews.set(key, current);
    this.store.publishTransientEvent({
      id: `preview:${key}`,
      sessionId,
      type: current.arguments.length === (event.argumentsDelta?.length ?? 0) ? "tool_input_start" : "tool_input_delta",
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

  private finishToolInputPreview(sessionId: string, turnId: string, index: number, providerToolCallId?: string): void {
    const key = `${turnId}:${index}`;
    const current = this.toolInputPreviews.get(key);
    this.toolInputPreviews.delete(key);
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
        rawArguments: current?.arguments ?? ""
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
        directTools: context.tools.direct,
        deferredTools: context.tools.deferred
      } : {})
    };
  }

  private finalizeReasoning(session: Session, turn: Turn, assistantMessage: Message, plannerName: string, text: string): void {
    const rationale = normalizeReasoningSummary(text);
    const state = this.streamingParts.get(turn.id);
    if (!rationale) {
      if (state?.reasoningPartId) this.store.updatePartPayload(state.reasoningPartId, { planner: plannerName, rationale: "" });
      if (state) {
        delete state.reasoningPartId;
        delete state.reasoningAccum;
        delete state.lastReasoningRender;
      }
      return;
    }
    this.event(session.id, "reasoning_summary", { planner: plannerName, rationale });
    if (state?.reasoningPartId) {
      this.store.updatePartPayload(state.reasoningPartId, { planner: plannerName, rationale });
      delete state.reasoningPartId;
      delete state.reasoningAccum;
      delete state.lastReasoningRender;
    } else {
      this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "reasoning_summary", payload: { planner: plannerName, rationale } });
    }
  }

  private async applyRespond(session: Session, turn: Turn, assistantMessage: Message, plannerName: string, text: string, truncated: boolean, recoverable: boolean, responses: string[], autoContinue: { streak: number }): Promise<boolean> {
    if (this.isRedundantAgentTaskResponse(session.id, turn.id, text)) {
      this.discardStreamingText(turn.id);
      return false;
    }
    responses.push(text);
    const streamed = this.streamingParts.get(turn.id);
    if (streamed?.textPartId) {
      this.store.updatePartPayload(streamed.textPartId, { text });
      delete streamed.textPartId;
      streamed.textAccum = "";
    } else {
      this.persistTextPart(session.id, turn.id, assistantMessage.id, text);
    }
    this.event(session.id, "text", { role: "assistant", text, planner: plannerName, truncated, recoverable });
    if (truncated || recoverable) {
      if (autoContinue.streak < MAX_RECOVERABLE_AUTO_CONTINUE) {
        autoContinue.streak += 1;
        return true;
      }
      const reason = truncated
        ? `kept getting cut off by its token limit ${MAX_RECOVERABLE_AUTO_CONTINUE} times in a row. Consider raising maxOutputTokens in ~/.local/pajarori/farai/config.toml or asking a smaller follow-up question`
        : `kept failing to produce a usable response ${MAX_RECOVERABLE_AUTO_CONTINUE} times in a row`;
      const notice = `(Model ${reason} — stopping auto-continue.)`;
      responses.push(notice);
      this.persistTextPart(session.id, turn.id, assistantMessage.id, notice);
      this.event(session.id, "text", { role: "assistant", text: notice, planner: plannerName });
    }
    return false;
  }

  private isRedundantAgentTaskResponse(sessionId: string, turnId: string, text: string): boolean {
    const candidate = comparableProse(text);
    if (candidate.length < 40) return false;
    const outputs = this.store.listMessages(sessionId, 200)
      .flatMap((message) => message.parts)
      .filter((part) => part.turnId === turnId && part.type === "tool_result")
      .flatMap((part) => agentTaskOutput(part.payload));
    return outputs.some((output) => substantiallySameProse(candidate, comparableProse(output)));
  }

  private recordToolParseError(session: Session, turn: Turn, assistantMessage: Message, step: number, toolCallId: string, tool: string, error: string, rawArguments: string): void {
    const text = `Could not parse arguments for ${tool}: ${error}. Raw: ${rawArguments.slice(0, 500)}`;
    this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "tool_call", payload: { record: { id: toolCallId, tool, args: {} } } });
    this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "tool_result", payload: { toolCallId, tool, result: text } });
    const payload = { turnId: turn.id, step, tool, error: text, recoverable: true };
    this.event(session.id, "planner_error", payload);
    this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "planner_error", payload });
  }

  private recordDisabledToolCall(session: Session, turn: Turn, assistantMessage: Message, step: number, toolCallId: string, tool: string, args: unknown): void {
    const text = `Tool ${tool} was not executed because this is a bounded text-only completion turn.`;
    this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "tool_call", payload: { record: { id: toolCallId, tool, args } } });
    this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "tool_result", payload: { toolCallId, tool, result: text } });
    const payload = { turnId: turn.id, step, tool, error: text, recoverable: false };
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
    const isBridge = action.tool === "tool_search" || action.tool === "tool_invoke";
    if (!tool || (scope && !scope.includes(action.tool) && !isBridge)) {
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
    if (action.tool === "subdomain_enum") {
      const duplicate = this.store.listToolCalls(session.id, 200).find((call) => (
        call.turnId === turn.id
        && call.tool === action.tool
        && (call.status === "done" || call.status === "error")
        && stableValue(call.args) === stableValue(action.args)
      ));
      if (duplicate) {
        const text = `Equivalent ${action.tool} already finished in this turn as ${duplicate.id}; reuse its source statuses and names instead of retrying.`;
        this.event(session.id, "planner_error", {
          turnId: turn.id,
          step,
          tool: action.tool,
          error: text,
          recoverable: true,
          policy: "duplicate_terminal_tool",
          duplicateSuppressed: true,
          duplicateToolCallId: duplicate.id
        });
        return { shouldContinue: true };
      }
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
      const detachedAgent = action.tool === "agent_task" && record.status === "running_background";
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
        state.lastReasoningRender = now;
      } else if (now - (state.lastReasoningRender ?? 0) >= STREAM_RENDER_INTERVAL_MS) {
        this.store.updatePartPayload(state.reasoningPartId, { rationale });
        state.lastReasoningRender = now;
      }
      this.streamingParts.set(turn.id, state);
      return;
    }
    state.textAccum += event.delta;
    if (!state.textPartId) {
      if (isInternalMetaReasoning(state.textAccum)) {
        this.streamingParts.set(turn.id, state);
        return;
      }
      if (state.textAccum.length < 80 && !state.textAccum.includes("\n")) {
        this.streamingParts.set(turn.id, state);
        return;
      }
      const part = this.store.addPart({ sessionId: session.id, turnId: turn.id, messageId: assistantMessage.id, type: "text", payload: { text: state.textAccum } });
      state.textPartId = part.id;
      state.lastTextRender = now;
      state.lastTextPersist = now;
    } else if (now - (state.lastTextPersist ?? 0) >= STREAM_PERSIST_INTERVAL_MS) {
      this.store.updatePartPayload(state.textPartId, { text: state.textAccum });
      state.lastTextRender = now;
      state.lastTextPersist = now;
    } else if (now - (state.lastTextRender ?? 0) >= STREAM_RENDER_INTERVAL_MS) {
      this.store.publishTransientEvent({
        id: id(),
        sessionId: session.id,
        type: "stream_text",
        payload: { partId: state.textPartId, text: state.textAccum },
        createdAt: nowIso()
      });
      state.lastTextRender = now;
    }
    this.streamingParts.set(turn.id, state);
  }

  private discardStreamingText(turnId: string): void {
    const state = this.streamingParts.get(turnId);
    if (!state) return;
    if (state.textPartId) this.store.updatePartPayload(state.textPartId, { text: "" });
    state.textAccum = "";
    delete state.textPartId;
    delete state.lastTextRender;
    delete state.lastTextPersist;
  }

  private prepareStreamingRetry(turnId: string): void {
    const state = this.streamingParts.get(turnId);
    if (!state) return;
    if (state.textPartId) this.store.updatePartPayload(state.textPartId, { text: "" });
    if (state.reasoningPartId) this.store.updatePartPayload(state.reasoningPartId, { rationale: "" });
    state.textAccum = "";
    delete state.reasoningPartId;
    delete state.reasoningAccum;
    delete state.lastReasoningRender;
    state.lastTextRender = Date.now();
    state.lastTextPersist = state.lastTextRender;
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
    this.streamingParts.delete(turn.id);
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
          this.prepareStreamingRetry(turn.id);
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
    this.event(turn.sessionId, "loop_stop", { turnId: turn.id, status, reason, ...(errorSummary ? { errorSummary } : {}) });
    const updated = this.store.updateTurn(turn.id, { status, stopReason: reason, ...(errorSummary ? { errorSummary } : {}) });
    this.modelCallsByTurn.delete(turn.id);
    this.streamingParts.delete(turn.id);
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
    const tool = toolForExecution(session, toolName);
    const schedulingTool = toolSchedulingDefinition(tool, args, session);
    const gateSignal = signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;
    try {
      return await this.toolExecutionGate.run(
        toolConcurrencyKey(schedulingTool, session, this.workspace),
        schedulingTool.parallel,
        async (gateLease) => {
          gateSignal.throwIfAborted();
          if (owner && this.store.loadTurn(owner.turn.id).status === "cancelled") throw new Error("turn cancelled before tool start");
          return await this.runToolUnderGate(session, tool, args, owner, providerToolCallId, gateLease);
        },
        gateSignal
      );
    } catch (error) {
      if (error instanceof ToolScopeQuarantinedError) {
        return this.recordRejectedToolCall(session, tool, args, error.message, { quarantined: true, reason: "concurrency_scope_quarantined" }, owner, providerToolCallId);
      }
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
    const toolCall: ToolCallRecord = {
      id: id(),
      sessionId: session.id,
      tool: tool.name,
      args,
      status: "pending",
      evidenceIds: [],
      ...(providerToolCallId ? { providerToolCallId } : {}),
      ...(owner ? { turnId: owner.turn.id, messageId: owner.assistantMessage.id } : {})
    };
    this.store.saveToolCall(toolCall);
    if (owner) {
      const part = this.store.addPart({
        sessionId: session.id,
        turnId: owner.turn.id,
        messageId: owner.assistantMessage.id,
        type: "tool_call",
        payload: { record: toolCall }
      });
      toolCall.timelinePartId = part.id;
      this.store.saveToolCall(toolCall);
    }
    this.event(session.id, "tool_call", { id: toolCall.id, ...(providerToolCallId ? { providerToolCallId } : {}), tool: tool.name, args });
    return this.settleToolError(toolCall, message, state);
  }

  private async runToolUnderGate(
    session: Session,
    tool: ToolDefinition,
    args: unknown,
    owner?: { turn: Turn; assistantMessage: Message },
    providerToolCallId?: string,
    gateLease?: ToolGateLease
  ): Promise<ToolCallRecord> {
    const toolCall: ToolCallRecord = {
      id: id(),
      sessionId: session.id,
      tool: tool.name,
      args,
      status: "pending",
      evidenceIds: [],
      ...(providerToolCallId ? { providerToolCallId } : {}),
      ...(owner ? { turnId: owner.turn.id, messageId: owner.assistantMessage.id } : {})
    };
    this.store.saveToolCall(toolCall);

    if (owner) {
      const part = this.store.addPart({
        sessionId: session.id,
        turnId: owner.turn.id,
        messageId: owner.assistantMessage.id,
        type: "tool_call",
        payload: { record: toolCall }
      });
      toolCall.timelinePartId = part.id;
      this.store.saveToolCall(toolCall);
    }

    this.event(session.id, "tool_call", { id: toolCall.id, ...(providerToolCallId ? { providerToolCallId } : {}), tool: tool.name, args });
    await this.executeToolUnderGate(session, toolCall.id, owner, gateLease);
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
    const tool = toolForExecution(session, toolCall.tool);
    const schedulingTool = toolSchedulingDefinition(tool, toolCall.args, session);
    const turnId = owner?.turn.id ?? toolCall.turnId;
    const gateController = turnId ? this.registerTurnController(turnId) : undefined;
    const gateSignal = gateController
      ? AbortSignal.any([gateController.signal, this.shutdownController.signal])
      : this.shutdownController.signal;
    try {
      return await this.toolExecutionGate.run(
        toolConcurrencyKey(schedulingTool, session, this.workspace),
        schedulingTool.parallel,
        async (gateLease) => {
          gateSignal.throwIfAborted();
          if (turnId && this.store.loadTurn(turnId).status === "cancelled") throw new Error("turn cancelled before tool start");
          return await this.executeToolUnderGate(session, toolCallId, owner, gateLease);
        },
        gateSignal
      );
    } catch (error) {
      if (error instanceof ToolScopeQuarantinedError) {
        const rejected = this.store.loadToolCall(toolCallId);
        if (rejected.status === "pending") {
          return this.settleToolError(rejected, error.message, { quarantined: true, reason: "concurrency_scope_quarantined" });
        }
        return rejected;
      }
      if (!gateSignal.aborted && (!turnId || this.store.loadTurn(turnId).status !== "cancelled")) throw error;
      const cancelled = this.store.loadToolCall(toolCallId);
      if (cancelled.status === "pending") {
        const message = turnId ? "turn cancelled before tool start" : String(gateSignal.reason ?? "tool gate cancelled before start");
        return this.settleToolError(cancelled, message, {
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
    owner?: { turn: Turn; assistantMessage: Message },
    gateLease = new ToolGateLease()
  ): Promise<ToolCallRecord> {
    let toolCall = this.store.loadToolCall(toolCallId);
    if (toolCall.status !== "pending") return toolCall;
    const tool = toolForExecution(session, toolCall.tool);
    toolCall.status = "running";
    this.store.saveToolCall(toolCall);
    this.syncToolCallPart(toolCall);
    this.event(session.id, "tool_started", { toolCallId: toolCall.id, tool: toolCall.tool, args: toolCall.args });
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
      workspace: this.workspace,
      toolCallId: toolCall.id,
      now: nowIso,
      fileState: leasedToolCapability(this.fileState, lease),
      lsp: leasedToolCapability(this.lsp.forSession(session.id), lease),
      ...(this.knowledge() ? { knowledge: leasedToolCapability(this.knowledge()!, lease) } : {}),
      store: leasedToolCapability(this.store as unknown as ToolContext["store"], lease),
      signal: deadline.signal,
      timeoutMs: toolOperationTimeout(tool.timeoutMs),
      ...(this.executionBackend ? { executionBackend: this.executionBackend } : {}),
      availableTools: () => {
        lease.assertActive();
        return listToolsForSession(session).filter((item) => item.name !== "tool_search" && item.name !== "tool_invoke");
      },
      invokeTool: async (name, args) => {
        lease.assertActive();
        const canonicalName = canonicalToolName(name);
        if (canonicalName === "tool_search" || canonicalName === "tool_invoke") throw new Error(`Deferred bridge recursion is not allowed: ${canonicalName}`);
        const allowed = listToolsForSession(session).some((item) => item.name === canonicalName);
        if (!allowed) throw new Error(`Tool ${canonicalName} is outside this session's scope`);
        const target = getTool(canonicalName, session);
        if (!target) throw new Error(`Unknown deferred tool: ${canonicalName}`);
        const validationError = validateToolArgs(target.inputSchema, args);
        if (validationError) throw new Error(`Invalid arguments for ${canonicalName}: ${validationError}`);
        await this.fireHooks(session, "tool.pre", canonicalName, { tool: canonicalName, toolCallId: toolCall.id, args, deferred: true });
        const { invokeTool: _invokeTool, ...nestedContext } = context;
        const nestedDeadline = new ToolExecutionDeadline(target.name, target.timeoutMs, context.signal);
        let nestedResult: ToolResult;
        try {
          nestedResult = await nestedDeadline.run(
            () => target.run(args, { ...nestedContext, signal: nestedDeadline.signal, timeoutMs: toolOperationTimeout(target.timeoutMs) }),
            gateLease
          );
          lease.assertActive();
          await this.fireHooks(session, "tool.post", canonicalName, {
            tool: canonicalName,
            toolCallId: toolCall.id,
            status: completedToolCallStatus(nestedResult),
            ok: nestedResult.ok,
            summary: nestedResult.summary,
            deferred: true
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.fireHooks(session, "tool.post", canonicalName, {
            tool: canonicalName,
            toolCallId: toolCall.id,
            status: "error",
            ok: false,
            summary: message,
            error: message,
            timedOut: error instanceof ToolDeadlineError,
            cancelled: nestedDeadline.signal.aborted && !(error instanceof ToolDeadlineError),
            deferred: true
          });
          throw error;
        } finally {
          nestedDeadline.dispose();
        }
        return { ...nestedResult, metadata: { ...nestedResult.metadata, deferredTool: canonicalName } };
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
        let depth = 0;
        let parentId = session.parentId;
        while (parentId) {
          depth += 1;
          parentId = this.store.loadSession(parentId).parentId;
          if (depth > 4) break;
        }
        if (depth >= 1) throw new Error("nested campaign delegation is disabled; child workers are leaf agents");
        if (resumeSessionId && (lane || tools || model)) throw new Error("resumed subagents preserve their original lane, model, and tool scope");
        const previousJob = resumeSessionId
          ? this.store.listJobs(session.id, 10_000).find((job) => job.kind === "agent" && job.childSessionId === resumeSessionId)
          : undefined;
        const effectiveLane = lane ?? previousJob?.lane;
        const laneDef = effectiveLane ? resolveLane(this.workspace, effectiveLane) : undefined;
        if (!resumeSessionId && effectiveLane && !laneDef) throw new Error(`unknown subagent lane: ${effectiveLane}`);
        let child: Session;
        let scopedTools: string[] | undefined;
        let editsSharedWorkspace: boolean;
        if (resumeSessionId) {
          child = this.store.loadSession(resumeSessionId);
          if (child.parentId !== session.id) throw new Error(`subagent session ${resumeSessionId} does not belong to this parent`);
          const active = this.store.listJobs(session.id, 10_000).some((job) => (
            job.kind === "agent"
            && job.childSessionId === child.id
            && ["created", "starting", "running", "cancelling"].includes(job.status)
          ));
          if (active || this.hasRunningTurn(child.id)) throw new Error(`subagent session ${child.id} is already running`);
          scopedTools = child.toolScope;
          editsSharedWorkspace = hasSharedWorkspaceEdits(scopedTools);
          if (mode === "detached" && editsSharedWorkspace) throw new Error("detached subagents cannot hold shared workspace edit tools; use an attached code worker or a read-only lane");
        } else {
          const requestedTools = tools ?? laneDef?.tools;
          scopedTools = resolveSubagentToolScope({
            parent: session,
            availableTools: listToolsForSession(session),
            ...(requestedTools ? { requestedTools } : {})
          });
          editsSharedWorkspace = hasSharedWorkspaceEdits(scopedTools);
          if (mode === "detached" && editsSharedWorkspace) throw new Error("detached subagents cannot hold shared workspace edit tools; use an attached code worker or a read-only lane");
          const childModel = model ?? laneDef?.model;
          child = await this.store.forkSession(session.id, title);
          this.recordSession(child);
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
            const gated = () => this.subagentGate.run(execute, agentController.signal);
            return editsSharedWorkspace
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
    const duplicate = findEquivalentBackgroundJob(
      activeBackgroundJobs(this.store.listToolCalls(session.id, 200)),
      toolCall.tool,
      toolCall.args
    );
    await this.fireHooks(session, "tool.pre", toolCall.tool, { tool: toolCall.tool, toolCallId: toolCall.id, args: toolCall.args });
    try {
      lease.assertActive();
      result = duplicate && sessionManager.isTracked(duplicate.processId)
        ? {
            ok: true,
            summary: `Equivalent background job already running: processId=${duplicate.processId}`,
            output: `Reusing ${duplicate.toolCallId}. Poll ${duplicate.processId} with session_poll instead of starting it again.`,
            status: "running_background",
            processId: duplicate.processId,
            metadata: { reusedBackgroundToolCallId: duplicate.toolCallId }
          }
        : await deadline.run(() => tool.run(toolCall.args, context), gateLease);
    } catch (error) {
      settleLiveOutput();
      releaseController();
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = error instanceof ToolDeadlineError;
      const cancelled = deadline.signal.aborted && !timedOut;
      toolCall = this.settleToolError(toolCall, message, {
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
      result = this.boundToolOutput(session.id, toolCall, result);
      this.loadDiscoveredProviderTools(session, result, turnId, messageId);
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
      toolCall = this.settleToolError(toolCall, message, { reason: "result_processing_failure" });
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

  private loadDiscoveredProviderTools(session: Session, result: ToolResult, turnId?: string, messageId?: string): void {
    const rawNames = result.metadata?.loadedTools;
    if (!Array.isArray(rawNames)) return;
    const names = [...new Set(rawNames.map((name) => canonicalToolName(name)).filter(Boolean))];
    if (names.length === 0) return;
    const key = this.providerCatalogKey(session);
    const cacheKey = `${session.id}:${key}`;
    const previous = this.providerCatalogs.get(cacheKey) ?? this.loadProviderCatalog(session.id, key) ?? [];
    const availableTools = listToolsForSession(session);
    const selected = buildToolsPayload(names, availableTools);
    const tools = mergeProviderToolCatalog(previous, selected, availableTools);
    if (sameProviderToolCatalog(previous, tools)) return;
    this.providerCatalogs.set(cacheKey, structuredClone(tools));
    if (!turnId || !messageId) return;
    this.store.addPart({
      sessionId: session.id,
      turnId,
      messageId,
      type: "provider_catalog",
      payload: { key, tools } satisfies ProviderCatalogPayload
    });
  }

  private syncToolCallPart(toolCall: ToolCallRecord): void {
    if (!toolCall.timelinePartId) return;
    this.store.updatePartPayload(toolCall.timelinePartId, { record: toolCall });
  }

  private settleBackgroundProcess(sessionId: string, processId: string, status: "done" | "error"): void {
    this.store.settleBackgroundProcess(sessionId, processId, status);
  }

  private boundToolOutput(sessionId: string, toolCall: ToolCallRecord, result: ToolResult): ToolResult {
    if (!result.output) return result;
    const rawOutput = result.output;
    const sanitizedOutput = sanitizeToolOutput(rawOutput);
    const bytes = Buffer.byteLength(sanitizedOutput, "utf8");
    if (bytes <= TOOL_OUTPUT_MAX_BYTES) {
      return sanitizedOutput === rawOutput ? result : { ...result, output: sanitizedOutput };
    }
    const artifact = this.store.saveOutputArtifact({ sessionId, toolCallId: toolCall.id, content: rawOutput });
    const head = takeBytes(sanitizedOutput, TOOL_OUTPUT_HEAD_BYTES, "head");
    const tail = takeBytes(sanitizedOutput, TOOL_OUTPUT_TAIL_BYTES, "tail");
    const preview = `${head}\n\n[output truncated: full ${artifact.bytes} bytes stored as artifact ${artifact.id}; read it with tool_output_read]\n\n${tail}`;
    return {
      ...result,
      output: preview,
      outputArtifactId: artifact.id,
      metadata: { ...(result.metadata ?? {}), outputArtifact: artifact }
    };
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
      await refreshMcpTools({
        workspace: this.workspace,
        session,
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
    const planner = this.planner ?? await createPlannerForSessionAsync(session);
    const controller = new AbortController();
    this.compactionControllers.get(session.id)?.abort("new compaction started");
    this.compactionControllers.set(session.id, controller);
    try {
      return await this.compactSessionWithPlanner(session, planner, { trigger: "manual", ...(customInstructions ? { customInstructions } : {}), signal: controller.signal });
    } finally {
      if (this.compactionControllers.get(session.id) === controller) this.compactionControllers.delete(session.id);
      if (!this.shuttingDown) void this.wakeQueuedUserInputs(session.id);
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

function validateToolArgs(schema: Record<string, unknown> | undefined, args: unknown): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  if (typeof schema.type === "string" && schema.type !== "object") return undefined;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "expected an object of arguments";
  return validateObjectSchema(schema, args as Record<string, unknown>, "");
}

function validateSchemaValue(schema: Record<string, unknown>, value: unknown, path: string): string | undefined {
  const expected = typeof schema.type === "string"
    ? [schema.type]
    : Array.isArray(schema.type)
      ? schema.type.filter((item): item is string => typeof item === "string")
      : [];
  if (expected.length && !expected.some((type) => matchesJsonType(value, type))) {
    return `${fieldName(path)} should be of type ${expected.join(" or ")}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${fieldName(path)} must be one of: ${schema.enum.join(", ")}`;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${fieldName(path)} must contain at least ${schema.minLength} character(s)`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${fieldName(path)} cannot exceed ${schema.maxLength} character(s)`;
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) return `${fieldName(path)} does not match the required pattern`;
      } catch {
        return `${fieldName(path)} has an invalid schema pattern`;
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${fieldName(path)} must be at least ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${fieldName(path)} cannot exceed ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${fieldName(path)} must contain at least ${schema.minItems} item(s)`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${fieldName(path)} cannot contain more than ${schema.maxItems} item(s)`;
    if (schema.uniqueItems === true && new Set(value.map(stableValue)).size !== value.length) return `${fieldName(path)} must contain unique items`;
    const itemSchema = schema.items;
    if (itemSchema && typeof itemSchema === "object" && !Array.isArray(itemSchema)) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateSchemaValue(itemSchema as Record<string, unknown>, value[index], `${path}[${index}]`);
        if (error) return error;
      }
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return validateObjectSchema(schema, value as Record<string, unknown>, path);
  }
  return undefined;
}

function validateObjectSchema(schema: Record<string, unknown>, record: Record<string, unknown>, path: string): string | undefined {
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  for (const key of required) {
    if (record[key] === undefined || record[key] === null) return `missing required field "${joinFieldPath(path, key)}"`;
  }
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, Record<string, unknown>> : {};
  for (const [key, value] of Object.entries(record)) {
    const propSchema = properties[key];
    if (!propSchema || typeof propSchema !== "object") {
      if (schema.additionalProperties === false) return `unexpected field "${joinFieldPath(path, key)}"`;
      continue;
    }
    const error = validateSchemaValue(propSchema, value, joinFieldPath(path, key));
    if (error) return error;
  }
  return undefined;
}

function joinFieldPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function fieldName(path: string): string {
  return path ? `field "${path}"` : "value";
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return !!value && typeof value === "object" && !Array.isArray(value);
    case "null": return value === null;
    default: return true;
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

function abortablePromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
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

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted"));
}

function mailboxText(item: import("../types").SessionMailboxItem): string {
  if (!item.payload || typeof item.payload !== "object") return "";
  const text = (item.payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function queuedUserInput(item: SessionMailboxItem): QueuedUserInput | undefined {
  if (item.kind !== "user" || item.triggerPolicy !== "queue" || !item.payload || typeof item.payload !== "object") return undefined;
  const payload = item.payload as { text?: unknown; inputMode?: unknown; action?: unknown };
  if ((payload.inputMode !== "queued_followup" && payload.inputMode !== "turn") || typeof payload.text !== "string" || !payload.text.trim()) return undefined;
  const action = payload.action === "slash" || payload.action === "shell" || payload.action === "plain"
    ? payload.action
    : queuedInputAction(payload.text);
  return { id: item.id, sequence: item.sequence, text: payload.text, action, createdAt: item.createdAt };
}

function queuedFollowupUserInput(item: SessionMailboxItem): QueuedUserInput | undefined {
  if (!item.payload || typeof item.payload !== "object") return undefined;
  if ((item.payload as { inputMode?: unknown }).inputMode !== "queued_followup") return undefined;
  return queuedUserInput(item);
}

function queuedInputAction(text: string): QueuedInputAction {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("!")) return "shell";
  if (trimmed.startsWith("/")) return "slash";
  return "plain";
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

function agentTaskOutput(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  if (record.tool !== "agent_task") return [];
  const toolResult = record.toolResult;
  if (!toolResult || typeof toolResult !== "object" || Array.isArray(toolResult)) return [];
  const output = (toolResult as Record<string, unknown>).output;
  return typeof output === "string" && output.trim() ? [output] : [];
}

function comparableProse(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_>#|()[\]{}]/g, " ")
    .replace(/[^a-z0-9./:_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function substantiallySameProse(left: string, right: string): boolean {
  if (right.length < 40) return false;
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  if ((left.includes(right) || right.includes(left)) && shorter / longer >= 0.72) return true;
  const leftWords = new Set(left.split(" ").filter((word) => word.length > 2));
  const rightWords = new Set(right.split(" ").filter((word) => word.length > 2));
  if (leftWords.size < 8 || rightWords.size < 8) return false;
  let shared = 0;
  for (const word of leftWords) if (rightWords.has(word)) shared += 1;
  return shared / leftWords.size >= 0.88 && shared / rightWords.size >= 0.88;
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

class ToolExecutionLease {
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

class ToolExecutionDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly tool: string;
  private readonly timeoutMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly parentSignal: AbortSignal | undefined;
  private readonly abortFromParent: (() => void) | undefined;

  constructor(tool: string, timeoutMs: number, parentSignal?: AbortSignal) {
    this.tool = tool;
    this.timeoutMs = normalizeToolTimeout(timeoutMs);
    this.signal = this.controller.signal;
    this.parentSignal = parentSignal;
    this.abortFromParent = parentSignal
      ? () => this.controller.abort(parentSignal.reason ?? new Error("tool execution cancelled"))
      : undefined;
    if (parentSignal?.aborted) this.abortFromParent?.();
    else if (parentSignal && this.abortFromParent) parentSignal.addEventListener("abort", this.abortFromParent, { once: true });
  }

  async run<T>(work: () => Promise<T>, gateLease: ToolGateLease): Promise<T> {
    this.signal.throwIfAborted();
    this.timer ??= setTimeout(() => {
      if (!this.signal.aborted) this.controller.abort(new ToolDeadlineError(this.tool, this.timeoutMs));
    }, this.timeoutMs);
    this.signal.throwIfAborted();
    const running = Promise.resolve().then(work);
    try {
      return await abortablePromise(running, this.signal);
    } catch (error) {
      if (this.signal.aborted) gateLease.quarantineUntil(running, abortReason(this.signal));
      throw error;
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.parentSignal && this.abortFromParent) this.parentSignal.removeEventListener("abort", this.abortFromParent);
  }
}

class ToolGateLease {
  private readonly quarantines: Array<{ running: Promise<unknown>; error: Error }> = [];

  quarantineUntil(running: Promise<unknown>, error: Error): void {
    this.quarantines.push({ running, error });
  }

  takeQuarantines(): Array<{ running: Promise<unknown>; error: Error }> {
    return this.quarantines.splice(0);
  }
}

function leasedToolCapability<T extends object>(target: T, lease: ToolExecutionLease): T {
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

function normalizeToolTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return 120_000;
  return Math.max(1, Math.floor(timeoutMs));
}

function toolOperationTimeout(timeoutMs: number): number {
  const deadline = normalizeToolTimeout(timeoutMs);
  const handoffGrace = Math.min(5_000, Math.max(50, Math.floor(deadline * 0.05)));
  return Math.max(1, deadline - handoffGrace);
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

type ToolGateState = {
  activeReaders: number;
  activeWriter: boolean;
  queue: ToolGateWaiter[];
  quarantines: Set<Promise<unknown>>;
  quarantineError?: Error;
};

type ToolGateWaiter = {
  mode: "read" | "write";
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

class ToolExecutionGate {
  private readonly states = new Map<string, ToolGateState>();
  private readonly idleResolvers = new Set<() => void>();

  idle(): Promise<void> {
    if (this.states.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.add(resolve));
  }

  async run<T>(key: string, parallel: boolean, fn: (lease: ToolGateLease) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(key, parallel ? "read" : "write", signal);
    const lease = new ToolGateLease();
    try {
      signal?.throwIfAborted();
      return await fn(lease);
    } finally {
      this.quarantine(key, lease.takeQuarantines());
      release();
    }
  }

  private acquire(key: string, mode: "read" | "write", signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("tool gate acquisition cancelled"));
        return;
      }
      const state = this.states.get(key) ?? { activeReaders: 0, activeWriter: false, queue: [], quarantines: new Set<Promise<unknown>>() };
      this.states.set(key, state);
      if (state.quarantineError) {
        reject(state.quarantineError);
        return;
      }
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
    if (state.activeWriter || state.quarantineError) return;
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
    if (state.activeReaders === 0 && !state.activeWriter && state.queue.length === 0 && state.quarantines.size === 0 && this.states.get(key) === state) {
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

  private quarantine(key: string, entries: Array<{ running: Promise<unknown>; error: Error }>): void {
    if (entries.length === 0) return;
    const state = this.states.get(key);
    if (!state) return;
    state.quarantineError ??= new ToolScopeQuarantinedError(key, entries[0]!.error);
    for (const waiter of state.queue.splice(0)) {
      this.detach(waiter);
      waiter.reject(state.quarantineError);
    }
    for (const entry of entries) {
      let tracked: Promise<unknown>;
      tracked = entry.running.catch(() => undefined).finally(() => {
        state.quarantines.delete(tracked);
        if (state.quarantines.size === 0) {
          delete state.quarantineError;
          this.drain(key, state);
          this.cleanup(key, state);
        }
      });
      state.quarantines.add(tracked);
    }
  }
}

function toolForExecution(session: Session, name: string): ToolDefinition {
  const canonical = canonicalToolName(name);
  const tool = getTool(canonical, session);
  if (!tool) throw new Error(`unknown tool: ${canonical}`);
  const scoped = session.toolScope?.length ? new Set(session.toolScope.map(canonicalToolName)) : undefined;
  if (scoped && !scoped.has(canonical) && canonical !== "tool_invoke") {
    throw new Error(`tool ${canonical} is outside this session's scope`);
  }
  return tool;
}

function toolConcurrencyKey(tool: ToolDefinition, session: Session, workspace: string): string {
  if (tool.concurrencyScope === "runtime") return "runtime";
  if (tool.concurrencyScope === "session") return `session:${session.id}`;
  return `workspace:${workspace}`;
}

function toolSchedulingDefinition(tool: ToolDefinition, args: unknown, session: Session): ToolDefinition {
  if (canonicalToolName(tool.name) !== "tool_invoke" || !args || typeof args !== "object" || Array.isArray(args)) return tool;
  const targetName = canonicalToolName(String((args as Record<string, unknown>).name ?? ""));
  return getTool(targetName, session) ?? tool;
}

function positiveFinite(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
