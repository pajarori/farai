import type { SqliteStore } from "../agent-store/sqlite-store";
import type { Session } from "../types";
import type { ConversationEntry, PlannerProvider } from "./provider";
import type { ContextProjection } from "./context-engine";
import { activeBackgroundJobs, renderBackgroundJobs } from "./loop/background";
import { buildCompactedHistory, insertCompactionContext, mergeCompactCheckpoint, runModelCompaction } from "./loop/compaction";

export type CompactionOptions = {
  trigger?: "manual" | "auto";
  customInstructions?: string;
  signal?: AbortSignal;
};

export async function compactSessionHistory(
  store: SqliteStore,
  sessionId: string,
  planner: PlannerProvider,
  assemble: (session: Session, history?: ConversationEntry[], throughMessageRowId?: number) => ContextProjection,
  options: CompactionOptions = {}
): Promise<Session> {
  const checkCancelled = () => {
    if (options.signal?.aborted) throw new Error(`compaction cancelled: ${String(options.signal.reason ?? "aborted")}`);
  };
  checkCancelled();
  const session = store.loadSession(sessionId);
  const previous = store.latestCompactionBoundary(sessionId);
  const throughMessageRowId = store.maxMessageRowId(sessionId);
  if (throughMessageRowId <= (previous?.throughMessageRowId ?? 0)) throw new Error("not enough conversation history to compact");
  const context = assemble(session, undefined, throughMessageRowId);
  const history = structuredClone(context.history);
  const checkpoint = buildCompactCheckpoint(store, session);
  const trigger = options.trigger ?? "manual";
  if (trigger === "auto" && assemble(session, [], throughMessageRowId).manifest.overBudget) {
    throw new Error("instructions and tool schemas exceed the context budget; no provider request was sent");
  }

  const generated = planner.compactionMode === "deterministic"
    ? [session.summary ? `Prior compacted context:\n${session.summary}` : "", "Recent user requests:",
        ...history.filter((entry) => entry.role === "user").slice(-8).map((entry) => entry.text.slice(0, 1000))].filter(Boolean).join("\n")
    : await runModelCompaction({
        planner,
        plannerInput: {
          session,
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
  const postTokens = assemble({ ...session, summary }, replacementHistory, throughMessageRowId).manifest.estimatedTokens;
  const preTokens = context.manifest.estimatedTokens;
  if (trigger === "auto" && postTokens >= preTokens) throw new Error(`compaction did not reduce active context: ${preTokens} -> ${postTokens} estimated tokens`);
  if (trigger === "auto" && postTokens >= context.manifest.requestBudget) {
    throw new Error(`compacted context still exceeds request budget: ${postTokens} >= ${context.manifest.requestBudget} tokens`);
  }
  checkCancelled();
  store.commitCompaction({
    sessionId, trigger, summary, replacementHistory, throughMessageRowId,
    preCompactTokens: preTokens, postCompactTokens: postTokens,
    expectedPreviousBoundaryId: previous?.id ?? null
  });
  return store.loadSession(sessionId);
}

function buildCompactCheckpoint(store: SqliteStore, session: Session): string {
  const plan = store.loadPlan(session.id);
  const todos = store.listTodos(session.id, { limit: 30 }).filter((todo) => todo.status !== "done" && todo.status !== "cancelled");
  const evidence = store.listEvidence(session.id).slice(-20);
  const findings = store.listFindings(session.id).slice(-20);
  const notes = store.listNotes(session.id).slice(-20);
  const memory = store.listMemory(session.id).slice(0, 30);
  const jobs = activeBackgroundJobs(store.listToolCalls(session.id, 200));
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
