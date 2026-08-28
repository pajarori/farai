import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { debugLogPath, isDebugLoggingEnabled } from "../global-config";

export const PLANNER_REQUEST_TIMEOUT_MS = 180_000;

export function planRequestSignal(caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PLANNER_REQUEST_TIMEOUT_MS);
  if (!caller) return timeout;
  return AbortSignal.any([caller, timeout]);
}

export function parseRetryAfterMs(headers: Headers): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(retryAfter);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function logDebugEntry(entry: Record<string, unknown>): void {
  if (!isDebugLoggingEnabled()) return;
  try {
    const path = debugLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
  } catch {}
}
