import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { BoundedOutputBuffer, INTERNAL_PROCESS_OUTPUT_MAX_BYTES } from "./output-buffer";
import { isolatedProcessGroup, terminateProcessTree } from "./process-tree";

export type CapturedProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
};

export type CapturedProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
};

export async function runCapturedProcess(
  command: string,
  args: string[],
  options: CapturedProcessOptions = {}
): Promise<CapturedProcessResult> {
  const started = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? INTERNAL_PROCESS_OUTPUT_MAX_BYTES;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: isolatedProcessGroup()
    });
  } catch (error) {
    return failureResult(error, started);
  }

  const stdout = new BoundedOutputBuffer(maxOutputBytes);
  const stderr = new BoundedOutputBuffer(maxOutputBytes);
  collect(child.stdout, stdout);
  collect(child.stderr, stderr);

  return await new Promise((resolve) => {
    let settled = false;
    let treeSettled = false;
    let timedOut = false;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settleTree!: () => void;
    const exited = new Promise<void>((settle) => { settleTree = settle; });

    const markTreeSettled = () => {
      if (treeSettled) return;
      treeSettled = true;
      settleTree();
    };
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: timedOut || aborted ? null : exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        durationMs: Date.now() - started,
        timedOut,
        aborted
      });
    };
    const terminate = (reason: "timeout" | "abort") => {
      if (settled || timedOut || aborted) return;
      timedOut = reason === "timeout";
      aborted = reason === "abort";
      void terminateProcessTree(child, exited).finally(() => finish(null));
    };
    const onAbort = () => terminate("abort");

    child.once("error", (error) => {
      stderr.push(error instanceof Error ? error.message : String(error));
      markTreeSettled();
      if (!timedOut && !aborted) finish(127);
    });
    child.once("close", (code) => {
      markTreeSettled();
      if (!timedOut && !aborted) finish(code);
    });

    if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0) {
      timer = setTimeout(() => terminate("timeout"), options.timeoutMs);
      timer.unref?.();
    }
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", (error) => {
        if (!settled) stderr.push(error instanceof Error ? error.message : String(error));
      });
      child.stdin.end(options.input);
    }
  });
}

function collect(stream: Readable | null, output: BoundedOutputBuffer): void {
  stream?.on("data", (chunk: Buffer | string) => output.push(chunk));
}

function failureResult(error: unknown, started: number): CapturedProcessResult {
  return {
    exitCode: 127,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    durationMs: Date.now() - started,
    timedOut: false,
    aborted: false
  };
}
