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

  constructor(
    private readonly manifest: BenchmarkManifest,
    private readonly workspace: string,
    private readonly runId: string,
    private readonly runner: BenchmarkProcessRunner = runProcess
  ) {}

  async start(): Promise<{ backend: ToolExecutionBackend; state: BenchmarkDockerState; plan: BenchmarkDockerPlan }> {
    const processRunner: ProcessRunner = (command, args) => this.runner(command, args);
    const image = await new KaliContainerBackend({
      workspace: this.workspace,
      image: DEFAULT_KALI_IMAGE,
      processRunner
    }).resolveImage();
    if (!image.exists) throw new Error(`benchmark agent image is missing: ${DEFAULT_KALI_IMAGE}`);
    const agentImageId = image.id?.trim() ?? "";
    if (!/^sha256:[a-f0-9]{64}$/i.test(agentImageId)) throw new Error(`docker returned an unpinned agent image id: ${agentImageId || "empty"}`);
    const agentImageContract = image.contract?.trim() ?? "";
    if (agentImageContract !== KALI_IMAGE_CONTRACT) throw new Error(`benchmark agent image does not satisfy the current capability contract: ${agentImageContract || "missing"}`);
    const plan = buildBenchmarkDockerPlan(this.manifest, this.workspace, this.runId, agentImageId);
    this.planValue = plan;
    const state: BenchmarkDockerState = {
      network: plan.names.network,
      targetContainer: plan.names.target,
      agentContainer: plan.names.agent,
      agentImageId,
      agentImageContract,
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
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<BenchmarkDockerState | undefined> {
    const state = this.stateValue;
    const plan = this.planValue;
    if (!state || !plan || state.cleaned) return state;
    const agentState = await this.inspectState(plan.names.agent);
    const targetState = await this.inspectState(plan.names.target);
    if (agentState) state.agentState = agentState;
    if (targetState) state.targetState = targetState;
    for (const args of plan.cleanup) {
      const result = await this.runner("docker", args);
      if (result.exitCode !== 0 && result.stderr.trim()) state.errors.push(result.stderr.trim().slice(0, 500));
    }
    state.cleaned = true;
    return state;
  }

  private async requiredDocker(args: string[], operation: string): Promise<void> {
    const result = await this.runner("docker", args);
    if (result.exitCode !== 0) throw new Error(result.stderr || `failed to ${operation}`);
  }

  private async inspectState(name: string): Promise<{ running: boolean; exitCode: number } | undefined> {
    const result = await this.runner("docker", ["inspect", "--format", "{{json .State}}", name]);
    if (result.exitCode !== 0) return undefined;
    try {
      const state = JSON.parse(result.stdout) as { Running?: unknown; ExitCode?: unknown };
      if (typeof state.Running !== "boolean" || typeof state.ExitCode !== "number") return undefined;
      return { running: state.Running, exitCode: state.ExitCode };
    } catch {
      return undefined;
    }
  }
}

export function buildBenchmarkDockerPlan(manifest: BenchmarkManifest, workspace: string, runId: string, agentImageId: string): BenchmarkDockerPlan {
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
  const targetImage = pinnedImage(manifest.challenge.targetImage, manifest.challenge.targetImageDigest);
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
