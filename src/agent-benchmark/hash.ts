import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { BenchmarkManifest, BenchmarkSuiteManifest } from "./types";

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashPath(path: string): string {
  const stat = statSync(path);
  if (stat.isFile()) return sha256(readFileSync(path));
  if (!stat.isDirectory()) throw new Error(`unsupported benchmark input type: ${path}`);
  const entries = walk(path).map((entry) => `${relative(path, entry).replace(/\\/g, "/")}\0${sha256(readFileSync(entry))}`);
  return sha256(entries.join("\n"));
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

function walk(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walk(path));
    else if (stat.isFile()) out.push(path);
  }
  return out;
}
