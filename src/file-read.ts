import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

const READ_CHUNK_BYTES = 64 * 1024;

export type FileLineReadOptions = {
  label?: string;
  maxBytes?: number;
  maxLineBytes?: number;
  noFollow?: boolean;
};

export class FileSizeLimitError extends Error {
  constructor(readonly label: string, readonly maxBytes: number) {
    super(`${label} exceeded the ${maxBytes}-byte file limit`);
    this.name = "FileSizeLimitError";
  }
}

export function readBoundedFileBytesSync(path: string | URL, maxBytes: number, label = "file"): Buffer {
  assertMaxBytes(maxBytes);
  const descriptor = openSync(path, "r");
  try {
    const stats = fstatSync(descriptor);
    assertRegularFile(stats.isFile(), label);
    if (stats.size > maxBytes) throw new FileSizeLimitError(label, maxBytes);
    return readDescriptorSync(descriptor, maxBytes, label).bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function readBoundedFileTextSync(path: string | URL, maxBytes: number, label = "file"): string {
  return readBoundedFileBytesSync(path, maxBytes, label).toString("utf8");
}

export function readBoundedFileBytesSyncNoFollow(path: string | URL, maxBytes: number, label = "file"): Buffer {
  assertMaxBytes(maxBytes);
  const descriptor = openReadDescriptorNoFollowSync(path, label);
  try {
    const stats = fstatSync(descriptor);
    assertRegularFile(stats.isFile(), label);
    if (stats.size > maxBytes) throw new FileSizeLimitError(label, maxBytes);
    return readDescriptorSync(descriptor, maxBytes, label).bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function readBoundedFileTextSyncNoFollow(path: string | URL, maxBytes: number, label = "file"): string {
  return readBoundedFileBytesSyncNoFollow(path, maxBytes, label).toString("utf8");
}

export function readFileTextPrefixSync(
  path: string | URL,
  maxBytes: number,
  label = "file"
): { text: string; truncated: boolean } {
  assertMaxBytes(maxBytes);
  const descriptor = openSync(path, "r");
  try {
    assertRegularFile(fstatSync(descriptor).isFile(), label);
    const result = readDescriptorSync(descriptor, maxBytes, label, true);
    return { text: decodeUtf8Prefix(result.bytes), truncated: result.truncated };
  } finally {
    closeSync(descriptor);
  }
}

export async function readBoundedFileBytes(path: string | URL, maxBytes: number, label = "file"): Promise<Buffer> {
  assertMaxBytes(maxBytes);
  const handle = await open(path, "r");
  try {
    const stats = await handle.stat();
    assertRegularFile(stats.isFile(), label);
    if (stats.size > maxBytes) throw new FileSizeLimitError(label, maxBytes);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - bytes));
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      chunks.push(buffer.subarray(0, result.bytesRead));
      bytes += result.bytesRead;
      if (bytes > maxBytes) throw new FileSizeLimitError(label, maxBytes);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    await handle.close();
  }
}

export async function readBoundedFileText(path: string | URL, maxBytes: number, label = "file"): Promise<string> {
  return (await readBoundedFileBytes(path, maxBytes, label)).toString("utf8");
}

export function readFileByteWindowSync(
  path: string | URL,
  offset: number,
  maxBytes: number,
  label = "file",
  noFollow = false
): { bytes: Buffer; totalBytes: number; from: number; to: number } {
  assertMaxBytes(maxBytes);
  const descriptor = noFollow ? openReadDescriptorNoFollowSync(path, label) : openSync(path, "r");
  try {
    const stats = fstatSync(descriptor);
    assertRegularFile(stats.isFile(), label);
    const from = Math.min(normalizeOffset(offset), stats.size);
    const length = Math.min(maxBytes, stats.size - from);
    const bytes = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const count = readSync(descriptor, bytes, filled, length - filled, from + filled);
      if (count === 0) break;
      filled += count;
    }
    return { bytes: bytes.subarray(0, filled), totalBytes: stats.size, from, to: from + filled };
  } finally {
    closeSync(descriptor);
  }
}

export function forEachFileLineSync(
  path: string | URL,
  options: FileLineReadOptions,
  consume: (line: string) => boolean | void
): void {
  const label = options.label ?? "file";
  const descriptor = options.noFollow ? openReadDescriptorNoFollowSync(path, label) : openSync(path, "r");
  try {
    const stats = fstatSync(descriptor);
    assertRegularFile(stats.isFile(), label);
    assertOptionalLimits(options);
    if (options.maxBytes !== undefined && stats.size > options.maxBytes) throw new FileSizeLimitError(label, options.maxBytes);
    const state = lineState(options.maxLineBytes, label, consume);
    let remaining = stats.size;
    while (remaining > 0 && !state.stopped) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      remaining -= count;
      pushLineText(state, state.decoder.write(buffer.subarray(0, count)));
    }
    if (!state.stopped) finishLines(state);
  } finally {
    closeSync(descriptor);
  }
}

export async function forEachFileLine(
  path: string | URL,
  options: FileLineReadOptions,
  consume: (line: string) => boolean | void | Promise<boolean | void>
): Promise<void> {
  const label = options.label ?? "file";
  const handle = options.noFollow ? await openReadHandleNoFollow(path, label) : await open(path, "r");
  try {
    const stats = await handle.stat();
    assertRegularFile(stats.isFile(), label);
    assertOptionalLimits(options);
    if (options.maxBytes !== undefined && stats.size > options.maxBytes) throw new FileSizeLimitError(label, options.maxBytes);
    const lines: string[] = [];
    const state = lineState(options.maxLineBytes, label, (line) => { lines.push(line); });
    let remaining = stats.size;
    while (remaining > 0) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      remaining -= result.bytesRead;
      pushLineText(state, state.decoder.write(buffer.subarray(0, result.bytesRead)));
      for (const line of lines.splice(0)) if (await consume(line) === false) return;
    }
    finishLines(state);
    for (const line of lines) if (await consume(line) === false) return;
  } finally {
    await handle.close();
  }
}

function readDescriptorSync(
  descriptor: number,
  maxBytes: number,
  label: string,
  truncate = false
): { bytes: Buffer; truncated: boolean } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - bytes));
    const count = readSync(descriptor, buffer, 0, buffer.length, null);
    if (count === 0) return { bytes: Buffer.concat(chunks, bytes), truncated: false };
    chunks.push(buffer.subarray(0, count));
    bytes += count;
    if (bytes <= maxBytes) continue;
    if (!truncate) throw new FileSizeLimitError(label, maxBytes);
    const combined = Buffer.concat(chunks, bytes);
    return { bytes: combined.subarray(0, maxBytes), truncated: true };
  }
}

function assertMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new Error("maxBytes must be a positive safe integer");
  }
}

function assertOptionalLimits(options: FileLineReadOptions): void {
  if (options.maxBytes !== undefined) assertMaxBytes(options.maxBytes);
  if (options.maxLineBytes !== undefined) assertMaxBytes(options.maxLineBytes);
}

function assertRegularFile(isFile: boolean, label: string): void {
  if (!isFile) throw new Error(`${label} is not a regular file`);
}

function openReadDescriptorNoFollowSync(path: string | URL, label: string): number {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  if (noFollow === 0 && lstatSync(path).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  return openSync(path, constants.O_RDONLY | noFollow);
}

async function openReadHandleNoFollow(path: string | URL, label: string): Promise<Awaited<ReturnType<typeof open>>> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  if (noFollow === 0 && lstatSync(path).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  return await open(path, constants.O_RDONLY | noFollow);
}

function normalizeOffset(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function decodeUtf8Prefix(value: Buffer): string {
  let end = value.length;
  let lead = end - 1;
  while (lead >= 0 && (value[lead]! & 0xc0) === 0x80) lead -= 1;
  if (lead >= 0) {
    const byte = value[lead]!;
    const expected = byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (expected > end - lead) end = lead;
  }
  return value.subarray(0, end).toString("utf8");
}

type LineState = {
  decoder: StringDecoder;
  pending: string;
  maxLineBytes: number | undefined;
  label: string;
  consume: (line: string) => boolean | void;
  stopped: boolean;
};

function lineState(maxLineBytes: number | undefined, label: string, consume: (line: string) => boolean | void): LineState {
  return { decoder: new StringDecoder("utf8"), pending: "", maxLineBytes, label, consume, stopped: false };
}

function pushLineText(state: LineState, value: string): void {
  state.pending += value;
  let newline: number;
  while ((newline = state.pending.indexOf("\n")) !== -1) {
    const line = state.pending.slice(0, newline).replace(/\r$/, "");
    assertLineSize(line, state);
    state.pending = state.pending.slice(newline + 1);
    if (state.consume(line) === false) {
      state.stopped = true;
      return;
    }
  }
  assertLineSize(state.pending, state);
}

function finishLines(state: LineState): void {
  pushLineText(state, state.decoder.end());
  if (state.stopped) return;
  if (!state.pending) return;
  assertLineSize(state.pending, state);
  if (state.consume(state.pending.replace(/\r$/, "")) === false) state.stopped = true;
  state.pending = "";
}

function assertLineSize(line: string, state: LineState): void {
  if (state.maxLineBytes !== undefined && Buffer.byteLength(line, "utf8") > state.maxLineBytes) {
    throw new Error(`${state.label} line exceeded the ${state.maxLineBytes}-byte limit`);
  }
}
