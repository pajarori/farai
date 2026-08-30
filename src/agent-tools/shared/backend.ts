import type { ToolContext } from "../../types";
import { containerNameForSession, KaliContainerBackend } from "../../agent-container/kali";
import type { BackendExecResult, ExecutionBackend } from "../backends/types";

export type ToolExecutionBackend = ExecutionBackend & {
  exec(command: string, timeoutMs?: number, signal?: AbortSignal, maxOutputChars?: number): Promise<BackendExecResult>;
};

export function backend(context: ToolContext): ToolExecutionBackend {
  if (context.executionBackend) return context.executionBackend;
  let root = context.session;
  const visited = new Set<string>();
  while (root.parentId && context.store.loadSession && !visited.has(root.id)) {
    visited.add(root.id);
    root = context.store.loadSession(root.parentId);
  }
  return new KaliContainerBackend({
    workspace: context.workspace,
    rootWorkspace: context.rootWorkspace ?? root.workspace,
    containerName: containerNameForSession(root.id),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.timeoutMs ? { timeoutMs: context.timeoutMs } : {}),
    ...(context.onOutputChunk ? { onOutputChunk: context.onOutputChunk } : {})
  });
}
