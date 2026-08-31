import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, relative, resolve } from "node:path";
import { cacheDir } from "../paths";
import { downloadKnowledgeFile } from "./http";
import { runCapturedProcess } from "../../agent-tools/backends/captured-process";
import { readBoundedFileTextSyncNoFollow } from "../../file-read";
import { ensurePrivateDirectory } from "../../agent-core/private-path";

const ZIP_MAX_BYTES = 16 * 1024 * 1024;
const XML_MAX_BYTES = 128 * 1024 * 1024;
const ZIP_LIST_MAX_BYTES = 8 * 1024 * 1024;
const ZIP_ENTRY_MAX_COUNT = 4096;
const UNZIP_TIMEOUT_MS = 60_000;

export async function fetchZippedXml(id: string, url: string, pattern: RegExp): Promise<{ xml: string; path: string }> {
  const dir = join(cacheDir(), id);
  ensurePrivateDirectory(dir, `${id} knowledge cache directory`);
  const token = randomUUID();
  const zipPath = join(dir, `.download-${token}.zip`);
  const staging = join(dir, `.extract-${token}`);
  try {
    await downloadKnowledgeFile(url, zipPath, ZIP_MAX_BYTES, `${id} zip archive`);
    const entries = await listArchiveEntries(zipPath);
    const selected = entries.find((entry) => matches(pattern, entry));
    if (!selected) throw new Error(`no xml matching ${pattern} in ${id} archive`);
    const declaredSize = await archiveEntrySize(zipPath, selected);
    if (declaredSize > XML_MAX_BYTES) throw new Error(`${id} xml exceeded the ${XML_MAX_BYTES}-byte expanded limit`);
    mkdirSync(staging, { recursive: true });
    const extracted = await runCapturedProcess("unzip", ["-o", "-q", zipPath, selected, "-d", staging], {
      timeoutMs: UNZIP_TIMEOUT_MS,
      maxOutputBytes: ZIP_LIST_MAX_BYTES
    });
    if (extracted.timedOut) throw new Error(`${id} archive extraction timed out`);
    if (extracted.exitCode !== 0) throw new Error(extracted.stderr.trim() || `${id} archive extraction failed`);
    const stagedPath = resolve(staging, selected);
    const stagedRelative = relative(staging, stagedPath);
    if (stagedRelative.startsWith("..") || stagedRelative.startsWith("/")) throw new Error(`${id} archive entry escaped the extraction directory`);
    const info = lstatSync(stagedPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${id} archive entry was not a regular file`);
    if (info.size > XML_MAX_BYTES || info.size !== declaredSize) throw new Error(`${id} archive entry size did not match its validated metadata`);
    const path = join(dir, `${id}.xml`);
    renameSync(stagedPath, path);
    return { xml: readBoundedXml(path), path };
  } finally {
    try { unlinkSync(zipPath); } catch {}
    rmSync(staging, { recursive: true, force: true });
  }
}

export function cachedXml(id: string, pattern: RegExp): string | undefined {
  const dir = join(cacheDir(), id);
  if (!existsSync(dir)) return undefined;
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${id} knowledge cache must be a real directory`);
  const stable = join(dir, `${id}.xml`);
  if (existsSync(stable)) return readBoundedXml(stable);
  const xmlFile = readdirSync(dir).find((entry) => matches(pattern, entry));
  return xmlFile ? readBoundedXml(join(dir, xmlFile)) : undefined;
}

async function listArchiveEntries(zipPath: string): Promise<string[]> {
  const result = await runCapturedProcess("unzip", ["-Z", "-1", zipPath], {
    timeoutMs: UNZIP_TIMEOUT_MS,
    maxOutputBytes: ZIP_LIST_MAX_BYTES
  });
  if (result.timedOut) throw new Error("zip archive listing timed out");
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "zip archive listing failed");
  if (result.stdout.includes("bytes omitted")) throw new Error("zip archive listing exceeded the output limit");
  const entries = result.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length > ZIP_ENTRY_MAX_COUNT) throw new Error(`zip archive exceeded the ${ZIP_ENTRY_MAX_COUNT}-entry limit`);
  for (const entry of entries) assertSafeArchiveEntry(entry);
  return entries;
}

async function archiveEntrySize(zipPath: string, entry: string): Promise<number> {
  const result = await runCapturedProcess("unzip", ["-l", zipPath, entry], {
    timeoutMs: UNZIP_TIMEOUT_MS,
    maxOutputBytes: ZIP_LIST_MAX_BYTES
  });
  if (result.timedOut) throw new Error("zip archive metadata inspection timed out");
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "zip archive metadata inspection failed");
  const line = result.stdout.split(/\r?\n/).find((candidate) => candidate.trim().endsWith(` ${entry}`));
  const size = line?.match(/^\s*(\d+)\s+/)?.[1];
  const parsed = size === undefined ? NaN : Number(size);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("zip archive entry size was unavailable");
  return parsed;
}

function assertSafeArchiveEntry(entry: string): void {
  if (!entry || entry.length > 512 || !/^[A-Za-z0-9._/-]+$/.test(entry)) throw new Error("zip archive contained an unsafe entry name");
  if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) throw new Error("zip archive contained an absolute entry path");
  const segments = entry.split("/");
  if (segments.some((segment) => segment === "..")) throw new Error("zip archive contained a traversal entry");
}

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(basename(value));
}

function readBoundedXml(path: string): string {
  return readBoundedFileTextSyncNoFollow(path, XML_MAX_BYTES, "cached xml");
}
