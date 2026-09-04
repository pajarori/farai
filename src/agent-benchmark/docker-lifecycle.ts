import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_KALI_IMAGE, KALI_IMAGE_CONTRACT, KaliContainerBackend, type ContainerExecResult, type ProcessRunner } from "../agent-container/kali";
import { faraiDockerEnvironment } from "../agent-container/docker-environment";
import { runCapturedProcess } from "../agent-tools/backends/captured-process";
import { INTERNAL_PROCESS_OUTPUT_MAX_BYTES } from "../agent-tools/backends/output-buffer";
import type { ToolExecutionBackend } from "../agent-tools/shared/backend";
import { hashPath } from "./hash";
import type { BenchmarkManifest } from "./types";

export type BenchmarkProcessRunner = (command: string, args: string[], options?: { env?: Record<string, string> }) => Promise<ContainerExecResult>;

export type BenchmarkDockerPlan = {
  names: { network: string; target: string; agent: string };
  targetImage: string;
  networkCreate: string[];
  targetStart: string[];
  agentStart: string[];
  antiCheat?: { command: string; args: string[]; env: Record<string, string> };
  cleanup: string[][];
};

export type BenchmarkDockerState = {
  network: string;
  targetContainer: string;
  agentContainer: string;
  agentImageId: string;
  agentImageContract: string;
  targetImage: string;
  started: boolean;
  antiCheatApplied: boolean;
  cleaned: boolean;
  targetState?: { running: boolean; exitCode: number };
  agentState?: { running: boolean; exitCode: number };
  errors: string[];
};

const BENCHMARK_DOCKER_COMMAND_TIMEOUT_MS = 300_000;

export class BenchmarkDockerLifecycle {
  private planValue: BenchmarkDockerPlan | undefined;
  private stateValue: BenchmarkDockerState | undefined;
  private startPromise: Promise<{ backend: ToolExecutionBackend; state: BenchmarkDockerState; plan: BenchmarkDockerPlan }> | undefined;
  private stopPromise: Promise<BenchmarkDockerState | undefined> | undefined;

  constructor(
    private readonly manifest: BenchmarkManifest,
    private readonly workspace: string,
    private readonly runId: string,
    private readonly runner: BenchmarkProcessRunner = runProcess
  ) {}

  async start(): Promise<{ backend: ToolExecutionBackend; state: BenchmarkDockerState; plan: BenchmarkDockerPlan }> {
    if (this.startPromise) return this.startPromise;
    const waitedForStop = Boolean(this.stopPromise);
    if (this.stopPromise) await this.stopPromise;
    if (!waitedForStop && this.stateValue?.started && !this.stateValue.cleaned && this.planValue) {
      return {
        backend: new KaliContainerBackend({
          workspace: this.workspace,
          image: DEFAULT_KALI_IMAGE,
          containerName: this.planValue.names.agent,
          processRunner: (command, args) => this.runner(command, args)
        }),
        state: this.stateValue,
        plan: this.planValue
      };
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

  private async startUnlocked(): Promise<{ backend: ToolExecutionBackend; state: BenchmarkDockerState; plan: BenchmarkDockerPlan }> {
    const processRunner: ProcessRunner = (command, args) => this.runner(command, args);
    const image = await new KaliContainerBackend({
      workspace: this.workspace,
      image: DEFAULT_KALI_IMAGE,
      processRunner
    }).resolveImage();
    if (!image.exists) throw new Error(image.error ?? `benchmark agent image is missing: ${DEFAULT_KALI_IMAGE}`);
    if (image.error) throw new Error(image.error);
    const agentImageId = image.id?.trim() ?? "";
    if (!/^sha256:[a-f0-9]{64}$/i.test(agentImageId)) throw new Error(`docker returned an unpinned agent image id: ${agentImageId || "empty"}`);
    const agentImageContract = image.contract?.trim() ?? "";
    if (agentImageContract !== KALI_IMAGE_CONTRACT) throw new Error(`benchmark agent image does not satisfy the current capability contract: ${agentImageContract || "missing"}`);
    const targetImage = await resolveTargetImage(this.manifest, this.runner);
    const plan = buildBenchmarkDockerPlan(this.manifest, this.workspace, this.runId, agentImageId, targetImage);
    this.planValue = plan;
    const state: BenchmarkDockerState = {
      network: plan.names.network,
      targetContainer: plan.names.target,
      agentContainer: plan.names.agent,
      agentImageId,
      agentImageContract,
      targetImage,
      started: false,
      antiCheatApplied: false,
      cleaned: false,
      errors: []
    };
    this.stateValue = state;
    try {
      await this.requiredDocker(plan.networkCreate, "create benchmark network");
      await this.requiredDocker(plan.targetStart, "start benchmark target");
      if (plan.antiCheat) {
        const result = await this.runner(plan.antiCheat.command, plan.antiCheat.args, { env: plan.antiCheat.env });
        if (result.exitCode !== 0) throw new Error(result.stderr || "anti-cheat hook failed");
        state.antiCheatApplied = true;
      }
      await this.requiredDocker(plan.agentStart, "start benchmark agent");
      state.started = true;
      return {
        backend: new KaliContainerBackend({
          workspace: this.workspace,
          image: DEFAULT_KALI_IMAGE,
          containerName: plan.names.agent,
          processRunner
        }),
        state,
        plan
      };
    } catch (error) {
      state.errors.push(error instanceof Error ? error.message : String(error));
      await this.stopUnlocked();
      throw error;
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
    const [agentState, targetState] = await Promise.all([
      this.inspectState(plan.names.agent),
      this.inspectState(plan.names.target)
    ]);
    if (agentState) state.agentState = agentState;
    if (targetState) state.targetState = targetState;
    let cleaned = true;
    for (const args of plan.cleanup) {
      try {
        const result = await this.runner("docker", args);
        if (result.exitCode !== 0 && !resourceDoesNotExist(result)) {
          cleaned = false;
          if (result.stderr.trim()) state.errors.push(result.stderr.trim().slice(0, 500));
        }
      } catch (error) {
        cleaned = false;
        state.errors.push(error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500));
      }
    }
    state.cleaned = cleaned;
    return state;
  }

  private async requiredDocker(args: string[], operation: string): Promise<void> {
    const result = await this.runner("docker", args);
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
  if (!manifest.challenge.targetImage || !manifest.challenge.targetImageDigest) throw new Error("docker benchmark requires a pinned target image");
  if (!manifest.antiCheat) throw new Error("docker benchmark requires an external anti-cheat hook");
  if (!existsSync(manifest.antiCheat.executable)) throw new Error("anti-cheat executable is missing");
  if (hashPath(manifest.antiCheat.executable) !== manifest.antiCheat.executableSha256) throw new Error("anti-cheat executable hash mismatch");
  if (!/^sha256:[a-f0-9]{64}$/i.test(agentImageId)) throw new Error("benchmark agent image must be pinned by image id");
  const suffix = safeName(runId).slice(-40);
  const names = {
    network: `farai-bench-${suffix}`,
    target: `farai-bench-target-${suffix}`,
    agent: `farai-bench-agent-${suffix}`
  };
  const resources = manifest.isolation.resources;
  if (resources?.diskMb) throw new Error("docker benchmark diskMb is not enforceable for a bind-mounted scratch workspace");
  const common = ["--security-opt", "no-new-privileges:true", ...(resources?.pids ? ["--pids-limit", String(resources.pids)] : [])];
  const resourceArgs = [
    ...(resources?.cpus ? ["--cpus", String(resources.cpus)] : []),
    ...(resources?.memoryMb ? ["--memory", `${resources.memoryMb}m`] : [])
  ];
  const targetImage = targetImageOverride ?? pinnedImage(manifest.challenge.targetImage, manifest.challenge.targetImageDigest);
  const targetStart = [
    "run", "-d", "--name", names.target,
    "--network", names.network,
    "--network-alias", "target",
    "--cap-drop", "ALL",
    "--cap-add", "NET_BIND_SERVICE",
    ...common,
    ...resourceArgs,
    targetImage,
    ...(manifest.challenge.targetCommand ?? [])
  ];
  const resolvedWorkspace = resolve(workspace);
  const agentStart = [
    "run", "-d", "--name", names.agent,
    "--network", names.network,
    "--workdir", "/workspace",
    "--volume", `${resolvedWorkspace}:/workspace:rw`,
    "--volume", "/workspace/.farai",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
    "--tmpfs", "/root:rw,nosuid,nodev,size=256m",
    "--tmpfs", "/run:rw,nosuid,nodev,size=64m",
    "--cap-drop", "ALL",
    "--cap-add", "NET_ADMIN",
    "--cap-add", "NET_RAW",
    ...common,
    ...resourceArgs,
    agentImageId,
    "sleep", "infinity"
  ];
  return {
    names,
    targetImage,
    networkCreate: ["network", "create", "--internal", "--label", "org.farai.benchmark=true", names.network],
    targetStart,
    agentStart,
    antiCheat: {
      command: manifest.antiCheat.executable,
      args: manifest.antiCheat.args ?? [],
      env: {
        FARAI_TARGET_CONTAINER: names.target,
        FARAI_AGENT_CONTAINER: names.agent,
        FARAI_BENCHMARK_NETWORK: names.network,
        FARAI_CHALLENGE_ID: manifest.challenge.id
      }
    },
    cleanup: [
      ["rm", "-f", "-v", names.agent],
      ["rm", "-f", "-v", names.target],
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
