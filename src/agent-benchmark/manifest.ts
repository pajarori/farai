import { isAbsolute, normalize } from "node:path";
import type { BenchmarkManifest, BenchmarkSuiteManifest } from "./types";
import { readBoundedFileText } from "../file-read";

const BENCHMARK_MANIFEST_MAX_BYTES = 32 * 1024 * 1024;

export async function loadBenchmarkManifest(path: string): Promise<BenchmarkManifest> {
  return normalizeBenchmarkManifest(JSON.parse(await readBoundedFileText(path, BENCHMARK_MANIFEST_MAX_BYTES, "benchmark manifest")));
}

export async function loadBenchmarkSuiteManifest(path: string): Promise<BenchmarkSuiteManifest> {
  return normalizeBenchmarkSuiteManifest(JSON.parse(await readBoundedFileText(path, BENCHMARK_MANIFEST_MAX_BYTES, "benchmark suite manifest")));
}

export function normalizeBenchmarkManifest(value: unknown): BenchmarkManifest {
  const raw = object(value, "benchmark manifest");
  if (raw.schemaVersion !== 1 && raw.schema_version !== 1) throw new Error("benchmark schemaVersion must be 1");
  const suite = object(raw.suite, "suite");
  const challenge = object(raw.challenge, "challenge");
  const model = object(raw.model, "model");
  const limits = object(raw.limits, "limits");
  const isolation = object(raw.isolation, "isolation");
  const resources = isolation.resources === undefined ? undefined : object(isolation.resources, "isolation.resources");
  const files = normalizeFiles(raw.files);
  const toolScope = stringArray(raw.toolScope ?? raw.tool_scope, "toolScope");
  const oracle = normalizeOracle(raw.oracle);
  const antiCheat = normalizeAntiCheat(raw.antiCheat ?? raw.anti_cheat);
  const temperature = optionalFiniteNumber(model.temperature, "model.temperature", 0);
  const seed = optionalInteger(model.seed, "model.seed", 0);
  const backend = enumValue(isolation.backend, ["host", "docker"] as const, "isolation.backend");
  const network = enumValue(isolation.network, ["host", "none", "target_only"] as const, "isolation.network");
  const internet = enumValue(isolation.internet, ["enabled", "disabled"] as const, "isolation.internet");
  if (backend === "host" && (network !== "host" || internet !== "enabled")) throw new Error("host benchmark backend only supports network=host and internet=enabled");
  for (const key of ["projectInstructions", "mcp", "knowledge", "skills", "hooks"] as const) {
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    if ((isolation[key] ?? isolation[snake]) !== false) throw new Error(`isolation.${key} must be false`);
  }
  return {
    schemaVersion: 1,
    suite: {
      id: requiredString(suite.id, "suite.id"),
      version: requiredString(suite.version, "suite.version"),
      source: requiredString(suite.source, "suite.source"),
      ...(optionalString(suite.sourceDigest ?? suite.source_digest) ? { sourceDigest: optionalString(suite.sourceDigest ?? suite.source_digest)! } : {})
    },
    challenge: {
      id: requiredString(challenge.id, "challenge.id"),
      prompt: requiredString(challenge.prompt, "challenge.prompt"),
      ...(optionalString(challenge.category) ? { category: optionalString(challenge.category)! } : {}),
      ...(optionalString(challenge.difficulty) ? { difficulty: optionalString(challenge.difficulty)! } : {}),
      ...(optionalString(challenge.source) ? { source: optionalString(challenge.source)! } : {}),
      ...(optionalString(challenge.targetImage ?? challenge.target_image) ? { targetImage: optionalString(challenge.targetImage ?? challenge.target_image)! } : {}),
      ...(optionalString(challenge.targetImageDigest ?? challenge.target_image_digest) ? { targetImageDigest: optionalString(challenge.targetImageDigest ?? challenge.target_image_digest)! } : {}),
      ...(challenge.targetCommand ?? challenge.target_command ? { targetCommand: stringArray(challenge.targetCommand ?? challenge.target_command, "challenge.targetCommand") } : {})
    },
    model: {
      selection: requiredString(model.selection, "model.selection"),
      ...(optionalString(model.provider) ? { provider: optionalString(model.provider)! } : {}),
      ...(optionalString(model.protocol) ? { protocol: optionalString(model.protocol)! } : {}),
      ...(optionalPositiveNumber(model.contextWindow ?? model.context_window, "model.contextWindow") ? { contextWindow: optionalPositiveNumber(model.contextWindow ?? model.context_window, "model.contextWindow")! } : {}),
      ...(optionalPositiveNumber(model.maxOutputTokens ?? model.max_output_tokens, "model.maxOutputTokens") ? { maxOutputTokens: Math.floor(optionalPositiveNumber(model.maxOutputTokens ?? model.max_output_tokens, "model.maxOutputTokens")!) } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(seed !== undefined ? { seed } : {})
    },
    limits: {
      timeoutSeconds: positiveNumber(limits.timeoutSeconds ?? limits.timeout_seconds, "limits.timeoutSeconds"),
      maxSteps: positiveInteger(limits.maxSteps ?? limits.max_steps, "limits.maxSteps"),
      ...optionalLimit(limits, "maxCostUsd", "max_cost_usd", false),
      ...optionalLimit(limits, "maxModelRequests", "max_model_requests", true),
      ...optionalLimit(limits, "maxToolCalls", "max_tool_calls", true),
      ...optionalLimit(limits, "maxSubagents", "max_subagents", true, true),
      ...optionalLimit(limits, "maxConcurrentSubagents", "max_concurrent_subagents", true),
      ...optionalLimit(limits, "maxTokens", "max_tokens", true)
    },
    isolation: {
      backend,
      network,
      internet,
      projectInstructions: false,
      mcp: false,
      knowledge: false,
      skills: false,
      hooks: false,
      ...(resources ? { resources: normalizeResources(resources) } : {})
    },
    ...(files?.length ? { files } : {}),
    toolScope,
    ...(oracle ? { oracle } : {}),
    ...(antiCheat ? { antiCheat } : {})
  };
}

export function normalizeBenchmarkSuiteManifest(value: unknown): BenchmarkSuiteManifest {
  const raw = object(value, "benchmark suite manifest");
  if (raw.schemaVersion !== 1 && raw.schema_version !== 1) throw new Error("benchmark suite schemaVersion must be 1");
  if (!Array.isArray(raw.runs) || raw.runs.length === 0) throw new Error("benchmark suite runs must be a non-empty array");
  const id = requiredString(raw.id, "id");
  const version = requiredString(raw.version, "version");
  const source = requiredString(raw.source, "source");
  const sourceDigest = optionalString(raw.sourceDigest ?? raw.source_digest);
  const repetitions = positiveInteger(raw.repetitions, "repetitions");
  const concurrency = positiveInteger(raw.concurrency, "concurrency");
  const runs = raw.runs.map((entry, index) => {
    const normalized = normalizeBenchmarkManifest(entry);
    if (normalized.suite.id !== id || normalized.suite.version !== version || normalized.suite.source !== source || normalized.suite.sourceDigest !== sourceDigest) {
      throw new Error(`runs[${index}].suite must exactly match the enclosing suite`);
    }
    return normalized;
  });
  const ids = new Set<string>();
  for (const run of runs) {
    if (ids.has(run.challenge.id)) throw new Error(`duplicate challenge id: ${run.challenge.id}`);
    ids.add(run.challenge.id);
  }
  return { schemaVersion: 1, id, version, source, ...(sourceDigest ? { sourceDigest } : {}), repetitions, concurrency, runs };
}

function normalizeFiles(value: unknown): BenchmarkManifest["files"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("files must be an array");
  return value.map((entry, index) => {
    const file = object(entry, `files[${index}]`);
    return {
      source: requiredString(file.source, `files[${index}].source`),
      destination: safeRelativePath(requiredString(file.destination, `files[${index}].destination`)),
      sha256: requiredSha256(file.sha256, `files[${index}].sha256`)
    };
  });
}

function normalizeOracle(value: unknown): BenchmarkManifest["oracle"] {
  if (value === undefined) return undefined;
  const raw = object(value, "oracle");
  const command = stringArray(raw.command, "oracle.command");
  const env = raw.env === undefined ? undefined : object(raw.env, "oracle.env");
  if (env && Object.values(env).some((item) => typeof item !== "string")) throw new Error("oracle.env values must be strings");
  return {
    command,
    ...(optionalSha256(raw.executableSha256 ?? raw.executable_sha256, "oracle.executableSha256") ? { executableSha256: optionalSha256(raw.executableSha256 ?? raw.executable_sha256, "oracle.executableSha256")! } : {}),
    flagPattern: requiredString(raw.flagPattern ?? raw.flag_pattern, "oracle.flagPattern"),
    ...(optionalString(raw.flags) ? { flags: optionalString(raw.flags)! } : {}),
    ...(optionalPositiveNumber(raw.timeoutSeconds ?? raw.timeout_seconds, "oracle.timeoutSeconds") ? { timeoutSeconds: optionalPositiveNumber(raw.timeoutSeconds ?? raw.timeout_seconds, "oracle.timeoutSeconds")! } : {}),
    ...(env ? { env: env as Record<string, string> } : {})
  };
}

function normalizeAntiCheat(value: unknown): BenchmarkManifest["antiCheat"] {
  if (value === undefined) return undefined;
  const raw = object(value, "antiCheat");
  return {
    executable: requiredString(raw.executable, "antiCheat.executable"),
    executableSha256: requiredSha256(raw.executableSha256 ?? raw.executable_sha256, "antiCheat.executableSha256"),
    ...(raw.args === undefined ? {} : { args: stringArrayAllowEmpty(raw.args, "antiCheat.args") })
  };
}

function normalizeResources(raw: Record<string, unknown>): NonNullable<BenchmarkManifest["isolation"]["resources"]> {
  const resources = {
    ...optionalResource(raw, "cpus", false),
    ...optionalResource(raw, "memoryMb", true, "memory_mb"),
    ...optionalResource(raw, "diskMb", true, "disk_mb"),
    ...optionalResource(raw, "pids", true)
  };
  if (Object.keys(resources).length === 0) throw new Error("isolation.resources must define at least one resource limit");
  return resources;
}

function optionalLimit(raw: Record<string, unknown>, camel: string, snake: string, integer: boolean, allowZero = false): Record<string, number> {
  const value = raw[camel] ?? raw[snake];
  if (value === undefined) return {};
  const normalized = allowZero ? nonNegativeNumber(value, `limits.${camel}`) : positiveNumber(value, `limits.${camel}`);
  if (integer && !Number.isInteger(normalized)) throw new Error(`limits.${camel} must be an integer`);
  return { [camel]: normalized };
}

function optionalResource(raw: Record<string, unknown>, key: string, integer: boolean, snake = key): Record<string, number> {
  const value = raw[key] ?? raw[snake];
  if (value === undefined) return {};
  const normalized = positiveNumber(value, `isolation.resources.${key}`);
  if (integer && !Number.isInteger(normalized)) throw new Error(`isolation.resources.${key} must be an integer`);
  return { [key]: normalized };
}

function safeRelativePath(value: string): string {
  if (isAbsolute(value)) throw new Error(`benchmark destination must be relative: ${value}`);
  const normalized = normalize(value).replace(/\\/g, "/");
  if (!normalized || normalized === "." || normalized.split("/").includes("..")) throw new Error(`invalid benchmark destination: ${value}`);
  return normalized;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${name} must be a non-empty string array`);
  return [...new Set(value.map((item) => String(item).trim()))];
}

function stringArrayAllowEmpty(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${name} must be a string array`);
  return value.map(String);
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  return value as T[number];
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalSha256(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredString(value, name).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${name} must be a sha256 digest`);
  return normalized;
}

function requiredSha256(value: unknown, name: string): string {
  return optionalSha256(value, name) ?? requiredString(undefined, name);
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function nonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const number = positiveNumber(value, name);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`);
  return number;
}

function optionalPositiveNumber(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : positiveNumber(value, name);
}

function optionalFiniteNumber(value: unknown, name: string, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new Error(`${name} must be a finite number >= ${minimum}`);
  return value;
}

function optionalInteger(value: unknown, name: string, minimum: number): number | undefined {
  const number = optionalFiniteNumber(value, name, minimum);
  if (number !== undefined && !Number.isInteger(number)) throw new Error(`${name} must be an integer`);
  return number;
}
