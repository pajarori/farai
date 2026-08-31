export const DEFAULT_PROCESS_OUTPUT_MAX_BYTES = 8_000;
export const BACKGROUND_PROCESS_OUTPUT_MAX_BYTES = 256 * 1024;
export const INTERNAL_PROCESS_OUTPUT_MAX_BYTES = 1024 * 1024;

export class BoundedOutputBuffer {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private readonly head: Buffer;
  private readonly tail: Buffer;
  private headBytes = 0;
  private tailBytes = 0;
  private tailWriteOffset = 0;
  private observedBytes = 0;

  constructor(readonly maxBytes = DEFAULT_PROCESS_OUTPUT_MAX_BYTES, headFraction = 0.4) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("output buffer maxBytes must be a positive integer");
    const fraction = Number.isFinite(headFraction) ? Math.min(1, Math.max(0, headFraction)) : 0.4;
    this.headLimit = Math.floor(maxBytes * fraction);
    this.tailLimit = maxBytes - this.headLimit;
    this.head = Buffer.allocUnsafe(this.headLimit);
    this.tail = Buffer.allocUnsafe(this.tailLimit);
  }

  push(chunk: string | Uint8Array): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    if (bytes.length === 0) return;
    this.observedBytes = Math.min(Number.MAX_SAFE_INTEGER, this.observedBytes + bytes.length);
    const headRemaining = this.headLimit - this.headBytes;
    const headLength = Math.min(headRemaining, bytes.length);
    if (headLength > 0) {
      bytes.copy(this.head, this.headBytes, 0, headLength);
      this.headBytes += headLength;
    }
    this.pushTail(bytes.subarray(headLength));
  }

  text(): string {
    if (this.observedBytes === 0) return "";
    const head = this.head.subarray(0, this.headBytes);
    const tail = this.tailTextBytes();
    const omitted = this.omittedBytes();
    if (omitted === 0) return Buffer.concat([head, tail], this.headBytes + this.tailBytes).toString("utf8");
    const marker = Buffer.from(`\n[... ${omitted} bytes omitted ...]\n`, "utf8");
    return Buffer.concat([head, marker, tail], this.headBytes + marker.length + this.tailBytes).toString("utf8");
  }

  takeText(): string {
    const text = this.text();
    this.clear();
    return text;
  }

  retainedBytes(): number {
    return this.headBytes + this.tailBytes;
  }

  totalBytes(): number {
    return this.observedBytes;
  }

  omittedBytes(): number {
    return Math.max(0, this.observedBytes - this.retainedBytes());
  }

  clear(): void {
    this.headBytes = 0;
    this.tailBytes = 0;
    this.tailWriteOffset = 0;
    this.observedBytes = 0;
  }

  private pushTail(bytes: Uint8Array): void {
    if (bytes.length === 0 || this.tailLimit === 0) return;
    if (bytes.length >= this.tailLimit) {
      Buffer.from(bytes).copy(this.tail, 0, bytes.length - this.tailLimit);
      this.tailBytes = this.tailLimit;
      this.tailWriteOffset = 0;
      return;
    }
    const source = Buffer.from(bytes);
    const firstLength = Math.min(source.length, this.tailLimit - this.tailWriteOffset);
    source.copy(this.tail, this.tailWriteOffset, 0, firstLength);
    if (firstLength < source.length) source.copy(this.tail, 0, firstLength);
    this.tailWriteOffset = (this.tailWriteOffset + source.length) % this.tailLimit;
    this.tailBytes = Math.min(this.tailLimit, this.tailBytes + source.length);
  }

  private tailTextBytes(): Buffer {
    if (this.tailBytes === 0) return Buffer.alloc(0);
    if (this.tailBytes < this.tailLimit) return this.tail.subarray(0, this.tailBytes);
    if (this.tailWriteOffset === 0) return this.tail.subarray(0, this.tailBytes);
    return Buffer.concat([
      this.tail.subarray(this.tailWriteOffset),
      this.tail.subarray(0, this.tailWriteOffset)
    ], this.tailBytes);
  }
}

export async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes = DEFAULT_PROCESS_OUTPUT_MAX_BYTES
): Promise<string> {
  if (!stream) return "";
  const output = new BoundedOutputBuffer(maxBytes);
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      output.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return output.text();
}
