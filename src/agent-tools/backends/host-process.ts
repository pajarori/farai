import { spawn } from "node:child_process";
import { spawn as spawnPty } from "bun-pty";
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
import { isolatedProcessGroup, terminateProcessTree } from "./process-tree";
import { BoundedOutputBuffer } from "./output-buffer";

const sessions = new SpawnSessionStore();
const ptySessions = new PtySessionStore();

export class HostProcessBackend implements ExecutionBackend {
  readonly kind = "host";

  constructor(private readonly cwd: string) {}

  async runOnce(command: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<BackendExecResult> {
    const started = Date.now();
    return await new Promise((resolve) => {
      const child = spawn("bash", ["-lc", command], { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], detached: isolatedProcessGroup() });
      const stdout = new BoundedOutputBuffer();
      const stderr = new BoundedOutputBuffer();
      let converted = false;
      let terminating = false;
      let settled = false;
      const timer = setTimeout(() => {
        if (terminating || settled) return;
        converted = true;
        child.stdout.removeListener("data", onStdout);
        child.stderr.removeListener("data", onStderr);
        const { sessionId } = sessions.register(child);
        resolve({
          exitCode: null,
          stdout: stdout.text(),
          stderr: stderr.text(),
          durationMs: Date.now() - started,
          timedOut: false,
          backgroundSessionId: sessionId
        });
      }, opts.timeoutMs);
      let settleExit!: () => void;
      const exited = new Promise<void>((settle) => { settleExit = settle; });
      const abort = () => {
        terminating = true;
        clearTimeout(timer);
        void terminateProcessTree(child, exited);
      };
      if (opts.signal?.aborted) abort();
      else opts.signal?.addEventListener("abort", abort, { once: true });
      const onStdout = (chunk: Buffer) => { stdout.push(chunk); };
      const onStderr = (chunk: Buffer) => { stderr.push(chunk); };
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.on("error", (error) => {
        settleExit();
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abort);
        if (converted || settled) return;
        settled = true;
        stderr.push(error.message);
        resolve({ exitCode: 127, stdout: stdout.text(), stderr: stderr.text(), durationMs: Date.now() - started, timedOut: false });
      });
      child.on("close", (exitCode) => {
        settleExit();
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abort);
        if (converted || settled) return;
        settled = true;
        resolve({ exitCode, stdout: stdout.text(), stderr: stderr.text(), durationMs: Date.now() - started, timedOut: false });
      });
    });
  }

  async startSession(command: string, opts: { yieldMs: number; signal?: AbortSignal; kind?: SessionKind; pty?: boolean }): Promise<BackendSessionResult> {
    if (opts.pty) {
      const proc = spawnPty("bash", ["-lc", command], { name: "xterm-256color", cols: 120, rows: 30, cwd: this.cwd, env: process.env as Record<string, string> });
      const { sessionId, entry } = ptySessions.register(proc);
      const abort = () => { void killPtyEntry(entry); };
      if (opts.signal?.aborted) abort();
      else opts.signal?.addEventListener("abort", abort, { once: true });
      void entry.exit.then(() => opts.signal?.removeEventListener("abort", abort));
      await waitForPtyExitOrYield(entry, opts.yieldMs);
      touchPty(entry);
      return { session: toPtyBackendSession(sessionId, entry), output: drainOutput(entry) };
    }

    const child = spawn("bash", ["-lc", command], { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], detached: isolatedProcessGroup() });
    const { sessionId, entry } = sessions.register(child);
    const abort = () => { void killEntry(entry); };
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener("abort", abort, { once: true });
    void entry.exit.then(() => opts.signal?.removeEventListener("abort", abort));
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
      if (opts.input) await writePtyInput(ptyEntry, opts.input);
      await waitForPtyExitOrYield(ptyEntry, opts.yieldMs);
      touchPty(ptyEntry);
      return { session: toPtyBackendSession(sessionId, ptyEntry), output: drainOutput(ptyEntry) };
    }

    const entry = sessions.get(sessionId);
    if (!entry) throw new Error(`Unknown session: ${sessionId}`);
    if (opts.input) await writeInput(entry, opts.input);
    await waitForExitOrYield(entry, opts.yieldMs);
    touch(entry);
    return { session: toBackendSession(sessionId, entry), output: combinedOutput(entry) };
  }

  async stopSession(sessionId: string): Promise<void> {
    const ptyEntry = ptySessions.get(sessionId);
    if (ptyEntry) {
      await killPtyEntry(ptyEntry);
      ptySessions.delete(sessionId);
      return;
    }

    const entry = sessions.get(sessionId);
    if (!entry) return;
    await killEntry(entry);
    sessions.delete(sessionId);
  }
}
