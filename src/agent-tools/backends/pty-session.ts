import { spawn, type IPty } from "bun-pty";
import type { BackendSession, BackendSessionStatus } from "./types";
import { id } from "../../utils";

const MAX_RETAINED_OUTPUT_CHARS = 256 * 1024;

function appendBounded(existing: string, chunk: string): string {
  const next = existing + chunk;
  return next.length <= MAX_RETAINED_OUTPUT_CHARS ? next : next.slice(next.length - MAX_RETAINED_OUTPUT_CHARS);
}

type PtyEntry = {
  proc: IPty;
  buffer: string;
  allOutput: string;
  status: BackendSessionStatus;
  exitCode: number | null;
  lastUsedAt: number;
  exit: Promise<void>;
};

export class PtySessionStore {
  private readonly sessions = new Map<string, PtyEntry>();

  register(proc: IPty): { sessionId: string; entry: PtyEntry } {
    const sessionId = id();
    let settle!: () => void;
    const exit = new Promise<void>((resolve) => { settle = resolve; });
    const entry: PtyEntry = { proc, buffer: "", allOutput: "", status: "running", exitCode: null, lastUsedAt: Date.now(), exit };
    this.sessions.set(sessionId, entry);
    proc.onData((chunk) => {
      entry.buffer = appendBounded(entry.buffer, chunk);
      entry.allOutput = appendBounded(entry.allOutput, chunk);
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
  const out = entry.buffer;
  entry.buffer = "";
  return out;
}

export function retainedOutput(entry: PtyEntry): string {
  return entry.allOutput;
}

export function toBackendSession(sessionId: string, entry: PtyEntry): BackendSession {
  return { sessionId, status: entry.status, exitCode: entry.exitCode, pty: "pty" };
}

export function touch(entry: PtyEntry): void {
  entry.lastUsedAt = Date.now();
}

export function writePtyInput(entry: PtyEntry, input: string): void {
  entry.proc.write(input.endsWith("\n") ? input : `${input}\n`);
}

export function killPtyEntry(entry: PtyEntry): void {
  entry.proc.kill();
}
