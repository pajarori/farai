import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { BackendSession, BackendSessionStatus } from "./types";
import { id } from "../../utils";

type SessionEntry = {
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  allStdout: string;
  allStderr: string;
  status: BackendSessionStatus;
  exitCode: number | null;
  lastUsedAt: number;
  exit: Promise<void>;
};

const MAX_RETAINED_OUTPUT_CHARS = 256 * 1024;

function appendBounded(existing: string, chunk: string): string {
  const next = existing + chunk;
  return next.length <= MAX_RETAINED_OUTPUT_CHARS ? next : next.slice(next.length - MAX_RETAINED_OUTPUT_CHARS);
}

export class SpawnSessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  register(child: ChildProcessWithoutNullStreams): { sessionId: string; entry: SessionEntry } {
    const sessionId = id();
    let settle!: () => void;
    const exit = new Promise<void>((resolve) => { settle = resolve; });
    const entry: SessionEntry = { child, stdout: "", stderr: "", allStdout: "", allStderr: "", status: "running", exitCode: null, lastUsedAt: Date.now(), exit };
    this.sessions.set(sessionId, entry);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      entry.stdout = appendBounded(entry.stdout, text);
      entry.allStdout = appendBounded(entry.allStdout, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      entry.stderr = appendBounded(entry.stderr, text);
      entry.allStderr = appendBounded(entry.allStderr, text);
    });
    child.on("close", (exitCode) => {
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
  const out = entry.stdout;
  const err = entry.stderr;
  entry.stdout = "";
  entry.stderr = "";
  return [out, err ? `STDERR:\n${err}` : ""].filter(Boolean).join("\n");
}

export function allOutput(entry: SessionEntry): string {
  return [entry.allStdout, entry.allStderr ? `STDERR:\n${entry.allStderr}` : ""].filter(Boolean).join("\n");
}

export function toBackendSession(sessionId: string, entry: SessionEntry): BackendSession {
  return { sessionId, status: entry.status, exitCode: entry.exitCode };
}

export function touch(entry: SessionEntry): void {
  entry.lastUsedAt = Date.now();
}

export function writeInput(entry: SessionEntry, input: string): void {
  entry.child.stdin.write(input.endsWith("\n") ? input : `${input}\n`);
}

export function killEntry(entry: SessionEntry): void {
  entry.child.kill("SIGTERM");
}
