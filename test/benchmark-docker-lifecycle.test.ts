import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BenchmarkDockerLifecycle, buildBenchmarkDockerPlan, type BenchmarkProcessRunner } from "../src/agent-benchmark/docker-lifecycle";
import { DEFAULT_KALI_IMAGE, KALI_IMAGE_REPO, KALI_IMAGE_CONTRACT, KALI_IMAGE_CONTRACT_LABEL } from "../src/agent-container/kali";
import { hashPath } from "../src/agent-benchmark/hash";
import type { BenchmarkManifest } from "../src/agent-benchmark/types";

const roots: string[] = [];
const digest = `sha256:${"a".repeat(64)}`;
const agentImageId = `sha256:${"b".repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; manifest: BenchmarkManifest } {
  const root = mkdtempSync(join(tmpdir(), "farai-benchmark-docker-"));
  roots.push(root);
  const antiCheat = join(root, "anti-cheat");
  writeFileSync(antiCheat, "#!/bin/sh\nexit 0\n");
  chmodSync(antiCheat, 0o700);
  return {
    root,
    manifest: {
      schemaVersion: 1,
      suite: { id: "docker-suite", version: "test", source: "fixture" },
      challenge: {
        id: "target",
        prompt: "solve target",
        targetImage: "registry.example/target:latest",
        targetImageDigest: digest,
        targetCommand: ["service", "start"]
      },
      model: { selection: "benchmark-model" },
      limits: { timeoutSeconds: 60, maxSteps: 10 },
      isolation: {
        backend: "docker",
        network: "target_only",
        internet: "disabled",
        projectInstructions: false,
        mcp: false,
        knowledge: false,
        skills: false,
        hooks: false,
        resources: { cpus: 2, memoryMb: 2048, pids: 256 }
      },
      toolScope: ["command_run"],
      antiCheat: { executable: antiCheat, executableSha256: hashPath(antiCheat) }
    }
  };
}

test("docker benchmark plan isolates target and agent without exposing protected material", () => {
  const { root, manifest } = fixture();
  const workspace = join(root, "scratch");
  const plan = buildBenchmarkDockerPlan(manifest, workspace, "run/one", agentImageId);
  expect(plan.networkCreate).toContain("--internal");
  expect(plan.targetStart.args).toContain(`registry.example/target:latest@${digest}`);
  expect(plan.targetStart.args.slice(-2)).toEqual(["service", "start"]);
  expect(plan.agentStart).toContain("--read-only");
  expect(plan.agentStart).toContain("--cap-drop");
  expect(plan.agentStart).toContain("NET_RAW");
  expect(plan.agentStart).toContain(`${workspace}:/workspace:rw`);
  expect(plan.agentStart.join(" ")).not.toContain(manifest.antiCheat!.executable);
  expect(plan.antiCheat?.env.FARAI_TARGET_CONTAINER).toBe(plan.names.target);
  expect(plan.cleanup).toEqual([
    ["rm", "-f", "-v", plan.names.agent],
    ["rm", "-f", "-v", plan.names.target],
    ["network", "rm", plan.names.network]
  ]);
});

test("docker benchmark lifecycle applies anti-cheat before agent launch and always cleans up", async () => {
  const { root, manifest } = fixture();
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: BenchmarkProcessRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === "docker" && args.join(" ") === `image inspect ${DEFAULT_KALI_IMAGE}`) return result(imageInspect(agentImageId));
    return result("");
  };
  const lifecycle = new BenchmarkDockerLifecycle(manifest, join(root, "scratch"), "run-one", runner);
  const started = await lifecycle.start();
  expect(started.state.started).toBe(true);
  expect(started.state.antiCheatApplied).toBe(true);
  const targetIndex = calls.findIndex((call) => call.command === "docker" && call.args[0] === "run" && call.args.includes(started.plan.names.target));
  const antiCheatIndex = calls.findIndex((call) => call.command === manifest.antiCheat!.executable);
  const agentIndex = calls.findIndex((call) => call.command === "docker" && call.args[0] === "run" && call.args.includes(started.plan.names.agent));
  expect(targetIndex).toBeGreaterThan(-1);
  expect(antiCheatIndex).toBeGreaterThan(targetIndex);
  expect(agentIndex).toBeGreaterThan(antiCheatIndex);
  const stopped = await lifecycle.stop();
  expect(stopped?.cleaned).toBe(true);
  expect(calls.slice(-3).map((call) => call.args.slice(0, 2))).toEqual([["rm", "-f"], ["rm", "-f"], ["network", "rm"]]);
});

test("docker benchmark lifecycle resolves a Docker Desktop image through its immutable id", async () => {
  const { root, manifest } = fixture();
  const calls: string[][] = [];
  const runner: BenchmarkProcessRunner = async (_command, args) => {
    calls.push(args);
    if (args.join(" ") === `image inspect ${DEFAULT_KALI_IMAGE}`) return result("", 1, `No such image: ${DEFAULT_KALI_IMAGE}`);
    if (args[0] === "image" && args[1] === "ls") return result(`${DEFAULT_KALI_IMAGE} ${agentImageId.slice(7, 19)}\n`);
    if (args.join(" ") === `image inspect ${agentImageId.slice(7, 19)}`) return result(imageInspect(agentImageId));
    return result("");
  };
  const lifecycle = new BenchmarkDockerLifecycle(manifest, join(root, "scratch"), "run-one", runner);
  const started = await lifecycle.start();
  expect(started.state.agentImageId).toBe(agentImageId);
  expect(started.plan.agentStart).toContain(agentImageId);
  expect(calls.slice(0, 3)).toEqual([
    ["image", "inspect", DEFAULT_KALI_IMAGE],
    ["image", "ls", KALI_IMAGE_REPO, "--format", "{{.Repository}}:{{.Tag}} {{.ID}}"],
    ["image", "inspect", agentImageId.slice(7, 19)]
  ]);
  await lifecycle.stop();
});

test("docker benchmark refuses to create resources when the pinned target image is unavailable", async () => {
  const { root, manifest } = fixture();
  const calls: string[][] = [];
  const runner: BenchmarkProcessRunner = async (_command, args) => {
    calls.push(args);
    if (args.join(" ") === `image inspect ${DEFAULT_KALI_IMAGE}`) return result(imageInspect(agentImageId));
    if (args[0] === "image" && args[1] === "inspect") return result("", 1, "No such image");
    return result("");
  };
  const lifecycle = new BenchmarkDockerLifecycle(manifest, join(root, "scratch"), "run-one", runner);
  await expect(lifecycle.start()).rejects.toThrow("benchmark target image is unavailable locally");
  expect(calls.some((args) => args[0] === "network" && args[1] === "create")).toBe(false);
});

test("docker benchmark cleanup remains retryable after a daemon failure", async () => {
  const { root, manifest } = fixture();
  let cleanupAttempt = 0;
  const runner: BenchmarkProcessRunner = async (_command, args) => {
    if (args.join(" ") === `image inspect ${DEFAULT_KALI_IMAGE}`) return result(imageInspect(agentImageId));
    if (args[0] === "image" && args[1] === "inspect") return result("[]");
    if (args[0] === "inspect") return result(JSON.stringify({ Running: true, ExitCode: 0, Health: { Status: "healthy" } }));
    if (args[0] === "rm" || (args[0] === "network" && args[1] === "rm")) {
      cleanupAttempt += 1;
      if (cleanupAttempt === 1) return result("", 1, "docker daemon unavailable");
    }
    return result("");
  };
  const lifecycle = new BenchmarkDockerLifecycle(manifest, join(root, "scratch"), "run-one", runner);
  await lifecycle.start();
  const first = await lifecycle.stop();
  expect(first?.cleaned).toBe(false);
  const second = await lifecycle.stop();
  expect(second?.cleaned).toBe(true);
});

function imageInspect(id: string): string {
  return JSON.stringify([{
    Id: id,
    Config: { Labels: { [KALI_IMAGE_CONTRACT_LABEL]: KALI_IMAGE_CONTRACT } }
  }]);
}

function result(stdout: string, exitCode = 0, stderr = "") {
  return { stdout, stderr, exitCode, durationMs: 1, timedOut: false };
}
