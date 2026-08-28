import { spawn } from "node:child_process";
import type { ToolContext } from "../../types";
import { truncate } from "../../utils";

export async function runHostProcess(
  command: string,
  args: string[],
  cwd: string,
  context?: ToolContext
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const timeoutMs = context?.timeoutMs ?? 10_000;
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const abort = () => child.kill("SIGTERM");
    if (context?.signal?.aborted) abort();
    else context?.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      context?.signal?.removeEventListener("abort", abort);
      resolve({ exitCode, stdout: truncate(stdout), stderr: truncate(stderr) });
    });
  });
}
