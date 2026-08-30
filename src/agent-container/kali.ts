import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { spawn as spawnPty } from "bun-pty";
import { isAbsolute, join, relative, resolve } from "node:path";
import { truncate } from "../utils";
import type { BackendExecResult, BackendSessionResult, ExecutionBackend, SessionKind } from "../agent-tools/backends/types";
import { SpawnSessionStore, allOutput, combinedOutput, killEntry, toBackendSession, touch, waitForExit, waitForExitOrYield, writeInput } from "../agent-tools/backends/spawn-session";
import {
  PtySessionStore,
  drainOutput,
  killPtyEntry,
  retainedOutput,
  toBackendSession as toPtyBackendSession,
  touch as touchPty,
  waitForPtyExit,
  waitForPtyExitOrYield,
  writePtyInput
} from "../agent-tools/backends/pty-session";
import { KALI_TOOL_MANIFEST } from "./kali-tool-manifest";
import {
  managedContainerLabels,
  managedContainerLabelsMatch,
  type ContainerLifecyclePort,
  type ManagedContainerIdentity
} from "./lifecycle";

export const CONTAINER_WORKSPACE_MOUNT = "/workspace";
export const CONTAINER_WORKTREES_MOUNT = "/worktrees";

export type ContainerExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export type ContainerStatus = {
  image: string;
  imageExists: boolean;
  imageId?: string;
  imageContract?: string;
  imageContractCurrent: boolean;
  dockerContext?: string;
  persistentName: string;
  persistentExists?: boolean;
  persistentState?: string;
  persistentRunning: boolean;
  persistentImageId?: string;
  persistentImageCurrent: boolean;
  persistentIdentityCurrent?: boolean;
};

export type OutputChunkListener = (chunk: string, stream: "stdout" | "stderr") => void;

export type KaliBackendOptions = {
  image?: string;
  containerName?: string;
  workspace: string;
  timeoutMs?: number;
  processRunner?: ProcessRunner;
  signal?: AbortSignal;
  onOutputChunk?: OutputChunkListener;
  rootSessionId?: string;
  rootWorkspace?: string;
  lifecycle?: ContainerLifecyclePort;
};

export type ProcessRunner = (command: string, args: string[]) => Promise<ContainerExecResult>;

export type TransparentProxyOptions = {
  proxyPort: number;
  redirectPorts?: number[];
};

const kaliSessions = new SpawnSessionStore();
const kaliPtySessions = new PtySessionStore();
const containerStartLocks = new Map<string, Promise<ContainerExecResult>>();
let globalContainerStartChain: Promise<unknown> = Promise.resolve();

function withGlobalContainerStartLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = globalContainerStartChain.catch(() => undefined).then(fn);
  globalContainerStartChain = run.then(() => undefined, () => undefined);
  return run;
}

export const CONTAINER_PREFIX = "farai-kali-";
export const KALI_IMAGE_CONTRACT = KALI_TOOL_MANIFEST.contract;
export const DEFAULT_KALI_IMAGE = "farai-kali:latest";
export const KALI_IMAGE_CONTRACT_LABEL = "org.farai.kali.contract";

type ResolvedImage = {
  exists: boolean;
  id?: string;
  contract?: string;
};

export function containerNameForSession(sessionId: string): string {
  return `${CONTAINER_PREFIX}${sessionId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

export function containerWorkspacePath(rootWorkspace: string, workspace: string): string {
  const root = resolve(rootWorkspace);
  const current = resolve(workspace);
  if (current === root) return CONTAINER_WORKSPACE_MOUNT;
  const worktreesRoot = join(root, ".farai", "worktrees");
  const rel = relative(worktreesRoot, current);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`workspace is outside the root session family: ${workspace}`);
  return `${CONTAINER_WORKTREES_MOUNT}/${rel.split("\\").join("/")}`;
}

export class KaliContainerBackend implements ExecutionBackend {
  readonly kind = "kali";
  readonly image: string;
  readonly containerName: string;
  readonly workspace: string;
  readonly rootWorkspace: string;
  readonly workspacePath: string;
  readonly timeoutMs: number;
  private readonly processRunner: ProcessRunner;
  private readonly signal: AbortSignal | undefined;
  private readonly onOutputChunk: OutputChunkListener | undefined;
  private readonly lifecycle: ContainerLifecyclePort | undefined;
  private readonly identity: ManagedContainerIdentity | undefined;

  constructor(options: KaliBackendOptions) {
    this.image = options.image ?? DEFAULT_KALI_IMAGE;
    this.containerName = options.containerName ?? "farai-kali";
    this.workspace = resolve(options.workspace);
    this.rootWorkspace = resolve(options.rootWorkspace ?? options.workspace);
    this.workspacePath = containerWorkspacePath(this.rootWorkspace, this.workspace);
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.processRunner = options.processRunner ?? ((command, args) => runProcess(command, args, Math.min(this.timeoutMs, 15_000)));
    this.signal = options.signal;
    this.onOutputChunk = options.onOutputChunk;
    this.lifecycle = options.lifecycle;
    this.identity = options.rootSessionId ? {
      containerName: this.containerName,
      rootSessionId: options.rootSessionId,
      workspace: this.rootWorkspace,
      imageContract: KALI_IMAGE_CONTRACT
    } : undefined;
  }

  buildImageCommand(): string[] {
    const contextDir = join(import.meta.dir, "..", "..", "docker", "kali");
    return [
      "docker",
      "build",
      "-t",
      this.image,
      "-f",
      join(contextDir, "Dockerfile"),
      contextDir
    ];
  }

  async status(): Promise<ContainerStatus> {
    const image = await this.resolveImage();
    const dockerContext = (await this.processRunner("docker", ["context", "show"])).stdout.trim();
    const inspected = await this.inspectPersistent();
    const persistentExists = Boolean(inspected);
    const persistentRunning = inspected?.state === "running";
    const persistentImageId = inspected?.imageId ?? "";
    const persistentImageCurrent = Boolean(
      persistentExists
      && image.id
      && persistentImageId
      && imageIdsMatch(image.id, persistentImageId)
    );
    const persistentIdentityCurrent = Boolean(this.identity && managedContainerLabelsMatch(inspected?.labels, this.identity));
    return {
      image: this.image,
      imageExists: image.exists,
      ...(image.id ? { imageId: image.id } : {}),
      ...(image.contract ? { imageContract: image.contract } : {}),
      imageContractCurrent: image.contract === KALI_IMAGE_CONTRACT,
      ...(dockerContext ? { dockerContext } : {}),
      persistentName: this.containerName,
      persistentExists,
      ...(inspected?.state ? { persistentState: inspected.state } : {}),
      persistentRunning,
      ...(persistentImageId ? { persistentImageId } : {}),
      persistentImageCurrent,
      persistentIdentityCurrent
    };
  }

  private async inspectPersistent(): Promise<{ state: string; imageId?: string; labels?: Record<string, string> } | undefined> {
    const inspected = await this.processRunner("docker", [
      "inspect",
      "-f",
      "{{.State.Status}}\t{{.Image}}\t{{json .Config.Labels}}",
      this.containerName
    ]);
    if (inspected.exitCode !== 0) return undefined;
    const [state = "unknown", imageId = "", labelsJson = ""] = inspected.stdout.trim().split("\t", 3);
    try {
      return {
        state: state || "unknown",
        ...(imageId ? { imageId } : {}),
        ...(labelsJson && labelsJson !== "null"
          ? { labels: JSON.parse(labelsJson) as Record<string, string> }
          : {})
      };
    } catch {
      return { state: state || "unknown", ...(imageId ? { imageId } : {}) };
    }
  }

  async resolveImage(): Promise<ResolvedImage> {
    const inspect = await this.processRunner("docker", ["image", "inspect", this.image]);
    if (inspect.exitCode === 0) {
      return parseImageInspect(inspect.stdout);
    }

    const { repository, tag } = parseDockerImageTag(this.image);
    if (!repository) return { exists: false };
    const listed = await this.processRunner("docker", ["image", "ls", repository, "--format", "{{.Repository}}:{{.Tag}} {{.ID}}"]);
    const line = listed.stdout
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.startsWith(`${repository}:${tag} `));
    if (!line) return { exists: false };
    const id = line.split(/\s+/)[1];
    if (!id) return { exists: true };
    const inspectById = await this.processRunner("docker", ["image", "inspect", id]);
    if (inspectById.exitCode !== 0) return { exists: true, id };
    const resolved = parseImageInspect(inspectById.stdout);
    return { ...resolved, id: resolved.id ?? id };
  }

  async startPersistent(): Promise<ContainerExecResult> {
    const previous = containerStartLocks.get(this.containerName) ?? Promise.resolve(undefined);
    const task = previous
      .catch(() => undefined)
      .then(() => this.startPersistentUnlocked());
    containerStartLocks.set(this.containerName, task);
    try {
      return await task;
    } finally {
      if (containerStartLocks.get(this.containerName) === task) {
        containerStartLocks.delete(this.containerName);
      }
    }
  }

  private async startPersistentUnlocked(): Promise<ContainerExecResult> {
    if (this.identity && this.lifecycle) await this.lifecycle.acquire(this.identity);
    try {
      const status = await this.status();
      if (!status.imageExists) {
        if (this.identity && this.lifecycle) this.lifecycle.release(this.identity);
        return {
          exitCode: 1,
          stdout: "",
          stderr: `kali image ${this.image} is missing; run \`farai setup --no-kb\``,
          durationMs: 0,
          timedOut: false
        };
      }
      if (!status.imageContractCurrent) {
        if (this.identity && this.lifecycle) this.lifecycle.release(this.identity);
        return {
          exitCode: 1,
          stdout: "",
          stderr: `kali image ${this.image} does not satisfy the farai kali capability contract; run \`farai setup --no-kb\``,
          durationMs: 0,
          timedOut: false
        };
      }
      if (status.persistentRunning && status.persistentImageCurrent && (!this.identity || status.persistentIdentityCurrent)) {
        return { exitCode: 0, stdout: "already running", stderr: "", durationMs: 0, timedOut: false };
      }
      if (status.persistentExists && !status.persistentRunning && status.persistentImageCurrent && (!this.identity || status.persistentIdentityCurrent)) {
        const started = Date.now();
        const result = await this.processRunner("docker", ["start", this.containerName]);
        if (result.exitCode !== 0 && this.identity && this.lifecycle) this.lifecycle.release(this.identity);
        return { ...result, durationMs: Date.now() - started, timedOut: false };
      }
      return await withGlobalContainerStartLock(async () => {
        await this.processRunner("docker", ["rm", "-f", "-v", this.containerName]);
        const worktrees = join(this.rootWorkspace, ".farai", "worktrees");
        mkdirSync(worktrees, { recursive: true });
        const started = Date.now();
        const result = await this.processRunner("docker", [
          "run",
          "-d",
          "--name",
          this.containerName,
          "--workdir",
          CONTAINER_WORKSPACE_MOUNT,
          "--volume",
          `${this.rootWorkspace}:${CONTAINER_WORKSPACE_MOUNT}`,
          "--volume",
          `${CONTAINER_WORKSPACE_MOUNT}/.farai`,
          "--volume",
          `${worktrees}:${CONTAINER_WORKTREES_MOUNT}`,
          ...(this.identity ? managedContainerLabels(this.identity) : []),
          ...kaliDockerSecurityArgs(),
          this.image,
          "sleep",
          "infinity"
        ]);
        if (result.exitCode !== 0 && this.identity && this.lifecycle) this.lifecycle.release(this.identity);
        return { ...result, durationMs: Date.now() - started, timedOut: false };
      });
    } catch (error) {
      if (this.identity && this.lifecycle) this.lifecycle.release(this.identity);
      throw error;
    }
  }

  async enableTransparentProxy(options: TransparentProxyOptions): Promise<ContainerExecResult> {
    await this.ensurePersistentRunning();
    const started = Date.now();
    const env = [
      `FARAI_PROXY_PORT=${options.proxyPort}`,
      ...(options.redirectPorts?.length ? [`FARAI_PROXY_TCP_PORTS=${options.redirectPorts.join(",")}`] : [])
    ].flatMap((entry) => ["-e", entry]);
    const result = await this.processRunner("docker", ["exec", ...env, this.containerName, "farai-proxy-init"]);
    return { ...result, durationMs: Date.now() - started, timedOut: false };
  }

  async disableTransparentProxy(): Promise<ContainerExecResult> {
    const started = Date.now();
    const result = await this.processRunner("docker", ["exec", this.containerName, "farai-proxy-teardown"]);
    return { ...result, durationMs: Date.now() - started, timedOut: false };
  }

  async stopPersistent(): Promise<ContainerExecResult> {
    if (this.identity && this.lifecycle) return await this.lifecycle.remove(this.identity);
    const started = Date.now();
    const result = await this.processRunner("docker", ["rm", "-f", "-v", this.containerName]);
    if (result.exitCode !== 0 && containerDoesNotExist(result)) {
      return { ...result, exitCode: 0, stdout: result.stdout || "already stopped", durationMs: Date.now() - started, timedOut: false };
    }
    return { ...result, durationMs: Date.now() - started, timedOut: false };
  }

  previewRunCommand(command: string): string[] {
    return this.execArgs(command);
  }

  previewStdioCommand(command: string[], options: { cwd?: string; env?: Record<string, string> } = {}): string[] {
    return this.stdioArgs(command, options);
  }

  async spawnStdio(
    command: string[],
    options: { cwd?: string; env?: Record<string, string> } = {}
  ): Promise<ChildProcessWithoutNullStreams> {
    await this.ensurePersistentRunning();
    const child = spawn("docker", this.stdioArgs(command, options), { stdio: ["pipe", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => { cleanup(); resolve(); };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const cleanup = (): void => {
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    return child;
  }

  async exec(
    command: string,
    timeoutMs = this.timeoutMs,
    signal = this.signal,
    maxOutputChars = 8_000
  ): Promise<ContainerExecResult & { backgroundSessionId?: string }> {
    await this.ensurePersistentRunning();
    const started = Date.now();
    const args = this.execArgs(command);

    return await new Promise((resolve) => {
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let converted = false;
      const onStdout = (chunk: Buffer) => {
        const text = stdoutDecoder.write(chunk);
        stdout += text;
        if (text) this.onOutputChunk?.(text, "stdout");
      };
      const onStderr = (chunk: Buffer) => {
        const text = stderrDecoder.write(chunk);
        stderr += text;
        if (text) this.onOutputChunk?.(text, "stderr");
      };
      const timer = setTimeout(() => {
        converted = true;
        child.stdout.removeListener("data", onStdout);
        child.stderr.removeListener("data", onStderr);
        const { sessionId } = kaliSessions.register(child);
        resolve({
          exitCode: null,
          stdout: truncate(stdout, maxOutputChars),
          stderr: truncate(stderr, maxOutputChars),
          durationMs: Date.now() - started,
          timedOut: false,
          backgroundSessionId: sessionId
        });
      }, timeoutMs);
      const abort = () => child.kill("SIGTERM");
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (converted) return;
        const stdoutTail = stdoutDecoder.end();
        const stderrTail = stderrDecoder.end();
        stdout += stdoutTail;
        stderr += stderrTail;
        if (stdoutTail) this.onOutputChunk?.(stdoutTail, "stdout");
        if (stderrTail) this.onOutputChunk?.(stderrTail, "stderr");
        resolve({
          exitCode,
          stdout: truncate(stdout, maxOutputChars),
          stderr: truncate(stderr, maxOutputChars),
          durationMs: Date.now() - started,
          timedOut: false
        });
      });
    });
  }

  async runOnce(command: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<BackendExecResult> {
    return this.exec(command, opts.timeoutMs, opts.signal);
  }

  private async ensurePersistentRunning(): Promise<void> {
    const result = await this.startPersistent();
    if (result.exitCode !== 0) throw new Error(result.stderr || "Could not start Kali container for background execution");
  }

  async startSession(command: string, opts: { yieldMs: number; signal?: AbortSignal; kind?: SessionKind; pty?: boolean }): Promise<BackendSessionResult> {
    await this.ensurePersistentRunning();

    if (opts.pty) {

      const proc = spawnPty("docker", ["exec", "-it", "-w", this.workspacePath, this.containerName, "bash", "-l"], {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        env: process.env as Record<string, string>
      });
      const abort = () => proc.kill();
      if (opts.signal?.aborted) abort();
      else opts.signal?.addEventListener("abort", abort, { once: true });

      const { sessionId, entry } = kaliPtySessions.register(proc);
      writePtyInput(entry, command);
      await waitForPtyExitOrYield(entry, opts.yieldMs);
      touchPty(entry);
      return { session: toPtyBackendSession(sessionId, entry), output: drainOutput(entry) };
    }

    const child = spawn("docker", ["exec", "-i", "-w", this.workspacePath, this.containerName, "bash", "-lc", command], { stdio: ["pipe", "pipe", "pipe"] });
    const abort = () => child.kill("SIGTERM");
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener("abort", abort, { once: true });

    const { sessionId, entry } = kaliSessions.register(child);
    await waitForExitOrYield(entry, opts.yieldMs);
    touch(entry);
    return { session: toBackendSession(sessionId, entry), output: combinedOutput(entry) };
  }

  async waitSession(sessionId: string): Promise<BackendSessionResult> {
    const ptyEntry = kaliPtySessions.get(sessionId);
    if (ptyEntry) {
      await waitForPtyExit(ptyEntry);
      touchPty(ptyEntry);
      return { session: toPtyBackendSession(sessionId, ptyEntry), output: retainedOutput(ptyEntry) };
    }

    const entry = kaliSessions.get(sessionId);
    if (!entry) throw new Error(`Unknown session: ${sessionId}`);
    await waitForExit(entry);
    touch(entry);
    return { session: toBackendSession(sessionId, entry), output: allOutput(entry) };
  }

  async pollSession(sessionId: string, opts: { input?: string; yieldMs: number }): Promise<BackendSessionResult> {
    const ptyEntry = kaliPtySessions.get(sessionId);
    if (ptyEntry) {
      if (opts.input) writePtyInput(ptyEntry, opts.input);
      await waitForPtyExitOrYield(ptyEntry, opts.yieldMs);
      touchPty(ptyEntry);
      return { session: toPtyBackendSession(sessionId, ptyEntry), output: drainOutput(ptyEntry) };
    }

    const entry = kaliSessions.get(sessionId);
    if (!entry) throw new Error(`Unknown session: ${sessionId}`);
    if (opts.input) writeInput(entry, opts.input);
    await waitForExitOrYield(entry, opts.yieldMs);
    touch(entry);
    return { session: toBackendSession(sessionId, entry), output: combinedOutput(entry) };
  }

  async stopSession(sessionId: string): Promise<void> {
    const ptyEntry = kaliPtySessions.get(sessionId);
    if (ptyEntry) {
      killPtyEntry(ptyEntry);
      kaliPtySessions.delete(sessionId);
      return;
    }

    const entry = kaliSessions.get(sessionId);
    if (!entry) return;
    killEntry(entry);
    kaliSessions.delete(sessionId);
  }

  private execArgs(command: string): string[] {
    return ["exec", "-i", "-w", this.workspacePath, this.containerName, "bash", "-lc", command];
  }

  private stdioArgs(command: string[], options: { cwd?: string; env?: Record<string, string> }): string[] {
    if (command.length === 0 || command.some((part) => !part)) throw new Error("stdio command must not be empty");
    const cwd = options.cwd ?? this.workspacePath;
    if (cwd !== this.workspacePath && !cwd.startsWith(`${this.workspacePath}/`)) {
      throw new Error(`stdio cwd must be inside ${this.workspacePath}`);
    }
    const env = Object.entries(options.env ?? {}).flatMap(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid environment variable name: ${key}`);
      return ["-e", `${key}=${value}`];
    });
    return ["exec", "-i", "-w", cwd, ...env, this.containerName, ...command];
  }
}

export function kaliDockerSecurityArgs(): string[] {
  return [
    "--security-opt",
    "no-new-privileges:true",
    "--cap-add",
    "NET_ADMIN",
    "--cap-add",
    "NET_RAW"
  ];
}

export function parseDockerImageTag(image: string): { repository: string; tag: string } {
  const slashIndex = image.lastIndexOf("/");
  const colonIndex = image.lastIndexOf(":");
  if (colonIndex > slashIndex) {
    return {
      repository: image.slice(0, colonIndex),
      tag: image.slice(colonIndex + 1) || "latest"
    };
  }
  return { repository: image, tag: "latest" };
}

function parseImageInspect(raw: string): ResolvedImage {
  try {
    const parsed = JSON.parse(raw) as Array<{
      Id?: string;
      Config?: { Labels?: Record<string, string> | null };
    }>;
    const image = parsed[0];
    if (!image) return { exists: true };
    const contract = image.Config?.Labels?.[KALI_IMAGE_CONTRACT_LABEL];
    return {
      exists: true,
      ...(image.Id ? { id: image.Id } : {}),
      ...(contract ? { contract } : {})
    };
  } catch {
    return { exists: true };
  }
}

function imageIdsMatch(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/^sha256:/, "");
  const normalizedRight = right.replace(/^sha256:/, "");
  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(normalizedRight)
    || normalizedRight.startsWith(normalizedLeft);
}

async function runProcess(command: string, args: string[], timeoutMs = 15_000): Promise<ContainerExecResult> {
  const started = Date.now();
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
      timedOut: false
    };
  }
  let stdout = "";
  let stderr = "";
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  proc.stdout?.on("data", (chunk) => {
    stdout += stdoutDecoder.write(chunk);
  });
  proc.stderr?.on("data", (chunk) => {
    stderr += stderrDecoder.write(chunk);
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve(null);
    }, timeoutMs);
    proc.once("error", (error) => {
      clearTimeout(timer);
      stderr += error.message;
      resolve(127);
    });
    proc.once("close", (code) => {
      clearTimeout(timer);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve(code);
    });
  });
  return {
    exitCode,
    stdout: truncate(stdout),
    stderr: truncate(stderr),
    durationMs: Date.now() - started,
    timedOut: exitCode === null
  };
}

function containerDoesNotExist(result: ContainerExecResult): boolean {
  return /no such container/i.test(`${result.stdout}\n${result.stderr}`);
}
