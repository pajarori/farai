import type { ToolContext } from "../../types";
import { runCapturedProcess } from "../backends/captured-process";
import { DEFAULT_PROCESS_OUTPUT_MAX_BYTES } from "../backends/output-buffer";

export async function runHostProcess(
  command: string,
  args: string[],
  cwd: string,
  context?: ToolContext
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await runCapturedProcess(command, args, {
    cwd,
    timeoutMs: context?.timeoutMs ?? 10_000,
    ...(context?.signal ? { signal: context.signal } : {}),
    maxOutputBytes: DEFAULT_PROCESS_OUTPUT_MAX_BYTES
  });
}
