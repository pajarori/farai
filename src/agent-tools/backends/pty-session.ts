import { spawn, type IPty } from "bun-pty";
import type { BackendSession, BackendSessionStatus } from "./types";
import { id } from "../../utils";
import { terminateProcessGroup } from "./process-tree";
import { BACKGROUND_PROCESS_OUTPUT_MAX_BYTES, BoundedOutputBuffer } from "./output-buffer";

type PtyEntry = {
  proc: IPty;
  buffer: BoundedOutputBuffer;
  allOutput: BoundedOutputBuffer;
  status: BackendSessionStatus;
  exitCode: number | null;
  lastUsedAt: number;
  exit: Promise<void>;
  beforeKill?: () => Promise<void>;
};

type PtySessionOptions = {
  beforeKill?: () => Promise<void>;
};

export class PtySessionStore {
  private readonly sessions = new Map<string, PtyEntry>();

  register(proc: IPty, options: PtySessionOptions = {}): { sessionId: string; entry: PtyEntry } {
    const sessionId = id();
    let settle!: () => void;
    const exit = new Promise<void>((resolve) => { settle = resolve; });
    const entry: PtyEntry = {
      proc,
      buffer: new BoundedOutputBuffer(BACKGROUND_PROCESS_OUTPUT_MAX_BYTES),
      allOutput: new BoundedOutputBuffer(BACKGROUND_PROCESS_OUTPUT_MAX_BYTES),
      status: "running",
      exitCode: null,
      lastUsedAt: Date.now(),
      exit,
      ...(options.beforeKill ? { beforeKill: options.beforeKill } : {})
    };
    this.sessions.set(sessionId, entry);
    proc.onData((chunk) => {
      entry.buffer.push(chunk);
      entry.allOutput.push(chunk);
    });
    proc.onExit(({ exitCode }) => {
      entry.status = exitCode === 0 ? "done" : "error";
      entry.exitCode = exitCode;
      settle();
    });
    return { sessionId, entry };
  }

  get(sessionId: string): PtyEntry | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export function waitForPtyExit(entry: PtyEntry): Promise<void> {
  return entry.exit;
}

export function waitForPtyExitOrYield(entry: PtyEntry, yieldMs: number): Promise<void> {
  if (entry.status !== "running") return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, yieldMs);
    void entry.exit.then(finish);
  });
}

export function drainOutput(entry: PtyEntry): string {
  return entry.buffer.takeText();
}

export function retainedOutput(entry: PtyEntry): string {
  return entry.allOutput.text();
}

export function toBackendSession(sessionId: string, entry: PtyEntry): BackendSession {
  return { sessionId, status: entry.status, exitCode: entry.exitCode, pty: "pty" };
}

export function touch(entry: PtyEntry): void {
  entry.lastUsedAt = Date.now();
}

export async function writePtyInput(entry: PtyEntry, input: string): Promise<void> {
  if (entry.status !== "running") throw new Error("Background session input is closed");
  entry.proc.write(input.endsWith("\n") ? input : `${input}\n`);
}

export async function killPtyEntry(entry: PtyEntry): Promise<void> {
  if (entry.status !== "running") return;
  let cleanupError: unknown;
  try {
    await entry.beforeKill?.();
  } catch (error) {
    cleanupError = error;
  }
  await terminateProcessGroup(entry.proc.pid, entry.exit, (signal) => entry.proc.kill(signal));
  if (entry.status === "running") entry.proc.kill("SIGKILL");
  if (cleanupError) throw cleanupError;
}
