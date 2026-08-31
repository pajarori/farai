import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BenchmarkManifest, BenchmarkSuiteManifest } from "./types";

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashPath(path: string): string {
  const stat = lstatSync(path);
  if (stat.isFile()) return hashFile(path);
  if (!stat.isDirectory()) throw new Error(`unsupported benchmark input type: ${path}`);
  const hash = createHash("sha256");
  hash.update("farai-directory-v2\0");
  hashDirectory(path, Buffer.alloc(0), hash);
  return hash.digest("hex");
}

export function hashFile(path: string): string {
  return hashFileDetails(path).digest;
}

function hashFileDetails(path: string): { digest: string; mode: number; size: number } {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`unsupported benchmark input type: ${path}`);
    const hash = createHash("sha256");
    let remaining = before.size;
    while (remaining > 0) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, remaining));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) throw new Error(`benchmark input changed while hashing: ${path}`);
      hash.update(chunk.subarray(0, count));
      remaining -= count;
    }
    const after = fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(`benchmark input changed while hashing: ${path}`);
    }
    return { digest: hash.digest("hex"), mode: before.mode & 0o777, size: before.size };
  } finally {
    closeSync(descriptor);
  }
}

export function canonicalBenchmarkManifest(manifest: BenchmarkManifest): unknown {
  return {
    ...manifest,
    ...(manifest.files ? {
      files: manifest.files.map((file) => ({
        ...file,
        source: `<input:${file.sha256}>`
      }))
    } : {}),
    ...(manifest.oracle ? {
      oracle: {
        ...manifest.oracle,
        command: manifest.oracle.command.map((value, index) => index === 0 && manifest.oracle?.executableSha256
          ? `<oracle:${manifest.oracle.executableSha256}>`
          : `<arg:${sha256(value)}>`),
        ...(manifest.oracle.env ? {
          env: Object.fromEntries(Object.entries(manifest.oracle.env).map(([key, value]) => [key, `<secret:${sha256(value)}>`]))
        } : {})
      }
    } : {}),
    ...(manifest.antiCheat ? {
      antiCheat: {
        ...manifest.antiCheat,
        executable: `<anti-cheat:${manifest.antiCheat.executableSha256}>`,
        ...(manifest.antiCheat.args ? { args: manifest.antiCheat.args.map((value) => `<arg:${sha256(value)}>`)} : {})
      }
    } : {}),
    challenge: {
      ...manifest.challenge,
      ...(manifest.challenge.targetCommand ? { targetCommand: manifest.challenge.targetCommand.map((value) => `<arg:${sha256(value)}>`)} : {})
    }
  };
}

export function benchmarkManifestHash(manifest: BenchmarkManifest): string {
  return sha256(stableStringify(canonicalBenchmarkManifest(manifest)));
}

export function benchmarkSuiteHash(suite: BenchmarkSuiteManifest): string {
  return sha256(stableStringify({ ...suite, runs: suite.runs.map(canonicalBenchmarkManifest) }));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
}

function hashDirectory(path: string, localPath: Buffer, hash: ReturnType<typeof createHash>): void {
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`unsupported benchmark input type: ${path}`);
  hash.update("directory\0");
  hash.update(localPath);
  hash.update(`\0${before.mode & 0o777}\0`);
  const names = readdirSync(path, { encoding: "buffer" }).map((name) => Buffer.from(name)).sort(Buffer.compare);
  for (const encodedName of names) {
    const name = encodedName.toString("utf8");
    if (!Buffer.from(name, "utf8").equals(encodedName)) throw new Error(`benchmark input path is not valid utf-8: ${path}`);
    const childPath = join(path, name);
    const childLocalPath = localPath.length === 0 ? encodedName : Buffer.concat([localPath, Buffer.from("/"), encodedName]);
    const stat = lstatSync(childPath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      hashDirectory(childPath, childLocalPath, hash);
      continue;
    }
    if (!stat.isFile()) throw new Error(`unsupported benchmark input type: ${childPath}`);
    const file = hashFileDetails(childPath);
    hash.update("file\0");
    hash.update(childLocalPath);
    hash.update(`\0${file.mode}\0${file.size}\0${file.digest}\0`);
  }
  const after = lstatSync(path);
  if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new Error(`benchmark input changed while hashing: ${path}`);
  }
}
