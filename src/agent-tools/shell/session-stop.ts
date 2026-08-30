import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { sessionManager } from "../shared/session-manager";
import { defaultModelRenderer } from "../shared/renderers";

export const sessionStopTool: ToolDefinition = {
  name: "session_stop",
  description: "Cancel background work by jobId, or stop a legacy command session by processId. Use this for commands, listeners, and detached jobs that should no longer run; use agent_interrupt or agent_close when controlling a child agent directly.",
  inputSchema: {
    type: "object",
    properties: { jobId: { type: "string" }, processId: { type: "string" } }
  },
  mutates: true,
  timeoutMs: 5_000,
  parallel: true,
  renderHuman: (result) => result.summary,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const jobId = typeof args.jobId === "string" ? args.jobId : undefined;
    if (jobId) {
      if (!context.cancelJob) throw new Error("job cancellation is unavailable in this runtime");
      const job = await context.cancelJob(jobId);
      return { ok: true, summary: "background work stopped", output: jobId, jobId, ...(job.processId ? { processId: job.processId } : {}) };
    }
    const processId = asString(args.processId, "processId");
    const job = context.store.findJobByProcessId?.(processId);
    if (job) {
      if (!context.cancelJob) throw new Error("job cancellation is unavailable in this runtime");
      const stopped = await context.cancelJob(job.id);
      return { ok: true, summary: "background work stopped", output: job.id, jobId: job.id, processId };
    }
    await sessionManager.stop(processId);
    return { ok: true, summary: "background work stopped", output: processId, processId };
  }
};
