import { ResponseSizeLimitError } from "../../http-response";

const KIB = 1024;
const MIB = 1024 * KIB;

export const PROVIDER_ERROR_BODY_MAX_BYTES = 64 * KIB;
export const PROVIDER_DEBUG_CAPTURE_MAX_BYTES = MIB;
export const PROVIDER_TOOL_PREVIEW_MAX_BYTES = 64 * KIB;

export type ProviderResponseLimits = {
  bufferedBodyBytes: number;
  contentBytes: number;
  reasoningBytes: number;
  toolArgumentsBytes: number;
  sseEventBytes: number;
  sseStreamBytes: number;
  sseEvents: number;
  toolCalls: number;
};

export class BoundedTextAccumulator {
  private chunks: string[] = [];
  private byteLength = 0;
  private fragments = 0;

  constructor(
    readonly maxBytes: number,
    readonly label: string,
    private readonly maxFragments = 250_000
  ) {}

  append(value: string): void {
    if (!value) return;
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > this.maxBytes - this.byteLength) throw new ResponseSizeLimitError(this.label, this.maxBytes);
    this.fragments += 1;
    if (this.fragments > this.maxFragments) throw new Error(`${this.label} exceeded the ${this.maxFragments}-fragment provider response limit`);
    this.byteLength += bytes;
    this.chunks.push(value);
  }

  text(): string {
    if (this.chunks.length <= 1) return this.chunks[0] ?? "";
    const joined = this.chunks.join("");
    this.chunks = [joined];
    return joined;
  }

  bytes(): number {
    return this.byteLength;
  }

  clear(): void {
    this.chunks = [];
    this.byteLength = 0;
    this.fragments = 0;
  }
}

export class BoundedTextCapture {
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private observedBytes = 0;

  constructor(readonly maxBytes: number) {}

  append(value: string | Uint8Array): void {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
    if (bytes.length === 0) return;
    this.observedBytes = Math.min(Number.MAX_SAFE_INTEGER, this.observedBytes + bytes.length);
    const remaining = this.maxBytes - this.retainedBytes;
    if (remaining <= 0) return;
    const retained = bytes.subarray(0, remaining);
    this.chunks.push(retained);
    this.retainedBytes += retained.length;
  }

  text(): string {
    const text = Buffer.concat(this.chunks, this.retainedBytes).toString("utf8");
    const omitted = Math.max(0, this.observedBytes - this.retainedBytes);
    return omitted > 0 ? `${text}\n[... ${omitted} bytes omitted ...]` : text;
  }
}

export function providerResponseLimits(maxOutputTokens?: number): ProviderResponseLimits {
  const knownTokens = Number.isFinite(maxOutputTokens) && (maxOutputTokens ?? 0) > 0
    ? Math.floor(maxOutputTokens!)
    : undefined;
  const outputBytes = knownTokens === undefined
    ? 16 * MIB
    : clamp(knownTokens * 32, MIB, 32 * MIB);
  return {
    bufferedBodyBytes: clamp(outputBytes + MIB, 2 * MIB, 64 * MIB),
    contentBytes: outputBytes,
    reasoningBytes: outputBytes,
    toolArgumentsBytes: Math.min(outputBytes, 16 * MIB),
    sseEventBytes: clamp(outputBytes + MIB, 2 * MIB, 64 * MIB),
    sseStreamBytes: clamp(outputBytes * 4 + 4 * MIB, 8 * MIB, 128 * MIB),
    sseEvents: knownTokens === undefined ? 250_000 : clamp(knownTokens * 4, 10_000, 250_000),
    toolCalls: 256
  };
}

export function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
