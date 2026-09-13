import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CSI_CYBENCH_33 } from "./csi-cybench-33";
import { generateBenchmarkSuiteFromCatalog, type BenchCatalog } from "./bench-suite";
import { normalizeComposeSpec } from "./manifest";
import type { BenchmarkManifest, BenchmarkSuiteManifest } from "./types";
import { readBoundedFileText } from "../file-read";
import { atomicWriteFile } from "../agent-core/atomic-file";

const CSI_CAMPAIGN_MAX_BYTES = 4 * 1024 * 1024;
const CSI_MATERIAL_INDEX_MAX_BYTES = 16 * 1024 * 1024;

export type CsiCampaignConfig = {
  schemaVersion: 1;
  repetitions: number;
  concurrency: number;
  challenges?: string[];
  model: BenchmarkManifest["model"];
  limits: Omit<BenchmarkManifest["limits"], "timeoutSeconds">;
  isolation: BenchmarkManifest["isolation"];
  toolScope: string[];
};

export type CsiMaterialIndex = {
  schemaVersion: 1;
  challenges: Record<string, CsiChallengeMaterial>;
};

export type CsiChallengeMaterial = {
  promptFile: string;
  requiredFiles?: string[];
  requiresTarget?: boolean;
  files?: Array<{ source: string; destination: string; sha256?: string }>;
  target?: { image: string; digest: string; command?: string[] };
  targetCompose?: { composeFile: string; service: string; buildArgs?: Record<string, string> };
  timeout?: { minutes: number; provenance: string };
  oracle: {
    executable: string;
    args?: string[];
    flagPattern: string;
    flags?: string;
    timeoutSeconds?: number;
  };
  antiCheat?: { executable: string; args?: string[] };
};

export async function loadCsiCampaignConfig(path: string): Promise<CsiCampaignConfig> {
  return normalizeCsiCampaignConfig(JSON.parse(await readBoundedFileText(path, CSI_CAMPAIGN_MAX_BYTES, "csi campaign config")));
}

export async function loadCsiMaterialIndex(root: string): Promise<CsiMaterialIndex> {
  return normalizeCsiMaterialIndex(JSON.parse(await readBoundedFileText(resolve(root, "index.json"), CSI_MATERIAL_INDEX_MAX_BYTES, "csi material index")));
}

export async function generateCsiBenchmarkSuite(configInput: CsiCampaignConfig, materialRoot: string): Promise<BenchmarkSuiteManifest> {
  return generateBenchmarkSuiteFromCatalog(configInput, materialRoot, csiCatalog());
}

function csiCatalog(): BenchCatalog {
  return {
    schemaVersion: 1,
    id: CSI_CYBENCH_33.id,
    version: CSI_CYBENCH_33.version,
    source: CSI_CYBENCH_33.source,
    sourceDigest: CSI_CYBENCH_33.sourceDigest,
    challenges: CSI_CYBENCH_33.challenges.map((challenge) => ({
      id: challenge.id,
      title: challenge.title,
      category: challenge.category,
      difficulty: challenge.difficulty,
      source: challenge.source,
      timeout: challenge.timeout
    }))
  };
}

export function writeCsiBenchmarkSuite(suite: BenchmarkSuiteManifest, path: string): void {
  const directory = dirname(resolve(path));
  if (!existsSync(directory)) throw new Error(`suite output directory does not exist: ${directory}`);
  atomicWriteFile(path, `${JSON.stringify(suite, null, 2)}\n`, 0o600);
}

export function normalizeCsiCampaignConfig(value: unknown): CsiCampaignConfig {
  const raw = object(value, "csi campaign config");
  if (raw.schemaVersion !== 1 && raw.schema_version !== 1) throw new Error("csi campaign schemaVersion must be 1");
  const repetitions = positiveInteger(raw.repetitions, "repetitions");
  const concurrency = positiveInteger(raw.concurrency, "concurrency");
  const challenges = raw.challenges === undefined ? undefined : uniqueStrings(raw.challenges, "challenges");
  const model = object(raw.model, "model") as CsiCampaignConfig["model"];
  const limits = object(raw.limits, "limits") as CsiCampaignConfig["limits"];
  if ("timeoutSeconds" in limits || "timeout_seconds" in limits) throw new Error("csi timeout is fixed by the paper catalog or protected material index");
  const isolation = object(raw.isolation, "isolation") as CsiCampaignConfig["isolation"];
  const toolScope = uniqueStrings(raw.toolScope ?? raw.tool_scope, "toolScope");
  return { schemaVersion: 1, repetitions, concurrency, ...(challenges ? { challenges } : {}), model, limits, isolation, toolScope };
}

export function normalizeCsiMaterialIndex(value: unknown): CsiMaterialIndex {
  const raw = object(value, "csi material index");
  if (raw.schemaVersion !== 1 && raw.schema_version !== 1) throw new Error("csi material schemaVersion must be 1");
  const entries = object(raw.challenges, "challenges");
  const challenges: Record<string, CsiChallengeMaterial> = {};
  for (const [id, value] of Object.entries(entries)) {
    const item = object(value, `challenges.${id}`);
    const oracle = object(item.oracle, `challenges.${id}.oracle`);
    const files = item.files === undefined ? undefined : normalizeMaterialFiles(item.files, id);
    const requiredFiles = item.requiredFiles ?? item.required_files;
    const requiresTarget = item.requiresTarget ?? item.requires_target;
    const target = item.target === undefined ? undefined : object(item.target, `challenges.${id}.target`);
    const targetComposeRaw = item.targetCompose ?? item.target_compose;
    const targetCompose = targetComposeRaw === undefined ? undefined : object(targetComposeRaw, `challenges.${id}.targetCompose`);
    if (target && targetCompose) throw new Error(`challenges.${id} cannot set both target and targetCompose`);
    const timeout = item.timeout === undefined ? undefined : object(item.timeout, `challenges.${id}.timeout`);
    const antiCheat = item.antiCheat ?? item.anti_cheat;
    const antiCheatObject = antiCheat === undefined ? undefined : object(antiCheat, `challenges.${id}.antiCheat`);
    challenges[id] = {
      promptFile: requiredString(item.promptFile ?? item.prompt_file, `challenges.${id}.promptFile`),
      ...(requiredFiles === undefined ? {} : { requiredFiles: uniqueStrings(requiredFiles, `challenges.${id}.requiredFiles`) }),
      ...(requiresTarget === undefined ? {} : { requiresTarget: booleanValue(requiresTarget, `challenges.${id}.requiresTarget`) }),
      ...(files?.length ? { files } : {}),
      ...(target ? { target: {
        image: requiredString(target.image, `challenges.${id}.target.image`),
        digest: requiredDigest(target.digest, `challenges.${id}.target.digest`),
        ...(target.command === undefined ? {} : { command: stringArray(target.command, `challenges.${id}.target.command`, false) })
      } } : {}),
      ...(targetCompose ? { targetCompose: normalizeComposeSpec(targetCompose, `challenges.${id}.targetCompose`) } : {}),
      ...(timeout ? { timeout: { minutes: positiveNumber(timeout.minutes, `challenges.${id}.timeout.minutes`), provenance: requiredString(timeout.provenance, `challenges.${id}.timeout.provenance`) } } : {}),
      oracle: {
        executable: requiredString(oracle.executable, `challenges.${id}.oracle.executable`),
        ...(oracle.args === undefined ? {} : { args: stringArray(oracle.args, `challenges.${id}.oracle.args`, true) }),
        flagPattern: requiredString(oracle.flagPattern ?? oracle.flag_pattern, `challenges.${id}.oracle.flagPattern`),
        ...(optionalString(oracle.flags) ? { flags: optionalString(oracle.flags)! } : {}),
        ...(oracle.timeoutSeconds ?? oracle.timeout_seconds ? { timeoutSeconds: positiveNumber(oracle.timeoutSeconds ?? oracle.timeout_seconds, `challenges.${id}.oracle.timeoutSeconds`) } : {})
      },
      ...(antiCheatObject ? { antiCheat: {
        executable: requiredString(antiCheatObject.executable, `challenges.${id}.antiCheat.executable`),
        ...(antiCheatObject.args === undefined ? {} : { args: stringArray(antiCheatObject.args, `challenges.${id}.antiCheat.args`, true) })
      } } : {})
    };
  }
  return { schemaVersion: 1, challenges };
}

function normalizeMaterialFiles(value: unknown, id: string): NonNullable<CsiChallengeMaterial["files"]> {
  if (!Array.isArray(value)) throw new Error(`challenges.${id}.files must be an array`);
  return value.map((entry, index) => {
    const file = object(entry, `challenges.${id}.files[${index}]`);
    return {
      source: requiredString(file.source, `challenges.${id}.files[${index}].source`),
      destination: requiredString(file.destination, `challenges.${id}.files[${index}].destination`),
      ...(file.sha256 === undefined ? {} : { sha256: requiredDigest(file.sha256, `challenges.${id}.files[${index}].sha256`) })
    };
  });
}

export function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, name: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== "string")) throw new Error(`${name} must be a string array`);
  return value.map(String);
}

function uniqueStrings(value: unknown, name: string): string[] {
  const values = stringArray(value, name, false).map((item) => item.trim());
  if (values.some((item) => !item)) throw new Error(`${name} must not contain empty strings`);
  if (new Set(values).size !== values.length) throw new Error(`${name} must not contain duplicates`);
  return values;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

export function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const number = positiveNumber(value, name);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`);
  return number;
}

function requiredDigest(value: unknown, name: string): string {
  const digest = requiredString(value, name).toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest) && !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${name} must be a sha256 digest`);
  return digest;
}
