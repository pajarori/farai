import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_KALI_IMAGE, KALI_IMAGE_CONTRACT, KaliContainerBackend, type ContainerExecResult, type ProcessRunner } from "../agent-container/kali";
import { faraiDockerEnvironment } from "../agent-container/docker-environment";
import { runCapturedProcess } from "../agent-tools/backends/captured-process";
import { INTERNAL_PROCESS_OUTPUT_MAX_BYTES } from "../agent-tools/backends/output-buffer";
import { hashPath } from "./hash";
import type { BenchmarkManifest } from "./types";

export type BenchmarkProcessRunner = (command: string, args: string[], options?: { env?: Record<string, string> }) => Promise<ContainerExecResult>;

export type BenchmarkDockerTargetStep = { args: string[]; env?: Record<string, string> };

export type BenchmarkDockerPlan = {
  names: { network: string; target: string };
  targetImage: string;
  networkCreate: string[];
  targetStart: BenchmarkDockerTargetStep;
  composeConnect?: { network: string; project: string; composeFile: string; service: string };
  antiCheat?: { command: string; args: string[]; env: Record<string, string> };
  cleanup: string[][];
};

export type BenchmarkDockerState = {
  network: string;
  targetContainer: string;
  agentImageId: string;
  agentImageContract: string;
  targetImage: string;
  started: boolean;
  antiCheatApplied: boolean;
  cleaned: boolean;
  targetState?: { running: boolean; exitCode: number };
  errors: string[];
};

const BENCHMARK_DOCKER_COMMAND_TIMEOUT_MS = 300_000;
const BENCHMARK_TARGET_READY_TIMEOUT_MS = 120_000;
const BENCHMARK_TARGET_SETTLE_MS = 1_500;
const BENCHMARK_NETWORK_RM_ATTEMPTS = 8;
const BENCHMARK_NETWORK_RM_BACKOFF_MS = 750;

export class BenchmarkDockerLifecycle {
  private planValue: BenchmarkDockerPlan | undefined;
  private stateValue: BenchmarkDockerState | undefined;
  private startPromise: Promise<{ state: BenchmarkDockerState; plan: BenchmarkDockerPlan }> | undefined;
  private stopPromise: Promise<BenchmarkDockerState | undefined> | undefined;

  constructor(
    private readonly manifest: BenchmarkManifest,
    private readonly workspace: string,
    private readonly runId: string,
    private readonly runner: BenchmarkProcessRunner = runProcess
  ) {}

  async start(): Promise<{ state: BenchmarkDockerState; plan: BenchmarkDockerPlan }> {
    if (this.startPromise) return this.startPromise;
    const waitedForStop = Boolean(this.stopPromise);
    if (this.stopPromise) await this.stopPromise;
    if (!waitedForStop && this.stateValue?.started && !this.stateValue.cleaned && this.planValue) {
      return { state: this.stateValue, plan: this.planValue };
    }
    if (this.stateValue && !this.stateValue.cleaned) {
      const previous = await this.stopUnlocked();
      if (previous && !previous.cleaned) throw new Error("previous benchmark Docker resources could not be cleaned up");
    }
    this.startPromise = this.startUnlocked();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startUnlocked(): Promise<{ state: BenchmarkDockerState; plan: BenchmarkDockerPlan }> {
    const processRunner: ProcessRunner = (command, args) => this.runner(command, args);
    const provisioner = new KaliContainerBackend({
      workspace: this.workspace,
      image: DEFAULT_KALI_IMAGE,
      processRunner
    });
    const ensured = await provisioner.ensureImage();
    if (ensured.exitCode !== 0) throw new Error(ensured.stderr || `benchmark agent image is unavailable: ${DEFAULT_KALI_IMAGE}`);
    const image = await provisioner.resolveImage();
    if (!image.exists) throw new Error(image.error ?? `benchmark agent image is missing: ${DEFAULT_KALI_IMAGE}`);
    if (image.error) throw new Error(image.error);
    const agentImageId = image.id?.trim() ?? "";
    if (!/^sha256:[a-f0-9]{64}$/i.test(agentImageId)) throw new Error(`docker returned an unpinned agent image id: ${agentImageId || "empty"}`);
    const agentImageContract = image.contract?.trim() ?? "";
    if (agentImageContract !== KALI_IMAGE_CONTRACT) throw new Error(`benchmark agent image does not satisfy the current capability contract: ${agentImageContract || "missing"}`);
    const targetImage = this.manifest.challenge.targetCompose ? undefined : await resolveTargetImage(this.manifest, this.runner);
    const plan = buildBenchmarkDockerPlan(this.manifest, this.workspace, this.runId, agentImageId, targetImage);
    this.planValue = plan;
    const state: BenchmarkDockerState = {
      network: plan.names.network,
      targetContainer: plan.names.target,
      agentImageId,
      agentImageContract,
      targetImage: plan.targetImage,
      started: false,
      antiCheatApplied: false,
      cleaned: false,
      errors: []
    };
    this.stateValue = state;
    try {
      await this.requiredDocker(plan.networkCreate, "create benchmark network");
      await this.requiredDocker(plan.targetStart.args, "start benchmark target", plan.targetStart.env);
      if (plan.composeConnect) {
        const resolved = await this.runner("docker", ["compose", "-p", plan.composeConnect.project, "-f", plan.composeConnect.composeFile, "ps", "-q", plan.composeConnect.service]);
        const containerId = resolved.stdout.trim().split(/\s+/).filter(Boolean)[0];
        if (resolved.exitCode !== 0 || !containerId) throw new Error(resolved.stderr || `failed to resolve compose target service: ${plan.composeConnect.service}`);
        state.targetContainer = containerId;
        await this.requiredDocker(["network", "connect", "--alias", "target", plan.composeConnect.network, containerId], "connect compose target to benchmark network");
      }
      await this.waitForTargetReady(state.targetContainer);
      if (plan.antiCheat) {
        const result = await this.runner(plan.antiCheat.command, plan.antiCheat.args, { env: { ...plan.antiCheat.env, FARAI_TARGET_CONTAINER: state.targetContainer } });
        if (result.exitCode !== 0) throw new Error(result.stderr || "anti-cheat hook failed");
        state.antiCheatApplied = true;
      }
      state.started = true;
      return { state, plan };
    } catch (error) {
      state.errors.push(error instanceof Error ? error.message : String(error));
      await this.stopUnlocked();
      throw error;
    }
  }

  async connectAgent(containerName: string): Promise<void> {
    const network = this.planValue?.names.network;
    if (!network) return;
    const result = await this.runner("docker", ["network", "connect", network, containerName]);
    if (result.exitCode !== 0 && !/already exists|already in network|endpoint with name/i.test(result.stderr)) {
      throw new Error(result.stderr || `failed to connect agent to benchmark network ${network}`);
    }
  }

  async stop(): Promise<BenchmarkDockerState | undefined> {
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopUnlocked();
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = undefined;
    }
  }

  private async stopUnlocked(): Promise<BenchmarkDockerState | undefined> {
    const state = this.stateValue;
    const plan = this.planValue;
    if (!state || !plan || state.cleaned) return state;
    const targetState = await this.inspectState(state.targetContainer);
    if (targetState) state.targetState = targetState;
    let cleaned = true;
    for (const args of plan.cleanup) {
      const isNetworkRm = args[0] === "network" && args[1] === "rm";
      const attempts = isNetworkRm ? BENCHMARK_NETWORK_RM_ATTEMPTS : 1;
      let ok = false;
      let lastError = "";
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const result = await this.runner("docker", args);
          if (result.exitCode === 0 || resourceDoesNotExist(result)) {
            ok = true;
            break;
          }
          lastError = result.stderr.trim();
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        if (attempt < attempts) await sleep(BENCHMARK_NETWORK_RM_BACKOFF_MS);
      }
      if (!ok) {
        cleaned = false;
        if (lastError) state.errors.push(lastError.slice(0, 500));
      }
    }
    state.cleaned = cleaned;
    return state;
  }

  private async waitForTargetReady(container: string): Promise<void> {
    const deadline = Date.now() + BENCHMARK_TARGET_READY_TIMEOUT_MS;
    for (;;) {
      const result = await this.runner("docker", ["inspect", "--format", "{{json .State}}", container]);
      if (result.exitCode === 0) {
        try {
          const parsed = JSON.parse(result.stdout) as { Running?: boolean; Health?: { Status?: string } };
          const health = parsed.Health?.Status;
          if (health === "healthy") return;
          if (!health && parsed.Running) {
            await sleep(BENCHMARK_TARGET_SETTLE_MS);
            return;
          }
        } catch {
          return;
        }
      }
      if (Date.now() >= deadline) return;
      await sleep(500);
    }
  }

  private async requiredDocker(args: string[], operation: string, env?: Record<string, string>): Promise<void> {
    const result = await this.runner("docker", args, env ? { env } : undefined);
    if (result.exitCode !== 0) throw new Error(result.stderr || `failed to ${operation}`);
  }

  private async inspectState(name: string): Promise<{ running: boolean; exitCode: number } | undefined> {
    try {
      const result = await this.runner("docker", ["inspect", "--format", "{{json .State}}", name]);
      if (result.exitCode !== 0) return undefined;
      const state = JSON.parse(result.stdout) as { Running?: unknown; ExitCode?: unknown };
      if (typeof state.Running !== "boolean" || typeof state.ExitCode !== "number") return undefined;
      return { running: state.Running, exitCode: state.ExitCode };
    } catch {
      return undefined;
    }
  }
}

export function buildBenchmarkDockerPlan(manifest: BenchmarkManifest, workspace: string, runId: string, agentImageId: string, targetImageOverride?: string): BenchmarkDockerPlan {
  if (manifest.isolation.backend !== "docker") throw new Error("benchmark docker plan requires isolation.backend=docker");
  if (manifest.isolation.network !== "target_only" || manifest.isolation.internet !== "disabled") {
    throw new Error("docker benchmark isolation requires network=target_only and internet=disabled");
  }
  const compose = manifest.challenge.targetCompose;
  if (!compose && (!manifest.challenge.targetImage || !manifest.challenge.targetImageDigest)) throw new Error("docker benchmark requires a pinned target image or a targetCompose definition");
  if (compose && !existsSync(compose.composeFile)) throw new Error(`target compose file is missing: ${compose.composeFile}`);
  if (!manifest.antiCheat) throw new Error("docker benchmark requires an external anti-cheat hook");
  if (!existsSync(manifest.antiCheat.executable)) throw new Error("anti-cheat executable is missing");
  if (hashPath(manifest.antiCheat.executable) !== manifest.antiCheat.executableSha256) throw new Error("anti-cheat executable hash mismatch");
  if (!/^sha256:[a-f0-9]{64}$/i.test(agentImageId)) throw new Error("benchmark agent image must be pinned by image id");
  const suffix = safeName(runId).slice(-40);
  const composeProject = `farai-bench-${suffix}`;
  const names = {
    network: `farai-bench-${suffix}`,
    target: compose ? `${composeProject}-${compose.service}` : `farai-bench-target-${suffix}`
  };
  const resources = manifest.isolation.resources;
  if (resources?.diskMb) throw new Error("docker benchmark diskMb is not enforceable for a bind-mounted scratch workspace");
  const common = ["--security-opt", "no-new-privileges:true", ...(resources?.pids ? ["--pids-limit", String(resources.pids)] : [])];
  const resourceArgs = [
    ...(resources?.cpus ? ["--cpus", String(resources.cpus)] : []),
    ...(resources?.memoryMb ? ["--memory", `${resources.memoryMb}m`] : [])
  ];
  const targetImage = compose ? `compose:${compose.service}` : (targetImageOverride ?? pinnedImage(manifest.challenge.targetImage!, manifest.challenge.targetImageDigest!));
  const composeEnv = compose?.buildArgs && Object.keys(compose.buildArgs).length ? compose.buildArgs : undefined;
  const targetStart: BenchmarkDockerTargetStep = compose
    ? { args: ["compose", "-p", composeProject, "-f", compose.composeFile, "up", "-d", "--build"], ...(composeEnv ? { env: composeEnv } : {}) }
    : {
        args: [
          "run", "-d", "--name", names.target,
          "--network", names.network,
          "--network-alias", "target",
          "--cap-drop", "ALL",
          "--cap-add", "NET_BIND_SERVICE",
          ...common,
          ...resourceArgs,
          targetImage,
          ...(manifest.challenge.targetCommand ?? [])
        ]
      };
  const targetCleanup: string[][] = compose
    ? [["compose", "-p", composeProject, "-f", compose.composeFile, "down", "-v", "--remove-orphans"]]
    : [["rm", "-f", "-v", names.target]];
  return {
    names,
    targetImage,
    networkCreate: ["network", "create", "--internal", "--label", "org.farai.benchmark=true", names.network],
    targetStart,
    ...(compose ? { composeConnect: { network: names.network, project: composeProject, composeFile: compose.composeFile, service: compose.service } } : {}),
    antiCheat: {
      command: manifest.antiCheat.executable,
      args: manifest.antiCheat.args ?? [],
      env: {
        FARAI_BENCHMARK_NETWORK: names.network,
        FARAI_CHALLENGE_ID: manifest.challenge.id
      }
    },
    cleanup: [
      ...targetCleanup,
      ["network", "rm", names.network]
    ]
  };
}

async function resolveTargetImage(manifest: BenchmarkManifest, runner: BenchmarkProcessRunner): Promise<string> {
  if (!manifest.challenge.targetImage || !manifest.challenge.targetImageDigest) throw new Error("docker benchmark requires a pinned target image");
  const pinned = pinnedImage(manifest.challenge.targetImage, manifest.challenge.targetImageDigest);
  const exact = await runner("docker", ["image", "inspect", pinned]);
  if (exact.exitCode === 0) return imageIdFromInspect(exact.stdout) ?? pinned;

  const base = manifest.challenge.targetImage.split("@")[0]!;
  const tagged = await runner("docker", ["image", "inspect", base]);
  if (tagged.exitCode === 0) {
    const imageId = imageIdForDigest(tagged.stdout, pinned);
    if (imageId) return imageId;
  }

  const details = [exact.stderr, tagged.stderr]
    .map((value) => value.trim())
    .find(Boolean);
  throw new Error(`benchmark target image is unavailable locally: ${pinned}; build or load the pinned target image before running the benchmark${details ? ` (${details.slice(0, 300)})` : ""}`);
}

function imageIdForDigest(raw: string, pinned: string): string | undefined {
  try {
    const images = JSON.parse(raw) as Array<{ Id?: unknown; RepoDigests?: unknown }>;
    const image = images[0];
    if (!image || !Array.isArray(image.RepoDigests)) return undefined;
    const [repository, digest] = pinned.split("@");
    const repositoryWithoutTag = repository?.replace(/:[^/:]+$/, "");
    const matches = image.RepoDigests.some((value) => typeof value === "string" && (
      value.toLowerCase() === pinned.toLowerCase()
      || (repositoryWithoutTag && digest && value.toLowerCase() === `${repositoryWithoutTag}@${digest}`.toLowerCase())
    ));
    if (!matches || typeof image.Id !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(image.Id)) return undefined;
    return image.Id;
  } catch {
    return undefined;
  }
}

function imageIdFromInspect(raw: string): string | undefined {
  try {
    const id = (JSON.parse(raw) as Array<{ Id?: unknown }>)[0]?.Id;
    return typeof id === "string" && /^sha256:[a-f0-9]{64}$/i.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function resourceDoesNotExist(result: ContainerExecResult): boolean {
  return /no such (container|network|object)|(?:container|network)\s+[^\n]*\bnot found\b/i.test(`${result.stdout}\n${result.stderr}`);
}

function pinnedImage(image: string, digest: string): string {
  const normalizedDigest = digest.startsWith("sha256:") ? digest : `sha256:${digest}`;
  if (!/^sha256:[a-f0-9]{64}$/i.test(normalizedDigest)) throw new Error("target image digest must be sha256");
  const base = image.split("@")[0]!;
  return `${base}@${normalizedDigest}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

async function runProcess(command: string, args: string[], options: { env?: Record<string, string> } = {}): Promise<ContainerExecResult> {
  return await runCapturedProcess(command, args, {
    env: { ...faraiDockerEnvironment(), ...(options.env ?? {}) },
    timeoutMs: BENCHMARK_DOCKER_COMMAND_TIMEOUT_MS,
    maxOutputBytes: INTERNAL_PROCESS_OUTPUT_MAX_BYTES
  });
}
