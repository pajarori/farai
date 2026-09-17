import type { SqliteStore } from "../agent-store/sqlite-store";
import type { Session } from "../types";
import type { ConversationEntry, PlannerProvider } from "../agent-core/provider";
import type { ContextManifest, ContextProjection } from "../agent-core/context-engine";
import type { ProjectionOverlay } from "../agent-core/history-projection";
import { projectConversationHistory } from "../agent-core/history-projection";
import { activeBackgroundJobs, renderBackgroundJobs } from "../agent-core/loop/background";
import { buildCompactedHistory, insertCompactionContext, mergeCompactCheckpoint, runModelCompaction } from "./summary-runner";
import { buildOverlayMap } from "./overlay";
import { resolveContextWindow } from "../agent-core/model-registry";
import type { LaneNode, LanePolicy } from "./lanes";

export type CompactionOptions = {
  trigger?: "manual" | "auto";
  customInstructions?: string;
  signal?: AbortSignal;
};

export type AssembleContext = (session: Session, planner: PlannerProvider, history?: ConversationEntry[], throughMessageRowId?: number) => ContextProjection;

export type AutoCompactResult = { status: "compacted" | "ok" } | { status: "failed"; error: string };

export class ContextManager {
  private readonly lanes: LanePolicy[] = [];
  private readonly maintainInFlight = new Set<string>();
  private readonly maintainControllers = new Map<string, AbortController>();

  constructor(private readonly store: SqliteStore, private readonly assemble: AssembleContext) {}

  registerLane(policy: LanePolicy): this {
    this.lanes.push(policy);
    return this;
  }

  buildOverlay(sessionId: string): ProjectionOverlay {
    return buildOverlayMap(this.store.listContextSummaryChunks(sessionId));
  }

  reset(sessionId: string): void {
    this.store.deleteContextSummaryChunks(sessionId);
  }

  cancelMaintain(sessionId: string): void {
    this.maintainControllers.get(sessionId)?.abort("superseded");
  }

  async maintain(session: Session, planner: PlannerProvider): Promise<void> {
    if (!this.lanes.length || this.maintainInFlight.has(session.id)) return;
    this.maintainInFlight.add(session.id);
    const controller = new AbortController();
    this.maintainControllers.set(session.id, controller);
    try {
      await this.runMaintain(session, planner, controller.signal);
    } catch {
    } finally {
      this.maintainInFlight.delete(session.id);
      if (this.maintainControllers.get(session.id) === controller) this.maintainControllers.delete(session.id);
    }
  }

  private async runMaintain(session: Session, planner: PlannerProvider, signal: AbortSignal): Promise<void> {
    const messages = this.store.listContextMessages(session.id, 100_000);
    const projection = projectConversationHistory(messages, { full: true });
    const covered = new Set<string>();
    for (const chunk of this.store.listContextSummaryChunks(session.id)) for (const nodeId of chunk.coveredNodeIds) covered.add(nodeId);
    const activeJobs = new Set(activeBackgroundJobs(this.store.listToolCalls(session.id, 200)).map((job) => job.toolCallId));
    const windowTokens = resolveContextWindow(planner.contextWindow);
    for (const policy of this.lanes) {
      if (signal.aborted) return;
      const nodes: LaneNode[] = [];
      for (const entry of projection.entries) {
        if (!entry.nodeId || !policy.classify(entry)) continue;
        const text = entry.text ?? "";
        nodes.push({
          nodeId: entry.nodeId,
          lane: policy.lane,
          covered: covered.has(entry.nodeId),
          settled: !(entry.role === "tool" && activeJobs.has(entry.nodeId)),
          text,
          bytes: Buffer.byteLength(text, "utf8"),
          ...(entry.role === "tool" ? { toolCallId: entry.nodeId } : {})
        });
      }
      for (const plan of policy.planChunks(nodes, windowTokens)) {
        if (signal.aborted) return;
        const chunkNodes = nodes.filter((node) => plan.coveredNodeIds.includes(node.nodeId));
        if (!chunkNodes.length) continue;
        const summary = (await this.summarizeChunk(session, planner, policy, chunkNodes, signal)).trim();
        if (!summary) continue;
        try {
          this.store.commitContextSummaryChunk({
            sessionId: session.id,
            lane: plan.lane,
            coveredNodeIds: plan.coveredNodeIds,
            anchorNodeId: plan.anchorNodeId,
            throughMessageRowId: this.store.maxMessageRowId(session.id),
            summary,
            sourceCount: chunkNodes.length,
            sourceBytes: plan.sourceBytes
          });
        } catch {
        }
      }
    }
  }

  private async summarizeChunk(session: Session, planner: PlannerProvider, policy: LanePolicy, nodes: LaneNode[], signal: AbortSignal): Promise<string> {
    if (planner.compactionMode === "deterministic") return policy.fallback(nodes);
    const history: ConversationEntry[] = nodes.map((node) => ({ role: "context", text: `[${node.toolCallId ?? node.nodeId}]\n${node.text}` }));
    return await runModelCompaction({
      planner,
      plannerInput: { session, history, tools: [] },
      prompt: policy.prompt(nodes),
      ...(signal ? { signal } : {})
    });
  }

  async maybeAutoCompact(session: Session, planner: PlannerProvider, manifest: ContextManifest, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<AutoCompactResult> {
    const estimated = manifest.estimatedTokens;
    const latestUsage = this.store.latestUsage(session.id, session.model);
    const boundary = this.store.latestCompactionBoundary(session.id);
    const actual = latestUsage && (!boundary || latestUsage.createdAt > boundary.createdAt) ? latestUsage.inputTokens : 0;
    if (!options.force && Math.max(estimated, actual) < manifest.requestBudget) return { status: "ok" };
    try {
      this.cancelMaintain(session.id);
      await this.compact(session, planner, { trigger: "auto", ...(options.signal ? { signal: options.signal } : {}) });
      return { status: "compacted" };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async compact(session: Session, planner: PlannerProvider, options: CompactionOptions = {}): Promise<Session> {
    const sessionId = session.id;
    const checkCancelled = () => {
      if (options.signal?.aborted) throw new Error(`compaction cancelled: ${String(options.signal.reason ?? "aborted")}`);
    };
    checkCancelled();
    this.cancelMaintain(sessionId);
    const current = this.store.loadSession(sessionId);
    const previous = this.store.latestCompactionBoundary(sessionId);
    const throughMessageRowId = this.store.maxMessageRowId(sessionId);
    if (throughMessageRowId <= (previous?.throughMessageRowId ?? 0)) throw new Error("not enough conversation history to compact");
    const context = this.assemble(current, planner, undefined, throughMessageRowId);
    const history = structuredClone(context.history);
    const checkpoint = this.buildCompactCheckpoint(current);
    const trigger = options.trigger ?? "manual";
    if (trigger === "auto" && this.assemble(current, planner, [], throughMessageRowId).manifest.overBudget) {
      throw new Error("instructions and tool schemas exceed the context budget; no provider request was sent");
    }

    const generated = planner.compactionMode === "deterministic"
      ? [current.summary ? `Prior compacted context:\n${current.summary}` : "", "Recent user requests:",
          ...history.filter((entry) => entry.role === "user").slice(-8).map((entry) => entry.text.slice(0, 1000))].filter(Boolean).join("\n")
      : await runModelCompaction({
          planner,
          plannerInput: {
            session: current,
            history: [...history, ...(context.volatileContext ? [{ role: "context" as const, text: context.volatileContext }] : [])],
            contextBlocks: context.contextBlocks,
            tools: []
          },
          ...(options.customInstructions ? { customInstructions: options.customInstructions } : {}),
          ...(options.signal ? { signal: options.signal } : {})
        });
    checkCancelled();
    const summary = mergeCompactCheckpoint(generated, checkpoint);
    const userBudget = Math.min(20_000, Math.max(0, Math.floor(context.manifest.requestBudget * 0.1)));
    const replacementHistory = buildCompactedHistory(history, summary, userBudget);
    if (trigger === "auto" && context.volatileContext) {
      insertCompactionContext(replacementHistory, context.volatileContext.trim());
    }
    const postTokens = this.assemble({ ...current, summary }, planner, replacementHistory, throughMessageRowId).manifest.estimatedTokens;
    const preTokens = context.manifest.estimatedTokens;
    if (trigger === "auto" && postTokens >= preTokens) throw new Error(`compaction did not reduce active context: ${preTokens} -> ${postTokens} estimated tokens`);
    if (trigger === "auto" && postTokens >= context.manifest.requestBudget) {
      throw new Error(`compacted context still exceeds request budget: ${postTokens} >= ${context.manifest.requestBudget} tokens`);
    }
    checkCancelled();
    this.store.commitCompaction({
      sessionId, trigger, summary, replacementHistory, throughMessageRowId,
      preCompactTokens: preTokens, postCompactTokens: postTokens,
      expectedPreviousBoundaryId: previous?.id ?? null
    });
    return this.store.loadSession(sessionId);
  }

  private buildCompactCheckpoint(session: Session): string {
    const plan = this.store.loadPlan(session.id);
    const todos = this.store.listTodos(session.id, { limit: 30 }).filter((todo) => todo.status !== "done" && todo.status !== "cancelled");
    const evidence = this.store.listEvidence(session.id).slice(-20);
    const findings = this.store.listFindings(session.id).slice(-20);
    const notes = this.store.listNotes(session.id).slice(-20);
    const memory = this.store.listMemory(session.id).slice(0, 30);
    const jobs = activeBackgroundJobs(this.store.listToolCalls(session.id, 200));
    const nextPlanStep = plan.find((item) => item.status === "in_progress") ?? plan.find((item) => item.status === "pending");
    if (!plan.length && !todos.length && !evidence.length && !findings.length && !notes.length && !memory.length && !jobs.length) return "";
    return [
      ...(plan.length ? ["Current plan:", ...plan.map((item) => `- [${item.status}] ${item.step}`)] : []),
      ...(todos.length ? ["Open todos:", ...todos.map((todo) => `- [${todo.status}/${todo.priority}] ${todo.text}`)] : []),
      ...(evidence.length ? ["Evidence:", ...evidence.map((item) => `- ${item.id}: ${item.title} — ${item.summary}`)] : []),
      ...(findings.length ? ["Findings:", ...findings.map((finding) => `- ${finding.id}: ${finding.status ?? "candidate"} ${finding.severity}${finding.cvssScore === undefined ? "" : ` cvss ${finding.cvssScore.toFixed(1)}`} ${finding.title} on ${finding.target}; evidence=${finding.evidenceIds.join(",") || "none"}; reproduction=${finding.reproduction}`)] : []),
      ...(notes.length ? ["Notes:", ...notes.map((note) => `- ${note.text}`)] : []),
      ...(memory.length ? ["Memory:", ...memory.map((item) => `- ${item.kind}:${item.key}=${JSON.stringify(item.value)}`)] : []),
      ...(jobs.length ? ["Active background jobs:", ...renderBackgroundJobs(jobs)] : []),
      ...(nextPlanStep || todos[0]
        ? ["Exact next action:", `- ${nextPlanStep?.step ?? todos[0]!.text}`]
        : [])
    ].join("\n");
  }
}
