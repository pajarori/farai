import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { spawn as spawnPty } from "bun-pty";
import { truncate } from "../../utils";
import type { BackendExecResult, BackendSessionResult, ExecutionBackend, SessionKind } from "./types";
import { SpawnSessionStore, allOutput, combinedOutput, killEntry, toBackendSession, touch, waitForExit, waitForExitOrYield, writeInput } from "./spawn-session";
import {
  PtySessionStore,
  drainOutput,
  killPtyEntry,
  retainedOutput,
  toBackendSession as toPtyBackendSession,
  touch as touchPty,
  waitForPtyExit,
  waitForPtyExitOrYield,
  writePtyInput
} from "./pty-session";

const sessions = new SpawnSessionStore();
const ptySessions = new PtySessionStore();

export class HostProcessBackend implements ExecutionBackend {
  readonly kind = "host";

  constructor(private readonly cwd: string) {}

  async runOnce(command: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<BackendExecResult> {
    const started = Date.now();
    return await new Promise((resolve) => {
      const child = spawn("bash", ["-lc", command], { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let converted = false;
      const timer = setTimeout(() => {
        converted = true;
        const { sessionId } = sessions.register(child);
        resolve({
          exitCode: null,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          durationMs: Date.now() - started,
          timedOut: false,
          backgroundSessionId: sessionId
        });
      }, opts.timeoutMs);
      const abort = () => child.kill("SIGTERM");
      if (opts.signal?.aborted) abort();
      else opts.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk) => { stdout += stdoutDecoder.write(chunk); });
      child.stderr.on("data", (chunk) => { stderr += stderrDecoder.write(chunk); });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abort);
        if (converted) return;
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        resolve({ exitCode, stdout: truncate(stdout), stderr: truncate(stderr), durationMs: Date.now() - started, timedOut: false });
      });
    });
  }

  async startSession(command: string, opts: { yieldMs: number; signal?: AbortSignal; kind?: SessionKind; pty?: boolean }): Promise<BackendSessionResult> {
    if (opts.pty) {
      const proc = spawnPty("bash", ["-l"], { name: "xterm-256color", cols: 120, rows: 30, cwd: this.cwd, env: process.env as Record<string, string> });
      const abort = () => proc.kill();
      if (opts.signal?.aborted) abort();
      else opts.signal?.addEventListener("abort", abort, { once: true });

      const { sessionId, entry } = ptySessions.register(proc);
      writePtyInput(entry, command);
      await waitForPtyExitOrYield(entry, opts.yieldMs);
      touchPty(entry);
      return { session: toPtyBackendSession(sessionId, entry), output: drainOutput(entry) };
    }

    const child = spawn("bash", ["-lc", command], { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const abort = () => child.kill("SIGTERM");
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener("abort", abort, { once: true });

    const { sessionId, entry } = sessions.register(child);
    await waitForExitOrYield(entry, opts.yieldMs);
    touch(entry);
    return { session: toBackendSession(sessionId, entry), output: combinedOutput(entry) };
  }

  async waitSession(sessionId: string): Promise<BackendSessionResult> {
    const ptyEntry = ptySessions.get(sessionId);
    if (ptyEntry) {
      await waitForPtyExit(ptyEntry);
      touchPty(ptyEntry);
      return { session: toPtyBackendSession(sessionId, ptyEntry), output: retainedOutput(ptyEntry) };
    }

    const entry = sessions.get(sessionId);
    if (!entry) throw new Error(`Unknown session: ${sessionId}`);
    await waitForExit(entry);
    touch(entry);
    return { session: toBackendSession(sessionId, entry), output: allOutput(entry) };
  }

  async pollSession(sessionId: string, opts: { input?: string; yieldMs: number }): Promise<BackendSessionResult> {
    const ptyEntry = ptySessions.get(sessionId);
    if (ptyEntry) {
      if (opts.input) writePtyInput(ptyEntry, opts.input);
      await waitForPtyExitOrYield(ptyEntry, opts.yieldMs);
      touchPty(ptyEntry);
      return { session: toPtyBackendSession(sessionId, ptyEntry), output: drainOutput(ptyEntry) };
    }

    const entry = sessions.get(sessionId);
    if (!entry) throw new Error(`Unknown session: ${sessionId}`);
    if (opts.input) writeInput(entry, opts.input);
    await waitForExitOrYield(entry, opts.yieldMs);
    touch(entry);
    return { session: toBackendSession(sessionId, entry), output: combinedOutput(entry) };
  }

  async stopSession(sessionId: string): Promise<void> {
    const ptyEntry = ptySessions.get(sessionId);
    if (ptyEntry) {
      killPtyEntry(ptyEntry);
      ptySessions.delete(sessionId);
      return;
    }

    const entry = sessions.get(sessionId);
    if (!entry) return;
    killEntry(entry);
    sessions.delete(sessionId);
  }
}
