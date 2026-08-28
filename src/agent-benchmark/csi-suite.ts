import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CSI_CYBENCH_33 } from "./csi-cybench-33";
import { hashPath } from "./hash";
import { normalizeBenchmarkSuiteManifest } from "./manifest";
import type { BenchmarkManifest, BenchmarkSuiteManifest } from "./types";

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
  return normalizeCsiCampaignConfig(JSON.parse(await Bun.file(path).text()));
}

export async function loadCsiMaterialIndex(root: string): Promise<CsiMaterialIndex> {
  return normalizeCsiMaterialIndex(JSON.parse(await Bun.file(resolve(root, "index.json")).text()));
}

export async function generateCsiBenchmarkSuite(configInput: CsiCampaignConfig, materialRoot: string): Promise<BenchmarkSuiteManifest> {
  const config = normalizeCsiCampaignConfig(configInput);
  const root = resolve(materialRoot);
  const materials = await loadCsiMaterialIndex(root);
  const selectedIds = config.challenges ?? CSI_CYBENCH_33.challenges.map((challenge) => challenge.id);
  const selected = selectedIds.map((id) => {
    const challenge = CSI_CYBENCH_33.challenges.find((entry) => entry.id === id);
    if (!challenge) throw new Error(`unknown csi challenge: ${id}`);
    return challenge;
  });
  const runs = selected.map((challenge): BenchmarkManifest => {
    const material = materials.challenges[challenge.id];
    if (!material) throw new Error(`missing protected material for csi challenge: ${challenge.id}`);
    if (config.isolation.backend === "host" && material.requiresTarget) throw new Error(`host csi challenge requires a live target and cannot run in host smoke mode: ${challenge.id}`);
    const promptPath = protectedPath(root, material.promptFile, `${challenge.id}.promptFile`);
    if (!existsSync(promptPath) || !statSync(promptPath).isFile()) throw new Error(`missing prompt file for csi challenge: ${challenge.id}`);
    const prompt = readFileSync(promptPath, "utf8").trim();
    if (!prompt) throw new Error(`empty prompt file for csi challenge: ${challenge.id}`);
    const files = material.files?.map((file, index) => {
      const source = protectedPath(root, file.source, `${challenge.id}.files[${index}].source`);
      if (!existsSync(source)) throw new Error(`missing input for csi challenge ${challenge.id}: ${file.source}`);
      if (statSync(source).isDirectory() && !listFiles(source).length) throw new Error(`empty input directory for csi challenge ${challenge.id}: ${file.source}`);
      const digest = hashPath(source);
      if (file.sha256 && file.sha256.toLowerCase() !== digest) throw new Error(`input hash mismatch for csi challenge ${challenge.id}: ${file.source}`);
      return { source, destination: file.destination, sha256: digest };
    });
    if (material.requiredFiles?.length && !files?.length) throw new Error(`missing file staging for csi challenge: ${challenge.id}`);
    if (material.requiredFiles?.length) {
      const available = new Set(files!.flatMap((file) => listFiles(file.source).map((path) => path.split(/[\\/]/).at(-1)!)));
      const missing = material.requiredFiles.filter((name) => !available.has(name));
      if (missing.length) throw new Error(`missing required protected files for csi challenge ${challenge.id}: ${missing.join(", ")}`);
    }
    const executable = protectedPath(root, material.oracle.executable, `${challenge.id}.oracle.executable`);
    if (!existsSync(executable) || !statSync(executable).isFile()) throw new Error(`missing oracle executable for csi challenge: ${challenge.id}`);
    if ((statSync(executable).mode & 0o111) === 0) throw new Error(`oracle executable is not executable for csi challenge: ${challenge.id}`);
    const antiCheatExecutable = material.antiCheat ? protectedPath(root, material.antiCheat.executable, `${challenge.id}.antiCheat.executable`) : undefined;
    if (antiCheatExecutable && (!existsSync(antiCheatExecutable) || !statSync(antiCheatExecutable).isFile())) throw new Error(`missing anti-cheat executable for csi challenge: ${challenge.id}`);
    if (antiCheatExecutable && (statSync(antiCheatExecutable).mode & 0o111) === 0) throw new Error(`anti-cheat executable is not executable for csi challenge: ${challenge.id}`);
    if (config.isolation.backend === "docker" && !material.target) throw new Error(`docker csi challenge requires a pinned target image: ${challenge.id}`);
    if (config.isolation.backend === "docker" && !antiCheatExecutable) throw new Error(`docker csi challenge requires a protected anti-cheat executable: ${challenge.id}`);
    const timeoutMinutes = resolveTimeoutMinutes(challenge.id, challenge.timeout, material.timeout);
    return {
      schemaVersion: 1,
      suite: {
        id: CSI_CYBENCH_33.id,
        version: CSI_CYBENCH_33.version,
        source: CSI_CYBENCH_33.source,
        sourceDigest: CSI_CYBENCH_33.sourceDigest
      },
      challenge: {
        id: challenge.id,
        prompt,
        category: challenge.category,
        difficulty: challenge.difficulty,
        source: challenge.source,
        ...(material.target ? {
          targetImage: material.target.image,
          targetImageDigest: material.target.digest,
          ...(material.target.command?.length ? { targetCommand: material.target.command } : {})
        } : {})
      },
      model: config.model,
      limits: { timeoutSeconds: timeoutMinutes * 60, ...config.limits },
      isolation: config.isolation,
      ...(files?.length ? { files } : {}),
      toolScope: config.toolScope,
      oracle: {
        command: [executable, ...(material.oracle.args ?? [])],
        executableSha256: hashPath(executable),
        flagPattern: material.oracle.flagPattern,
        ...(material.oracle.flags ? { flags: material.oracle.flags } : {}),
        ...(material.oracle.timeoutSeconds ? { timeoutSeconds: material.oracle.timeoutSeconds } : {})
      },
      ...(antiCheatExecutable ? {
        antiCheat: {
          executable: antiCheatExecutable,
          executableSha256: hashPath(antiCheatExecutable),
          ...(material.antiCheat?.args ? { args: material.antiCheat.args } : {})
        }
      } : {})
    };
  });
  return normalizeBenchmarkSuiteManifest({
    schemaVersion: 1,
    id: CSI_CYBENCH_33.id,
    version: CSI_CYBENCH_33.version,
    source: CSI_CYBENCH_33.source,
    sourceDigest: CSI_CYBENCH_33.sourceDigest,
    repetitions: config.repetitions,
    concurrency: config.concurrency,
    runs
  });
}

export function writeCsiBenchmarkSuite(suite: BenchmarkSuiteManifest, path: string): void {
  const directory = dirname(resolve(path));
  if (!existsSync(directory)) throw new Error(`suite output directory does not exist: ${directory}`);
  writeFileSync(path, `${JSON.stringify(suite, null, 2)}\n`);
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

function resolveTimeoutMinutes(id: string, catalog: (typeof CSI_CYBENCH_33.challenges)[number]["timeout"], material: CsiChallengeMaterial["timeout"]): number {
  if (catalog.status === "verified") {
    if (material && material.minutes !== catalog.minutes) throw new Error(`protected timeout for ${id} conflicts with the paper: ${material.minutes}m != ${catalog.minutes}m`);
    return catalog.minutes;
  }
  if (!material) throw new Error(`timeout for ${id} is absent from the public paper; provide it with provenance in protected material index`);
  return material.minutes;
}

function protectedPath(root: string, path: string, name: string): string {
  if (isAbsolute(path)) throw new Error(`${name} must be relative to the protected material root`);
  const resolved = resolve(root, path);
  const difference = relative(root, resolved);
  if (!difference || difference.startsWith("..") || isAbsolute(difference)) throw new Error(`${name} escapes the protected material root`);
  return resolved;
}

function listFiles(rootPath: string): string[] {
  if (!statSync(rootPath).isDirectory()) return [rootPath];
  return readdirSync(rootPath).flatMap((name) => listFiles(join(rootPath, name)));
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
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

function positiveNumber(value: unknown, name: string): number {
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
