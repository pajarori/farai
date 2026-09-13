import { readdirSync, statSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  loadCsiMaterialIndex,
  normalizeCsiCampaignConfig,
  writeCsiBenchmarkSuite,
  object,
  requiredString,
  optionalString,
  positiveNumber,
  type CsiCampaignConfig,
  type CsiChallengeMaterial
} from "./csi-suite";
import { hashPath } from "./hash";
import { normalizeBenchmarkSuiteManifest } from "./manifest";
import type { BenchmarkManifest, BenchmarkSuiteManifest } from "./types";
import { readBoundedFileText, readBoundedFileTextSync } from "../file-read";

const BENCH_CATALOG_MAX_BYTES = 8 * 1024 * 1024;
const BENCH_PROMPT_MAX_BYTES = 1024 * 1024;

export type BenchCatalogTimeout =
  | { status: "verified"; minutes: number; provenance?: string; locator?: string }
  | { status: "unresolved"; provenance?: string; locator?: string };

export type BenchCatalogChallenge = {
  id: string;
  title?: string;
  category?: string;
  difficulty?: string;
  source?: string;
  timeout?: BenchCatalogTimeout;
};

export type BenchCatalog = {
  schemaVersion: 1;
  id: string;
  version: string;
  source: string;
  sourceDigest?: string;
  challenges: BenchCatalogChallenge[];
};

export async function loadBenchCatalog(root: string): Promise<BenchCatalog> {
  return normalizeBenchCatalog(JSON.parse(await readBoundedFileText(resolve(root, "catalog.json"), BENCH_CATALOG_MAX_BYTES, "bench catalog")));
}

export async function generateBenchmarkSuite(configInput: CsiCampaignConfig, materialRoot: string): Promise<BenchmarkSuiteManifest> {
  return generateBenchmarkSuiteFromCatalog(configInput, materialRoot, await loadBenchCatalog(resolve(materialRoot)));
}

export async function generateBenchmarkSuiteFromCatalog(configInput: CsiCampaignConfig, materialRoot: string, catalog: BenchCatalog): Promise<BenchmarkSuiteManifest> {
  const config = normalizeCsiCampaignConfig(configInput);
  const root = resolve(materialRoot);
  const materials = await loadCsiMaterialIndex(root);
  const catalogById = new Map(catalog.challenges.map((challenge) => [challenge.id, challenge]));
  const selectedIds = config.challenges ?? catalog.challenges.map((challenge) => challenge.id);
  const runs = selectedIds.map((id): BenchmarkManifest => {
    const challenge = catalogById.get(id);
    if (!challenge) throw new Error(`unknown challenge for bench ${catalog.id}: ${id}`);
    const material = materials.challenges[id];
    if (!material) throw new Error(`missing protected material for challenge: ${id}`);
    return buildRun(catalog, challenge, material, config, root);
  });
  return normalizeBenchmarkSuiteManifest({
    schemaVersion: 1,
    id: catalog.id,
    version: catalog.version,
    source: catalog.source,
    ...(catalog.sourceDigest ? { sourceDigest: catalog.sourceDigest } : {}),
    repetitions: config.repetitions,
    concurrency: config.concurrency,
    runs
  });
}

export { writeCsiBenchmarkSuite as writeBenchmarkSuite };

function buildRun(catalog: BenchCatalog, challenge: BenchCatalogChallenge, material: CsiChallengeMaterial, config: CsiCampaignConfig, root: string): BenchmarkManifest {
  if (config.isolation.backend === "host" && material.requiresTarget) throw new Error(`host challenge requires a live target and cannot run in host smoke mode: ${challenge.id}`);
  const promptPath = protectedPath(root, material.promptFile, `${challenge.id}.promptFile`);
  if (!statFile(promptPath)?.isFile()) throw new Error(`missing prompt file for challenge: ${challenge.id}`);
  const prompt = readBoundedFileTextSync(promptPath, BENCH_PROMPT_MAX_BYTES, `prompt ${challenge.id}`).trim();
  if (!prompt) throw new Error(`empty prompt file for challenge: ${challenge.id}`);
  const files = material.files?.map((file, index) => {
    const source = protectedPath(root, file.source, `${challenge.id}.files[${index}].source`);
    const sourceStat = statFile(source);
    if (!sourceStat) throw new Error(`missing input for challenge ${challenge.id}: ${file.source}`);
    if (sourceStat.isDirectory() && !listFiles(source).length) throw new Error(`empty input directory for challenge ${challenge.id}: ${file.source}`);
    const digest = hashPath(source);
    if (file.sha256 && file.sha256.toLowerCase() !== digest) throw new Error(`input hash mismatch for challenge ${challenge.id}: ${file.source}`);
    return { source, destination: file.destination, sha256: digest };
  });
  if (material.requiredFiles?.length && !files?.length) throw new Error(`missing file staging for challenge: ${challenge.id}`);
  if (material.requiredFiles?.length) {
    const available = new Set(files!.flatMap((file) => listFiles(file.source).map((path) => path.split(/[\\/]/).at(-1)!)));
    const missing = material.requiredFiles.filter((name) => !available.has(name));
    if (missing.length) throw new Error(`missing required protected files for challenge ${challenge.id}: ${missing.join(", ")}`);
  }
  const executable = protectedPath(root, material.oracle.executable, `${challenge.id}.oracle.executable`);
  const executableStat = statFile(executable);
  if (!executableStat?.isFile()) throw new Error(`missing oracle executable for challenge: ${challenge.id}`);
  if ((executableStat.mode & 0o111) === 0) throw new Error(`oracle executable is not executable for challenge: ${challenge.id}`);
  const antiCheatExecutable = material.antiCheat ? protectedPath(root, material.antiCheat.executable, `${challenge.id}.antiCheat.executable`) : undefined;
  const antiCheatStat = antiCheatExecutable ? statFile(antiCheatExecutable) : undefined;
  if (antiCheatExecutable && !antiCheatStat?.isFile()) throw new Error(`missing anti-cheat executable for challenge: ${challenge.id}`);
  if (antiCheatStat && (antiCheatStat.mode & 0o111) === 0) throw new Error(`anti-cheat executable is not executable for challenge: ${challenge.id}`);
  const compose = material.targetCompose;
  if (config.isolation.backend === "docker" && !material.target && !compose) throw new Error(`docker challenge requires a pinned target image or targetCompose: ${challenge.id}`);
  if (config.isolation.backend === "docker" && !antiCheatExecutable) throw new Error(`docker challenge requires a protected anti-cheat executable: ${challenge.id}`);
  const composeFile = compose ? protectedPath(root, compose.composeFile, `${challenge.id}.targetCompose.composeFile`) : undefined;
  if (composeFile && !statFile(composeFile)?.isFile()) throw new Error(`missing compose file for challenge: ${challenge.id}`);
  const timeoutMinutes = resolveTimeoutMinutes(challenge.id, challenge.timeout, material.timeout);
  return {
    schemaVersion: 1,
    suite: {
      id: catalog.id,
      version: catalog.version,
      source: catalog.source,
      ...(catalog.sourceDigest ? { sourceDigest: catalog.sourceDigest } : {})
    },
    challenge: {
      id: challenge.id,
      prompt,
      ...(challenge.category ? { category: challenge.category } : {}),
      ...(challenge.difficulty ? { difficulty: challenge.difficulty } : {}),
      ...(challenge.source ? { source: challenge.source } : {}),
      ...(material.target ? {
        targetImage: material.target.image,
        targetImageDigest: material.target.digest,
        ...(material.target.command?.length ? { targetCommand: material.target.command } : {})
      } : {}),
      ...(compose && composeFile ? {
        targetCompose: {
          composeFile,
          service: compose.service,
          ...(compose.buildArgs ? { buildArgs: compose.buildArgs } : {})
        }
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
}

function resolveTimeoutMinutes(id: string, catalog: BenchCatalogChallenge["timeout"], material: CsiChallengeMaterial["timeout"]): number {
  if (catalog && catalog.status === "verified") {
    if (material && material.minutes !== catalog.minutes) throw new Error(`protected timeout for ${id} conflicts with the catalog: ${material.minutes}m != ${catalog.minutes}m`);
    return catalog.minutes;
  }
  if (!material) throw new Error(`timeout for ${id} is unresolved in the catalog; provide it with provenance in the protected material index`);
  return material.minutes;
}

export function normalizeBenchCatalog(value: unknown): BenchCatalog {
  const raw = object(value, "bench catalog");
  if (raw.schemaVersion !== 1 && raw.schema_version !== 1) throw new Error("bench catalog schemaVersion must be 1");
  if (!Array.isArray(raw.challenges) || raw.challenges.length === 0) throw new Error("bench catalog challenges must be a non-empty array");
  const ids = new Set<string>();
  const challenges = raw.challenges.map((entry, index) => {
    const item = object(entry, `challenges[${index}]`);
    const id = requiredString(item.id, `challenges[${index}].id`);
    if (ids.has(id)) throw new Error(`bench catalog has a duplicate challenge id: ${id}`);
    ids.add(id);
    return {
      id,
      ...(optionalString(item.title) ? { title: optionalString(item.title)! } : {}),
      ...(optionalString(item.category) ? { category: optionalString(item.category)! } : {}),
      ...(optionalString(item.difficulty) ? { difficulty: optionalString(item.difficulty)! } : {}),
      ...(optionalString(item.source) ? { source: optionalString(item.source)! } : {}),
      ...(item.timeout === undefined ? {} : { timeout: normalizeCatalogTimeout(item.timeout, id) })
    };
  });
  return {
    schemaVersion: 1,
    id: requiredString(raw.id, "id"),
    version: requiredString(raw.version, "version"),
    source: requiredString(raw.source, "source"),
    ...(optionalString(raw.sourceDigest ?? raw.source_digest) ? { sourceDigest: optionalString(raw.sourceDigest ?? raw.source_digest)! } : {}),
    challenges
  };
}

function normalizeCatalogTimeout(value: unknown, id: string): BenchCatalogTimeout {
  const raw = object(value, `challenges.${id}.timeout`);
  const status = raw.status;
  if (status === "verified") {
    return {
      status: "verified",
      minutes: positiveNumber(raw.minutes, `challenges.${id}.timeout.minutes`),
      ...(optionalString(raw.provenance) ? { provenance: optionalString(raw.provenance)! } : {}),
      ...(optionalString(raw.locator) ? { locator: optionalString(raw.locator)! } : {})
    };
  }
  if (status === "unresolved") {
    return {
      status: "unresolved",
      ...(optionalString(raw.provenance) ? { provenance: optionalString(raw.provenance)! } : {}),
      ...(optionalString(raw.locator) ? { locator: optionalString(raw.locator)! } : {})
    };
  }
  throw new Error(`challenges.${id}.timeout.status must be "verified" or "unresolved"`);
}

function protectedPath(root: string, path: string, name: string): string {
  if (isAbsolute(path)) throw new Error(`${name} must be relative to the material root`);
  const resolved = resolve(root, path);
  const difference = relative(root, resolved);
  if (!difference || difference.startsWith("..") || isAbsolute(difference)) throw new Error(`${name} escapes the material root`);
  return resolved;
}

function statFile(path: string): Stats | undefined {
  return statSync(path, { throwIfNoEntry: false });
}

function listFiles(rootPath: string): string[] {
  if (!statSync(rootPath).isDirectory()) return [rootPath];
  return readdirSync(rootPath).flatMap((name) => listFiles(join(rootPath, name)));
}

