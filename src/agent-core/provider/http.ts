import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { debugLogPath, isDebugLoggingEnabled } from "../global-config";
import { ensurePrivateDirectory, ensurePrivateRegularFileIfExists } from "../private-path";
import { readBoundedResponsePreview, readBoundedResponseText, ResponseSizeLimitError } from "../../http-response";
import {
  BoundedTextCapture,
  PROVIDER_DEBUG_CAPTURE_MAX_BYTES,
  utf8Prefix,
  type ProviderResponseLimits
} from "./stream-bounds";

export const PLANNER_REQUEST_TIMEOUT_MS = 180_000;
const PROVIDER_DEBUG_LOG_MAX_BYTES = 8 * 1024 * 1024;
const PROVIDER_DEBUG_LOG_BACKUPS = 3;
const PROVIDER_DEBUG_ENTRY_MAX_BYTES = 256 * 1024;
const PROVIDER_DEBUG_VALUE_MAX_BYTES = 32 * 1024;
const PROVIDER_DEBUG_MAX_DEPTH = 12;
const PROVIDER_DEBUG_MAX_NODES = 4_000;
const PROVIDER_DEBUG_MAX_ITEMS = 200;

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

export async function readResponseTextBounded(response: Response, maxBytes: number, label: string): Promise<string> {
  return await readBoundedResponseText(response, maxBytes, label);
}

export async function readResponseTextPreview(response: Response, maxBytes: number): Promise<string> {
  return await readBoundedResponsePreview(response, maxBytes, "[... provider response truncated ...]");
}

export function providerHttpError(status: number, responseText: string, credentialConfigured: boolean): string {
  const detail = responseText.trim();
  const authHint = status === 401 || status === 403
    ? credentialConfigured
      ? "the configured credential was rejected"
      : "no api key is configured; open /models and edit this provider"
    : undefined;
  return [`http ${status}`, detail, authHint].filter(Boolean).join(" · ");
}

export function createProviderDebugCapture(): BoundedTextCapture | undefined {
  return isDebugLoggingEnabled() ? new BoundedTextCapture(PROVIDER_DEBUG_CAPTURE_MAX_BYTES) : undefined;
}

export async function* iterateSseData(
  response: Response,
  limits: Pick<ProviderResponseLimits, "sseEventBytes" | "sseStreamBytes" | "sseEvents">,
  capture?: BoundedTextCapture
): AsyncIterable<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider returned an empty event stream body");
  const decoder = new SseDataDecoder(limits.sseEventBytes);
  let streamBytes = 0;
  let events = 0;
  let completed = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        break;
      }
      streamBytes += next.value.length;
      if (streamBytes > limits.sseStreamBytes) throw new ResponseSizeLimitError("provider event stream", limits.sseStreamBytes);
      for (const data of decoder.push(next.value)) {
        events += 1;
        if (events > limits.sseEvents) throw new Error(`provider event stream exceeded the ${limits.sseEvents}-event limit`);
        capture?.append(`${data}\n`);
        yield data;
      }
    }
  } finally {
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function logDebugEntry(entry: Record<string, unknown>): void {
  if (!isDebugLoggingEnabled()) return;
  try {
    const path = debugLogPath();
    ensurePrivateDirectory(dirname(path), "debug log directory");
    const state = { nodes: 0, bytes: 0, seen: new WeakSet<object>() };
    const bounded = boundedDebugValue(entry, "", 0, state);
    let serialized = JSON.stringify({ timestamp: new Date().toISOString(), ...(isRecord(bounded) ? bounded : { entry: bounded }) });
    if (Buffer.byteLength(serialized, "utf8") > PROVIDER_DEBUG_ENTRY_MAX_BYTES) {
      serialized = JSON.stringify({
        timestamp: new Date().toISOString(),
        baseUrl: boundedDebugScalar(entry.baseUrl),
        model: boundedDebugScalar(entry.model),
        responseStatus: boundedDebugScalar(entry.responseStatus),
        truncated: true
      });
    }
    const line = `${serialized}\n`;
    rotateDebugLog(path, Buffer.byteLength(line, "utf8"));
    appendPrivateDebugLine(path, line);
  } catch {}
}

function boundedDebugValue(
  value: unknown,
  key: string,
  depth: number,
  state: { nodes: number; bytes: number; seen: WeakSet<object> }
): unknown {
  state.nodes += 1;
  if (state.nodes > PROVIDER_DEBUG_MAX_NODES || state.bytes >= PROVIDER_DEBUG_ENTRY_MAX_BYTES) return "[debug value omitted]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (isEncodedImage(value, key)) return `[image payload omitted: ${Buffer.byteLength(value, "utf8")} encoded bytes]`;
    const retained = utf8Prefix(value, Math.min(PROVIDER_DEBUG_VALUE_MAX_BYTES, Math.max(0, PROVIDER_DEBUG_ENTRY_MAX_BYTES - state.bytes)));
    const retainedBytes = Buffer.byteLength(retained, "utf8");
    state.bytes += retainedBytes;
    return retainedBytes < Buffer.byteLength(value, "utf8") ? `${retained}\n[... debug value truncated ...]` : retained;
  }
  if (typeof value !== "object") return String(value);
  if (depth >= PROVIDER_DEBUG_MAX_DEPTH) return "[debug depth limit reached]";
  if (state.seen.has(value)) return "[circular]";
  state.seen.add(value);
  if (Array.isArray(value)) {
    const retained = value.slice(0, PROVIDER_DEBUG_MAX_ITEMS).map((item) => boundedDebugValue(item, key, depth + 1, state));
    if (value.length > retained.length) retained.push(`[... ${value.length - retained.length} items omitted ...]`);
    return retained;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, PROVIDER_DEBUG_MAX_ITEMS);
  for (const [childKey, child] of entries) {
    state.bytes += Buffer.byteLength(childKey, "utf8");
    out[childKey] = boundedDebugValue(child, childKey, depth + 1, state);
  }
  const omitted = Object.keys(value).length - entries.length;
  if (omitted > 0) out.__omitted = `${omitted} properties`;
  return out;
}

function boundedDebugScalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return utf8Prefix(value, 1_024);
  return undefined;
}

function isEncodedImage(value: string, key: string): boolean {
  if (value.startsWith("data:image/") && value.includes(";base64,")) return true;
  return key === "data" && value.length >= 256 && /^[A-Za-z0-9+/]+=*$/.test(value);
}

function rotateDebugLog(path: string, incomingBytes: number): void {
  const currentBytes = privateFileSize(path, "debug log");
  if (currentBytes + incomingBytes <= PROVIDER_DEBUG_LOG_MAX_BYTES) return;
  for (let index = 1; index <= PROVIDER_DEBUG_LOG_BACKUPS; index += 1) {
    ensurePrivateRegularFileIfExists(`${path}.${index}`, "debug log backup");
  }
  for (let index = PROVIDER_DEBUG_LOG_BACKUPS; index >= 1; index -= 1) {
    const source = index === 1 ? path : `${path}.${index - 1}`;
    const target = `${path}.${index}`;
    if (privateRegularFileExists(target, "debug log backup")) unlinkSync(target);
    if (privateRegularFileExists(source, index === 1 ? "debug log" : "debug log backup")) renameSync(source, target);
  }
}

function appendPrivateDebugLine(path: string, line: string): void {
  ensurePrivateRegularFileIfExists(path, "debug log");
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("debug log must be a regular file");
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, line, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function privateFileSize(path: string, label: string): number {
  ensurePrivateRegularFileIfExists(path, label);
  const stat = lstatIfExists(path);
  return stat ? Number(stat.size) : 0;
}

function privateRegularFileExists(path: string, label: string): boolean {
  ensurePrivateRegularFileIfExists(path, label);
  const stat = lstatIfExists(path);
  if (!stat) return false;
  return true;
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

class SseDataDecoder {
  private buffer = new Uint8Array(8192);
  private start = 0;
  private end = 0;
  private scan = 0;
  private skipLeadingLf = false;
  private eventBytes = 0;
  private data: string[] = [];

  constructor(private readonly maxEventBytes: number) {}

  push(chunk: Uint8Array): string[] {
    let input = chunk;
    if (this.skipLeadingLf) {
      this.skipLeadingLf = false;
      if (input[0] === 0x0a) input = input.subarray(1);
    }
    if (input.length === 0) return [];
    this.append(input);
    const events: string[] = [];
    while (this.scan < this.end) {
      const byte = this.buffer[this.scan];
      if (byte !== 0x0a && byte !== 0x0d) {
        this.scan += 1;
        if (this.scan - this.start > this.maxEventBytes) throw new ResponseSizeLimitError("provider sse event", this.maxEventBytes);
        continue;
      }
      const lineEnd = this.scan;
      const carriage = byte === 0x0d;
      this.scan += 1;
      const line = this.buffer.subarray(this.start, lineEnd);
      if (carriage) {
        if (this.scan < this.end && this.buffer[this.scan] === 0x0a) this.scan += 1;
        else if (this.scan === this.end) this.skipLeadingLf = true;
      }
      this.start = this.scan;
      const event = this.consumeLine(line);
      if (event !== undefined) events.push(event);
    }
    if (this.start === this.end) {
      this.start = 0;
      this.end = 0;
      this.scan = 0;
    }
    return events;
  }

  private append(chunk: Uint8Array): void {
    const active = this.end - this.start;
    if (active + chunk.length > this.buffer.length) {
      const capacity = Math.max(this.buffer.length * 2, active + chunk.length, 8192);
      const next = new Uint8Array(capacity);
      next.set(this.buffer.subarray(this.start, this.end));
      this.buffer = next;
      this.scan -= this.start;
      this.end = active;
      this.start = 0;
    } else if (this.start > 0 && this.end + chunk.length > this.buffer.length) {
      this.buffer.copyWithin(0, this.start, this.end);
      this.scan -= this.start;
      this.end = active;
      this.start = 0;
    }
    this.buffer.set(chunk, this.end);
    this.end += chunk.length;
  }

  private consumeLine(line: Uint8Array): string | undefined {
    if (line.length === 0) {
      const data = this.data.length > 0 ? this.data.join("\n") : undefined;
      this.data = [];
      this.eventBytes = 0;
      return data;
    }
    this.eventBytes += line.length + 1;
    if (this.eventBytes > this.maxEventBytes) throw new ResponseSizeLimitError("provider sse event", this.maxEventBytes);
    if (line[0] === 0x3a) return undefined;
    const text = new TextDecoder().decode(line);
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    return undefined;
  }
}
