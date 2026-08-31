import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { BackendSession, BackendSessionStatus } from "./types";
import { id } from "../../utils";
import { terminateProcessTree } from "./process-tree";
import { BACKGROUND_PROCESS_OUTPUT_MAX_BYTES, BoundedOutputBuffer } from "./output-buffer";

type SessionEntry = {
  child: ChildProcessWithoutNullStreams;
  stdout: BoundedOutputBuffer;
  stderr: BoundedOutputBuffer;
  allStdout: BoundedOutputBuffer;
  allStderr: BoundedOutputBuffer;
  status: BackendSessionStatus;
  exitCode: number | null;
  lastUsedAt: number;
  exit: Promise<void>;
  beforeKill?: () => Promise<void>;
};

type SpawnSessionOptions = {
  beforeKill?: () => Promise<void>;
};

export class SpawnSessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  register(child: ChildProcessWithoutNullStreams, options: SpawnSessionOptions = {}): { sessionId: string; entry: SessionEntry } {
    const sessionId = id();
    let settle!: () => void;
    const exit = new Promise<void>((resolve) => { settle = resolve; });
    let finished = false;
    const entry: SessionEntry = {
      child,
      stdout: new BoundedOutputBuffer(BACKGROUND_PROCESS_OUTPUT_MAX_BYTES),
      stderr: new BoundedOutputBuffer(BACKGROUND_PROCESS_OUTPUT_MAX_BYTES),
      allStdout: new BoundedOutputBuffer(BACKGROUND_PROCESS_OUTPUT_MAX_BYTES),
      allStderr: new BoundedOutputBuffer(BACKGROUND_PROCESS_OUTPUT_MAX_BYTES),
      status: "running",
      exitCode: null,
      lastUsedAt: Date.now(),
      exit,
      ...(options.beforeKill ? { beforeKill: options.beforeKill } : {})
    };
    this.sessions.set(sessionId, entry);
    child.stdout.on("data", (chunk) => {
      entry.stdout.push(chunk);
      entry.allStdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      entry.stderr.push(chunk);
      entry.allStderr.push(chunk);
    });
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      entry.stderr.push(error.message);
      entry.allStderr.push(error.message);
      entry.status = "error";
      entry.exitCode = 127;
      settle();
    });
    child.on("close", (exitCode) => {
      if (finished) return;
      finished = true;
      entry.status = exitCode === 0 ? "done" : "error";
      entry.exitCode = exitCode;
      settle();
    });
    return { sessionId, entry };
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export function waitForExit(entry: SessionEntry): Promise<void> {
  return entry.exit;
}

export function waitForExitOrYield(entry: SessionEntry, yieldMs: number): Promise<void> {
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

export function combinedOutput(entry: SessionEntry): string {
  const out = entry.stdout.takeText();
  const err = entry.stderr.takeText();
  return [out, err ? `STDERR:\n${err}` : ""].filter(Boolean).join("\n");
}

export function allOutput(entry: SessionEntry): string {
  const stdout = entry.allStdout.text();
  const stderr = entry.allStderr.text();
  return [stdout, stderr ? `STDERR:\n${stderr}` : ""].filter(Boolean).join("\n");
}

export function toBackendSession(sessionId: string, entry: SessionEntry): BackendSession {
  return { sessionId, status: entry.status, exitCode: entry.exitCode };
}

export function touch(entry: SessionEntry): void {
  entry.lastUsedAt = Date.now();
}

export async function writeInput(entry: SessionEntry, input: string): Promise<void> {
  if (entry.status !== "running" || entry.child.stdin.destroyed || !entry.child.stdin.writable) {
    throw new Error("Background session input is closed");
  }
  await new Promise<void>((resolve, reject) => {
    entry.child.stdin.write(input.endsWith("\n") ? input : `${input}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function killEntry(entry: SessionEntry): Promise<void> {
  if (entry.status !== "running") return;
  let cleanupError: unknown;
  try {
    await entry.beforeKill?.();
  } catch (error) {
    cleanupError = error;
  }
  await terminateProcessTree(entry.child, entry.exit);
  if (cleanupError) throw cleanupError;
}
