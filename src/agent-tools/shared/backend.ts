import type { ToolContext } from "../../types";
import { containerNameForSession, KaliContainerBackend } from "../../agent-container/kali";
import type { BackendExecResult, ExecutionBackend } from "../backends/types";

export type ToolExecutionBackend = ExecutionBackend & {
  exec(command: string, timeoutMs?: number, signal?: AbortSignal, maxOutputChars?: number): Promise<BackendExecResult>;
};

export function backend(context: ToolContext): ToolExecutionBackend {
  if (context.executionBackend) return context.executionBackend;
  return new KaliContainerBackend({
    workspace: context.workspace,
    containerName: containerNameForSession(context.session.id),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.timeoutMs ? { timeoutMs: context.timeoutMs } : {}),
    ...(context.onOutputChunk ? { onOutputChunk: context.onOutputChunk } : {})
  });
}
