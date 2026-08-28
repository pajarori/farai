import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { sessionPollResult, terminalJobOutput } from "../shared/background-result";
import { clampYieldMs, MAX_YIELD_MS, sessionManager } from "../shared/session-manager";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { oastEvidence, parseOastEvents } from "../callback/oast-parser";

const MAX_SESSION_POLL_TIMEOUT_MS = MAX_YIELD_MS + 5_000;

export const sessionPollTool: ToolDefinition = {
  name: "session_poll",
  description: "Check on (and optionally send input to) a background command by jobId or legacy processId. Call with no input to just poll for more output.",
  inputSchema: {
    type: "object",
    properties: {
      jobId: { type: "string" },
      processId: { type: "string" },
      input: { type: "string" },
      yieldMs: { type: "number" }
    }
  },
  mutates: true,
  timeoutMs: MAX_SESSION_POLL_TIMEOUT_MS,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const requestedJobId = typeof args.jobId === "string" ? args.jobId : undefined;
    const requestedProcessId = typeof args.processId === "string" ? args.processId : undefined;
    const job = requestedJobId
      ? context.store.loadJob?.(requestedJobId)
      : requestedProcessId
        ? context.store.findJobByProcessId?.(requestedProcessId)
        : undefined;
    const input = typeof args.input === "string" ? args.input : undefined;
    if (job && job.sessionId !== context.session.id) throw new Error(`background job ${job.id} belongs to another session`);
    if (job?.kind === "agent") {
      if (input) throw new Error("agent jobs do not accept session input; resume the child with agent_task instead");
      if (["succeeded", "failed", "cancelled", "lost"].includes(job.status)) {
        const artifact = job.outputArtifactId ? context.store.readOutputArtifact?.(job.outputArtifactId) : undefined;
        const output = artifact?.content ?? terminalJobOutput(job);
        return {
          ok: job.status === "succeeded",
          summary: `${job.status}: jobId=${job.id} childSessionId=${job.childSessionId}`,
          output,
          status: job.status === "succeeded" ? "done" : "error",
          jobId: job.id,
          ...(job.outputArtifactId ? { outputArtifactId: job.outputArtifactId } : {}),
          metadata: { kind: "agent", childSessionId: job.childSessionId }
        };
      }
      return {
        ok: true,
        summary: `${job.status}: jobId=${job.id} childSessionId=${job.childSessionId}`,
        output: "subagent is still running; completion will be delivered automatically.",
        status: "running_background",
        jobId: job.id,
        metadata: { kind: "agent", childSessionId: job.childSessionId }
      };
    }
    const processId = job?.processId ?? asString(args.processId, "processId");
    if (job && ["succeeded", "failed", "cancelled", "lost"].includes(job.status)) {
      const artifact = job.outputArtifactId ? context.store.readOutputArtifact?.(job.outputArtifactId) : undefined;
      const output = artifact?.content ?? terminalJobOutput(job);
      return {
        ok: job.status === "succeeded",
        summary: `${job.status}: jobId=${job.id} processId=${processId}`,
        output,
        status: job.status === "succeeded" ? "done" : "error",
        jobId: job.id,
        processId,
        ...(job.outputArtifactId ? { outputArtifactId: job.outputArtifactId } : {})
      };
    }
    const kind = sessionManager.getKind(processId);
    const result = await sessionManager.poll(processId, input, clampYieldMs(args.yieldMs));
    const base = sessionPollResult(processId, result, kind);
    if (kind !== "oast") return base;
    const events = parseOastEvents(result.output);
    const evidence = oastEvidence(context, events);
    return {
      ...base,
      summary: events.length ? `${base.summary}; ${events.length} OAST interaction(s) received` : base.summary,
      ...(evidence.length ? { evidence } : {}),
      metadata: { ...(base.metadata ?? {}), oastInteractions: events }
    };
  }
};
