import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
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
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const abort = () => child.kill("SIGTERM");
    if (context?.signal?.aborted) abort();
    else context?.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += stderrDecoder.write(chunk);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      context?.signal?.removeEventListener("abort", abort);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ exitCode, stdout: truncate(stdout), stderr: truncate(stderr) });
    });
  });
}
