import { open, unlink } from "node:fs/promises";

export class ResponseSizeLimitError extends Error {
  constructor(readonly label: string, readonly maxBytes: number) {
    super(`${label} exceeded the ${maxBytes}-byte response limit`);
    this.name = "ResponseSizeLimitError";
  }
}

export async function readBoundedResponseBytes(response: Response, maxBytes: number, label = "response"): Promise<Uint8Array> {
  const declared = contentLength(response.headers);
  if (declared !== undefined && declared > maxBytes) {
    await discardResponseBody(response);
    throw new ResponseSizeLimitError(label, maxBytes);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let completed = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        break;
      }
      if (next.value.length > maxBytes - bytes) throw new ResponseSizeLimitError(label, maxBytes);
      const chunk = Buffer.from(next.value);
      chunks.push(chunk);
      bytes += chunk.length;
    }
  } finally {
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

export async function discardResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch {}
}

export async function readBoundedResponseText(response: Response, maxBytes: number, label = "response"): Promise<string> {
  return Buffer.from(await readBoundedResponseBytes(response, maxBytes, label)).toString("utf8");
}

export async function readBoundedResponseJson(response: Response, maxBytes: number, label = "response"): Promise<unknown> {
  const text = await readBoundedResponseText(response, maxBytes, label);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid json`);
  }
}

export async function readBoundedResponsePreview(
  response: Response,
  maxBytes: number,
  marker = "[... response truncated ...]"
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  let completed = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        break;
      }
      const remaining = maxBytes - bytes;
      if (next.value.length > remaining) {
        if (remaining > 0) {
          const chunk = Buffer.from(next.value.subarray(0, remaining));
          chunks.push(chunk);
          bytes += chunk.length;
        }
        truncated = true;
        break;
      }
      const chunk = Buffer.from(next.value);
      chunks.push(chunk);
      bytes += chunk.length;
    }
  } finally {
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks, bytes).toString("utf8");
  return truncated ? `${text}\n${marker}` : text;
}

export async function writeBoundedResponseToFile(
  response: Response,
  path: string,
  maxBytes: number,
  label = "response"
): Promise<number> {
  const declared = contentLength(response.headers);
  if (declared !== undefined && declared > maxBytes) {
    try { await response.body?.cancel(); } catch {}
    throw new ResponseSizeLimitError(label, maxBytes);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label} returned an empty body`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let bytes = 0;
  let completed = false;
  try {
    file = await open(path, "wx", 0o600);
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        break;
      }
      if (next.value.length > maxBytes - bytes) throw new ResponseSizeLimitError(label, maxBytes);
      let offset = 0;
      while (offset < next.value.length) {
        const written = await file.write(next.value, offset, next.value.length - offset, bytes + offset);
        if (written.bytesWritten <= 0) throw new Error(`failed to write ${label}`);
        offset += written.bytesWritten;
      }
      bytes += next.value.length;
    }
    await file.sync();
    return bytes;
  } catch (error) {
    try { await file?.close(); } catch {}
    file = undefined;
    try { await unlink(path); } catch {}
    throw error;
  } finally {
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
    try { await file?.close(); } catch {}
  }
}

function contentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}
