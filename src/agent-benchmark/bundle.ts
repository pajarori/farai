import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchmarkBundle, BenchmarkManifest, BenchmarkResult } from "./types";
import { canonicalBenchmarkManifest } from "./hash";

export function writeBenchmarkBundle(bundle: BenchmarkBundle, directory: string): string {
  mkdirSync(directory, { recursive: true });
  const files = new Map<string, string>([
    ["manifest.json", json(redactManifest(bundle.manifest))],
    ["result.json", json(bundle.result)],
    ["environment.json", json(bundle.result.frozen)],
    ["sessions.jsonl", jsonl(bundle.sessions)],
    ["turns.jsonl", jsonl(bundle.turns)],
    ["messages.jsonl", jsonl(bundle.messages)],
    ["events.jsonl", jsonl(bundle.events)],
    ["tool-calls.jsonl", jsonl(bundle.toolCalls)],
    ["jobs.jsonl", jsonl(bundle.jobs)],
    ["usage.jsonl", jsonl(bundle.usage)],
    ["compactions.jsonl", jsonl(bundle.compactions)],
    ["evidence.jsonl", jsonl(bundle.evidence)]
  ]);
  for (const [name, content] of files) writeFileSync(join(directory, name), content);
  const checksums = [...files.keys()]
    .sort()
    .map((name) => `${sha256(readFileSync(join(directory, name)))}  ${name}`)
    .join("\n");
  writeFileSync(join(directory, "checksums.sha256"), `${checksums}\n`);
  for (const name of [...files.keys(), "checksums.sha256"]) chmodSync(join(directory, name), 0o444);
  return directory;
}

export function writeBenchmarkResult(result: BenchmarkResult, path: string): void {
  const directory = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
  if (directory) mkdirSync(directory, { recursive: true });
  writeFileSync(path, json(result));
}

function redactManifest(manifest: BenchmarkManifest): unknown {
  return canonicalBenchmarkManifest(manifest);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonl(values: unknown[]): string {
  return values.length ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "";
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
