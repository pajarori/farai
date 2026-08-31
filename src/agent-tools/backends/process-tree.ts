import type { ChildProcess } from "node:child_process";

export const PROCESS_TERMINATION_GRACE_MS = 1_000;

export function isolatedProcessGroup(): boolean {
  return process.platform !== "win32";
}

function signalDirectProcess(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

export async function terminateProcessTree(
  child: ChildProcess,
  exited: Promise<unknown>,
  graceMs = PROCESS_TERMINATION_GRACE_MS
): Promise<void> {
  const pid = child.pid;
  await terminateProcessGroup(pid, exited, (signal) => signalDirectProcess(child, signal), graceMs);
}

export async function terminateProcessGroup(
  pid: number | undefined,
  exited: Promise<unknown>,
  fallback: (signal: NodeJS.Signals) => unknown,
  graceMs = PROCESS_TERMINATION_GRACE_MS
): Promise<void> {
  if (!pid || !signalProcessGroup(pid, "SIGTERM")) fallback("SIGTERM");
  if (await waitForTreeExit(pid, exited, graceMs)) return;
  if (!pid || !signalProcessGroup(pid, "SIGKILL")) fallback("SIGKILL");
  await waitForTreeExit(pid, exited, graceMs);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (!isolatedProcessGroup()) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function waitForTreeExit(pid: number | undefined, exited: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (!isolatedProcessGroup() || !pid) return await settlesWithin(exited, timeoutMs);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (processGroupAlive(pid) && Date.now() < deadline) await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  const stopped = !processGroupAlive(pid);
  if (stopped) await settlesWithin(exited, 100);
  return stopped;
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs)); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
