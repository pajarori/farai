import type { BackgroundJob, ToolResult } from "../../types";
import type { BackendExecResult, BackendSessionResult, BackendSessionStatus, ExecutionBackend, SessionKind } from "../backends/types";
import { profileFor } from "./session-kinds";
import { sessionManager, type StartSessionResult } from "./session-manager";

function withHint(kind: SessionKind, output: string, ready: boolean): string {
  const hint = profileFor(kind).hint({ ready });
  return [hint, output].filter(Boolean).join("\n\n");
}

export function withSessionHint(kind: SessionKind, output: string): string {
  return withHint(kind, output, profileFor(kind).looksReady(output));
}

export function backgroundToolResult(tool: string, started: StartSessionResult, kind: SessionKind = "generic"): ToolResult {
  const running = started.session.status === "running";
  const output = started.output || "(no output yet)";
  const ready = profileFor(kind).looksReady(started.output);
  return {
    ok: true,
    summary: running
      ? `${tool} running in background: processId=${started.sessionId}`
      : `${tool} completed before yield: processId=${started.sessionId} exit=${started.session.exitCode}`,
    output: withHint(kind, output, ready),
    status: toolStatusForSession(started.session.status),
    ...(running ? { processId: started.sessionId } : {})
  };
}

export function timeoutBackgroundResult(tool: string, backend: ExecutionBackend, result: BackendExecResult): ToolResult | undefined {
  if (!result.backgroundSessionId) return undefined;
  const output = [result.stdout, result.stderr ? `STDERR:\n${result.stderr}` : ""].filter(Boolean).join("\n") || "(no output yet)";
  if (!sessionManager.adopt(backend, tool, result.backgroundSessionId, "generic", [result.stdout, result.stderr].filter(Boolean).join("\n"))) {
    return {
      ok: false,
      summary: `${tool} background handoff cancelled because sessions are stopping`,
      output,
      status: "error"
    };
  }
  return {
    ok: true,
    summary: `${tool} exceeded its time budget and continues running in background: processId=${result.backgroundSessionId}`,
    output: withHint("generic", output, true),
    status: "running_background",
    processId: result.backgroundSessionId
  };
}

export function terminalJobOutput(job: BackgroundJob): string {
  if (job.result && typeof job.result === "object") {
    if ("output" in job.result) return String((job.result as { output?: unknown }).output ?? "");
    if ("response" in job.result) return String((job.result as { response?: unknown }).response ?? "");
  }
  return job.error ?? `background job ${job.status}.`;
}

export function sessionPollResult(processId: string, result: BackendSessionResult, kind: SessionKind = "generic"): ToolResult {
  const running = result.session.status === "running";
  const output = result.output || "(no output yet)";
  const ready = profileFor(kind).looksReady(result.output);
  return {
    ok: result.session.status !== "error",
    summary: running
      ? `still running: processId=${processId}`
      : `${result.session.status}: processId=${processId} exit=${result.session.exitCode}`,
    output: withHint(kind, output, ready),
    status: toolStatusForSession(result.session.status),
    processId
  };
}

function toolStatusForSession(status: BackendSessionStatus): NonNullable<ToolResult["status"]> {
  if (status === "running") return "running_background";
  if (status === "done") return "done";
  return "error";
}
