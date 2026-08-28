import type { BackendSessionResult } from "../../agent-tools/backends/types";
import type { SessionManager } from "../../agent-tools/shared/session-manager";
import type { BackgroundJob, SessionMailboxItem, ToolCallRecord } from "../../types";
import { id, nowIso } from "../../utils";
import type { SqliteStore } from "../../agent-store/sqlite-store";
import { takeBytes } from "../../agent-tools/shared/output-bound";

export type ProcessJobStart = {
  sessionId: string;
  turnId?: string;
  toolCallId: string;
  processId: string;
  backendKind: string;
  cancellationPolicy?: BackgroundJob["cancellationPolicy"];
};

export type AgentJobStart = {
  sessionId: string;
  turnId?: string;
  toolCallId?: string;
  childSessionId: string;
  title: string;
  lane?: string;
  mode: "attached" | "detached";
};

export class JobManager {
  constructor(
    private readonly runtimeId: string,
    private readonly store: SqliteStore,
    private readonly sessions: SessionManager,
    private readonly onMailbox: (item: SessionMailboxItem, job: BackgroundJob) => void
  ) {}

  attachProcess(input: ProcessJobStart): BackgroundJob {
    const existing = this.store.findJobByProcessId(input.processId);
    if (existing) {
      if (existing.runtimeId !== this.runtimeId) throw new Error(`Background process ${input.processId} is owned by another runtime`);
      return existing;
    }
    const now = nowIso();
    const job = this.store.saveJob({
      id: id(),
      kind: "process",
      status: "running",
      runtimeId: this.runtimeId,
      sessionId: input.sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      toolCallId: input.toolCallId,
      backendKind: input.backendKind,
      processId: input.processId,
      cancellationPolicy: input.cancellationPolicy ?? "session",
      deliveryState: "pending",
      createdAt: now,
      startedAt: now,
      updatedAt: now
    });
    this.sessions.onComplete(input.processId, (result) => this.completeProcess(job.id, result));
    return job;
  }

  startAgent(input: AgentJobStart): BackgroundJob {
    const now = nowIso();
    return this.store.saveJob({
      id: id(),
      kind: "agent",
      status: "created",
      runtimeId: this.runtimeId,
      sessionId: input.sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      childSessionId: input.childSessionId,
      title: input.title,
      ...(input.lane ? { lane: input.lane } : {}),
      agentMode: input.mode,
      cancellationPolicy: "session",
      deliveryState: "pending",
      createdAt: now,
      updatedAt: now
    });
  }

  markAgentRunning(jobId: string): BackgroundJob {
    const current = this.store.loadJob(jobId);
    if (["succeeded", "failed", "cancelled", "lost"].includes(current.status)) return current;
    const now = nowIso();
    return this.store.saveJob({ ...current, status: "running", startedAt: current.startedAt ?? now, updatedAt: now });
  }

  completeAgent(jobId: string, response: string, notify = true): BackgroundJob {
    const current = this.store.loadJob(jobId);
    if (["succeeded", "failed", "cancelled", "lost"].includes(current.status)) return current;
    const artifact = this.store.saveOutputArtifact({
      sessionId: current.sessionId,
      ...(current.toolCallId ? { toolCallId: current.toolCallId } : {}),
      content: response
    });
    const preview = takeBytes(response, 24 * 1024, "head");
    if (!notify) {
      return this.store.finalizeJobWithoutMailbox({
        jobId,
        status: "succeeded",
        result: { response: preview, childSessionId: current.childSessionId, outputArtifactId: artifact.id },
        outputArtifactId: artifact.id,
        deliveryState: "suppressed"
      }).job;
    }
    const completed = this.store.finalizeJobWithMailbox({
      jobId,
      status: "succeeded",
      settleToolStatus: "done",
      result: { response: preview, childSessionId: current.childSessionId, outputArtifactId: artifact.id },
      outputArtifactId: artifact.id,
      mailbox: {
        sessionId: current.sessionId,
        kind: "agent_completion",
        payload: {
          jobId: current.id,
          childSessionId: current.childSessionId,
          title: current.title,
          status: "succeeded",
          response: preview,
          outputArtifactId: artifact.id
        },
        triggerPolicy: "context",
        dedupeKey: `job:${current.id}:completion`
      }
    });
    this.onMailbox(completed.mailbox, completed.job);
    return completed.job;
  }

  failAgent(jobId: string, error: string, notify = true): BackgroundJob {
    const current = this.store.loadJob(jobId);
    if (["succeeded", "failed", "cancelled", "lost"].includes(current.status)) return current;
    if (!notify) {
      return this.store.finalizeJobWithoutMailbox({
        jobId,
        status: "failed",
        error,
        deliveryState: "suppressed"
      }).job;
    }
    const completed = this.store.finalizeJobWithMailbox({
      jobId,
      status: "failed",
      settleToolStatus: "error",
      error,
      mailbox: {
        sessionId: current.sessionId,
        kind: "agent_completion",
        payload: { jobId: current.id, childSessionId: current.childSessionId, title: current.title, status: "failed", error },
        triggerPolicy: "context",
        dedupeKey: `job:${current.id}:completion`
      }
    });
    this.onMailbox(completed.mailbox, completed.job);
    return completed.job;
  }

  async cancel(jobId: string, notify = true): Promise<BackgroundJob> {
    const current = this.store.loadJob(jobId);
    if (current.runtimeId !== this.runtimeId) throw new Error(`Background job ${jobId} is owned by another runtime`);
    if (["succeeded", "failed", "cancelled", "lost"].includes(current.status)) return current;
    const now = nowIso();
    this.store.saveJob({ ...current, status: "cancelling", updatedAt: now });
    if (current.processId) await this.sessions.stop(current.processId);
    if (!notify) {
      const completed = this.store.finalizeJobWithoutMailbox({
        jobId,
        status: "cancelled",
        settleToolStatus: "error",
        deliveryState: "suppressed",
        error: "background job cancelled."
      });
      return completed.job;
    }
    const completed = this.store.finalizeJobWithMailbox({
      jobId,
      status: "cancelled",
      settleToolStatus: "error",
      error: "background job cancelled.",
      mailbox: this.mailboxInput(current, "cancelled", "background job cancelled.")
    });
    this.onMailbox(completed.mailbox, completed.job);
    return completed.job;
  }

  markLost(jobId: string, error: string, notify = true): BackgroundJob {
    const current = this.store.loadJob(jobId);
    if (!notify) {
      return this.store.finalizeJobWithoutMailbox({
        jobId,
        status: "lost",
        error,
        deliveryState: "suppressed"
      }).job;
    }
    const completed = this.store.finalizeJobWithMailbox({
      jobId,
      status: "lost",
      settleToolStatus: "error",
      error,
      mailbox: this.mailboxInput(current, "lost", error)
    });
    this.onMailbox(completed.mailbox, completed.job);
    return completed.job;
  }

  repairTerminalMailbox(jobId: string): BackgroundJob {
    const current = this.store.loadJob(jobId);
    if (!["succeeded", "failed", "cancelled", "lost"].includes(current.status)) return current;
    const status = current.status as "succeeded" | "failed" | "cancelled" | "lost";
    const summary = current.error ?? terminalSummary(current);
    const completed = this.store.finalizeJobWithMailbox({
      jobId,
      status,
      settleToolStatus: status === "succeeded" ? "done" : "error",
      ...(current.result !== undefined ? { result: current.result } : {}),
      ...(current.error ? { error: current.error } : {}),
      ...(current.outputArtifactId ? { outputArtifactId: current.outputArtifactId } : {}),
      mailbox: current.kind === "agent"
        ? {
            sessionId: current.sessionId,
            kind: "agent_completion",
            payload: { jobId: current.id, childSessionId: current.childSessionId, title: current.title, status, summary },
            triggerPolicy: "context",
            dedupeKey: `job:${current.id}:completion`
          }
        : this.mailboxInput(current, status, summary, current.outputArtifactId)
    });
    this.onMailbox(completed.mailbox, completed.job);
    return completed.job;
  }

  private async completeProcess(jobId: string, result: BackendSessionResult): Promise<void> {
    const current = this.store.loadJob(jobId);
    if (["cancelling", "succeeded", "failed", "cancelled", "lost"].includes(current.status)) return;
    const status = result.session.status === "done" ? "succeeded" : "failed";
    const outputArtifact = result.output
      ? this.store.saveOutputArtifact({
          sessionId: current.sessionId,
          ...(current.toolCallId ? { toolCallId: current.toolCallId } : {}),
          content: result.output
        })
      : undefined;
    const outputPreview = takeBytes(result.output, 24 * 1024, "head");
    const summary = outputPreview || (status === "succeeded" ? "background process completed successfully." : "background process failed.");
    const completed = this.store.finalizeJobWithMailbox({
      jobId,
      status,
      settleToolStatus: status === "succeeded" ? "done" : "error",
      result: {
        processId: current.processId,
        exitCode: result.session.exitCode,
        output: outputPreview,
        ...(outputArtifact ? { outputArtifactId: outputArtifact.id } : {})
      },
      ...(status === "failed" ? { error: summary } : {}),
      ...(outputArtifact ? { outputArtifactId: outputArtifact.id } : {}),
      mailbox: this.mailboxInput(current, status, summary, outputArtifact?.id)
    });
    if (current.processId) {
      this.sessions.release(current.processId);
    }
    this.onMailbox(completed.mailbox, completed.job);
  }

  private mailboxInput(
    job: BackgroundJob,
    status: "succeeded" | "failed" | "cancelled" | "lost",
    summary: string,
    outputArtifactId?: string
  ): Omit<SessionMailboxItem, "id" | "sequence" | "state" | "createdAt"> {
    return {
      sessionId: job.sessionId,
      kind: job.kind === "agent" ? "agent_completion" : "job_completion",
      payload: {
        jobId: job.id,
        processId: job.processId,
        toolCallId: job.toolCallId,
        ...(job.title ? { title: job.title } : {}),
        ...(job.childSessionId ? { childSessionId: job.childSessionId } : {}),
        status,
        summary,
        ...(outputArtifactId ? { outputArtifactId } : {})
      },
      triggerPolicy: job.kind === "agent" ? "context" : "wake",
      dedupeKey: `job:${job.id}:completion`
    };
  }
}

function terminalSummary(job: BackgroundJob): string {
  if (job.result && typeof job.result === "object") {
    if ("response" in job.result) return String((job.result as { response?: unknown }).response ?? "Agent completed.");
    if ("output" in job.result) return String((job.result as { output?: unknown }).output ?? "background process completed.");
  }
  return `background job ${job.status}.`;
}

export function attachJobToToolCall(store: SqliteStore, toolCall: ToolCallRecord, job: BackgroundJob): ToolCallRecord {
  const next = { ...toolCall, jobId: job.id };
  store.saveToolCall(next);
  return next;
}
