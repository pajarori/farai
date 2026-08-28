import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { AgentRuntime } from "../agent-core/runtime";
import { buildSystemPrompt } from "../agent-core/provider/system-prompt";
import { buildToolsPayload, createChatProviderForSession, type PlannerProvider } from "../agent-core/provider";
import type { ChatProvider } from "../agent-core/provider/protocol";
import { DEFAULT_KALI_IMAGE, KALI_IMAGE_CONTRACT } from "../agent-container/kali";
import { KALI_TOOL_MANIFEST_PATH } from "../agent-container/kali-tool-manifest";
import { HostProcessBackend } from "../agent-tools/backends/host-process";
import type { BackendExecResult, BackendSessionResult, SessionKind } from "../agent-tools/backends/types";
import { baseTools } from "../agent-tools/registry";
import type { ToolExecutionBackend } from "../agent-tools/shared/backend";
import type { BackgroundJob, Session, SessionEvent, ToolCallRecord, ToolDefinition } from "../types";
import { id } from "../utils";
import { writeBenchmarkBundle, writeBenchmarkResult } from "./bundle";
import { BenchmarkDockerLifecycle, type BenchmarkDockerState, type BenchmarkProcessRunner } from "./docker-lifecycle";
import { benchmarkManifestHash, hashPath, sha256, stableStringify } from "./hash";
import { loadBenchmarkManifest, normalizeBenchmarkManifest } from "./manifest";
import type { BenchmarkBundle, BenchmarkManifest, BenchmarkResult, BenchmarkStopReason } from "./types";

export type BenchmarkRunOptions = {
  workspace?: string;
  artifactsDir?: string;
  provider?: PlannerProvider | ChatProvider;
  faraiRoot?: string;
  stopContainersOnTimeout?: boolean;
  repetition?: number;
  dockerProcessRunner?: BenchmarkProcessRunner;
};

type PromptState = "pending" | "completed" | "failed";

export async function runBenchmark(input: BenchmarkManifest, options: BenchmarkRunOptions = {}): Promise<BenchmarkResult> {
  const manifest = normalizeBenchmarkManifest(input);
  assertExecutableIsolation(manifest);
  const workspace = options.workspace ?? mkdtempSync(join(tmpdir(), "farai-benchmark-"));
  const artifactsRoot = options.artifactsDir ?? mkdtempSync(join(tmpdir(), "farai-benchmark-artifacts-"));
  const repetition = options.repetition ?? 1;
  mkdirSync(workspace, { recursive: true });
  assertCleanWorkspace(workspace);
  assertArtifactsOutsideWorkspace(workspace, artifactsRoot);
  mkdirSync(artifactsRoot, { recursive: true });
  stageFiles(manifest, workspace);
  const runId = id();
  const bundlePath = join(artifactsRoot, `${safeName(manifest.challenge.id)}-r${repetition}-${runId}`);
  const provider = options.provider ?? await createChatProviderForSession(syntheticSession(workspace, manifest));
  assertProvider(manifest, provider);
  const dockerLifecycle = manifest.isolation.backend === "docker"
    ? new BenchmarkDockerLifecycle(manifest, workspace, runId, options.dockerProcessRunner)
    : undefined;
  let dockerState: BenchmarkDockerState | undefined;
  let runtime: AgentRuntime | undefined;
  let shutdown = false;
  try {
    const docker = dockerLifecycle ? await dockerLifecycle.start() : undefined;
    dockerState = docker?.state;
    const executionBackend = docker?.backend ?? (manifest.isolation.backend === "host" ? new BenchmarkHostBackend(workspace) : undefined);
    runtime = new AgentRuntime(workspace, provider, {
      maxSteps: manifest.limits.maxSteps,
      maxTurnSeconds: manifest.limits.timeoutSeconds,
      ...(manifest.limits.maxCostUsd !== undefined ? { maxCostUsd: manifest.limits.maxCostUsd } : {}),
      ...(manifest.limits.maxConcurrentSubagents !== undefined ? { maxConcurrentSubagents: manifest.limits.maxConcurrentSubagents } : {}),
      inheritConfig: false,
      enableKnowledge: false,
      enableSkills: false,
      enableHooks: false,
      enableMcp: false,
      enableProjectInstructions: false,
      registerSessionCatalog: false,
      ...(executionBackend ? { executionBackend } : {})
    });
    const startedAt = new Date().toISOString();
    const started = Date.now();
    let response = "";
    let runError: string | undefined;
    let promptState: PromptState = "pending";
    let session = await runtime.createSession({ model: manifest.model.selection, title: manifest.challenge.id });
    const activeTools = resolveBenchmarkTools(manifest.toolScope);
    session = runtime.updateSession(session.id, { toolScope: activeTools.map((tool) => tool.name) });
    const faraiRoot = options.faraiRoot ?? resolve(import.meta.dir, "..", "..");
    const frozen = freezeRun(manifest, session, activeTools, faraiRoot, provider, dockerState?.agentImageId);
    const promptPromise = runtime.prompt(session, manifest.challenge.prompt)
      .then((result) => {
        response = result.response;
        promptState = "completed";
      })
      .catch((error) => {
        runError = error instanceof Error ? error.message : String(error);
        promptState = "failed";
      });
    const externalStop = await driveRun(runtime, session.id, manifest, started, () => promptState);
    if (externalStop) {
      await runtime.abortSessionTree(session.id, externalStop, { stopContainers: manifest.isolation.backend !== "docker" && options.stopContainersOnTimeout !== false });
      await Promise.race([promptPromise, delay(1_000)]);
    } else {
      await promptPromise;
    }
    const bundleData = collectRunData(runtime, session.id);
    const usage = runtime.store.usageSummaryTree(session.id);
    response = latestAssistantText(bundleData.messages.filter((message) => message.sessionId === session.id)) ?? response;
    const oracleSources = [
      response,
      ...bundleData.evidence.flatMap((item) => [item.title, item.summary]),
      ...bundleData.messages.flatMap((message) => message.parts.map((part) => stableStringify(part.payload)))
    ];
    const oracleResult = await validateCandidates(manifest, oracleSources, workspace);
    const rootTurn = bundleData.turns.filter((turn) => turn.sessionId === session.id).at(-1);
    const finishedAt = new Date().toISOString();
    const result: BenchmarkResult = {
      runId,
      suiteId: manifest.suite.id,
      suiteVersion: manifest.suite.version,
      challengeId: manifest.challenge.id,
      repetition,
      manifestHash: benchmarkManifestHash(manifest),
      solved: oracleResult.solved,
      ...(oracleResult.validatedFlagHash ? { validatedFlagHash: oracleResult.validatedFlagHash } : {}),
      stopReason: externalStop ?? (runError ? "runtime_error" : rootTurn?.stopReason ?? "unknown"),
      startedAt,
      finishedAt,
      durationMs: Date.now() - started,
      workspace,
      bundlePath,
      model: manifest.model.selection,
      responseHash: sha256(response),
      response,
      usage,
      activity: activitySummary(bundleData.toolCalls, bundleData.events, bundleData.jobs, bundleData.compactions.length),
      oracle: {
        configured: Boolean(manifest.oracle),
        candidates: oracleResult.candidates,
        attempts: oracleResult.attempts,
        errors: [...oracleResult.errors, ...(runError ? [runError] : [])]
      },
      lifecycle: {
        backend: manifest.isolation.backend,
        scratchWorkspace: true,
        ...(dockerState ? { docker: dockerState } : {})
      },
      evidence: bundleData.evidence.map((item) => ({ id: item.id, source: item.source, title: item.title, summaryHash: sha256(item.summary) })),
      frozen
    };
    await runtime.shutdown(externalStop ? { gracePeriodMs: 0 } : {});
    shutdown = true;
    if (dockerLifecycle) {
      dockerState = await dockerLifecycle.stop();
      if (dockerState) result.lifecycle.docker = dockerState;
    }
    writeBenchmarkBundle({ manifest, result, ...bundleData }, bundlePath);
    return result;
  } finally {
    if (!shutdown && runtime) await runtime.shutdown({ gracePeriodMs: 0 }).catch(() => undefined);
    await dockerLifecycle?.stop().catch(() => undefined);
  }
}

function syntheticSession(workspace: string, manifest: BenchmarkManifest): Session {
  const timestamp = new Date(0).toISOString();
  return {
    id: "benchmark-provider-resolution",
    workspace,
    mode: "freestyle",
    phase: "understand_goal",
    model: manifest.model.selection,
    ...(manifest.model.provider ? { provider: manifest.model.provider } : {}),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function assertExecutableIsolation(manifest: BenchmarkManifest): void {
  if (manifest.model.temperature !== undefined || manifest.model.seed !== undefined) {
    throw new Error("temperature and seed are not currently enforceable by the provider adapters; omit them instead of recording false reproducibility");
  }
  if (manifest.isolation.backend === "host" && manifest.isolation.resources) throw new Error("resource limits require the docker benchmark backend");
  if (manifest.isolation.backend === "host" && (manifest.challenge.targetImage || manifest.challenge.targetImageDigest || manifest.challenge.targetCommand?.length)) {
    throw new Error("host benchmark backend cannot provision target images or target commands");
  }
  if (manifest.isolation.backend === "docker") {
    if (manifest.isolation.network !== "target_only" || manifest.isolation.internet !== "disabled") throw new Error("docker benchmark isolation requires network=target_only and internet=disabled");
    if (!manifest.challenge.targetImage || !manifest.challenge.targetImageDigest) throw new Error("docker benchmark requires a pinned target image");
    if (!manifest.antiCheat) throw new Error("docker benchmark requires an external anti-cheat hook");
    if (manifest.isolation.resources?.diskMb) throw new Error("docker benchmark diskMb is not enforceable for a bind-mounted scratch workspace");
  }
}

function assertCleanWorkspace(workspace: string): void {
  const entries = readdirSync(workspace);
  if (entries.length) throw new Error(`benchmark workspace must be an empty scratch directory: ${workspace}`);
}

function assertArtifactsOutsideWorkspace(workspace: string, artifactsRoot: string): void {
  const difference = relative(resolve(workspace), resolve(artifactsRoot));
  const reverse = relative(resolve(artifactsRoot), resolve(workspace));
  if (!difference || !difference.startsWith("..") || !reverse.startsWith("..")) {
    throw new Error("benchmark artifacts directory must be outside the scratch workspace");
  }
}

function assertProvider(manifest: BenchmarkManifest, provider: PlannerProvider | ChatProvider): void {
  if (manifest.model.contextWindow !== undefined && provider.contextWindow !== manifest.model.contextWindow) {
    throw new Error(`model.contextWindow=${manifest.model.contextWindow} does not match resolved provider context window ${provider.contextWindow}`);
  }
  if (manifest.model.maxOutputTokens !== undefined && provider.maxOutputTokens !== manifest.model.maxOutputTokens) {
    throw new Error(`model.maxOutputTokens=${manifest.model.maxOutputTokens} does not match resolved provider output limit ${provider.maxOutputTokens}`);
  }
  if (manifest.model.protocol !== undefined && "protocol" in provider && provider.protocol !== manifest.model.protocol) {
    throw new Error(`model.protocol=${manifest.model.protocol} does not match resolved provider protocol ${provider.protocol}`);
  }
}

function resolveBenchmarkTools(scope: string[]): ToolDefinition[] {
  const allowed = new Map(baseTools
    .filter((tool) => tool.name !== "skill_load" && !tool.name.startsWith("knowledge_"))
    .map((tool) => [tool.name, tool]));
  return scope.map((name) => {
    const tool = allowed.get(name);
    if (!tool) throw new Error(`benchmark toolScope contains unavailable or forbidden tool: ${name}`);
    return tool;
  });
}

async function driveRun(runtime: AgentRuntime, rootSessionId: string, manifest: BenchmarkManifest, started: number, promptState: () => PromptState): Promise<BenchmarkStopReason | undefined> {
  let stableChecks = 0;
  for (;;) {
    const stop = benchmarkLimit(runtime, rootSessionId, manifest, started);
    if (stop) return stop;
    if (promptState() !== "pending") {
      if (isQuiescent(runtime, rootSessionId)) {
        stableChecks += 1;
        if (stableChecks >= 2) return undefined;
      } else {
        stableChecks = 0;
      }
    }
    await delay(25);
  }
}

function benchmarkLimit(runtime: AgentRuntime, rootSessionId: string, manifest: BenchmarkManifest, started: number): BenchmarkStopReason | undefined {
  if (Date.now() - started >= manifest.limits.timeoutSeconds * 1_000) return "challenge_timeout";
  const data = collectCounters(runtime, rootSessionId);
  if (manifest.limits.maxModelRequests !== undefined && data.modelRequests > manifest.limits.maxModelRequests) return "model_request_limit";
  if (manifest.limits.maxToolCalls !== undefined && data.toolCalls > manifest.limits.maxToolCalls) return "tool_call_limit";
  if (manifest.limits.maxSubagents !== undefined && data.subagents > manifest.limits.maxSubagents) return "subagent_limit";
  if (manifest.limits.maxTokens !== undefined && data.tokens >= manifest.limits.maxTokens) return "token_limit";
  return undefined;
}

function collectCounters(runtime: AgentRuntime, rootSessionId: string): { modelRequests: number; toolCalls: number; subagents: number; tokens: number } {
  const sessions = sessionTree(runtime.store.listSessions(100_000, { includeArchived: true }), rootSessionId);
  const events = sessions.flatMap((session) => runtime.store.listEvents(session.id, 100_000));
  const toolCalls = sessions.flatMap((session) => runtime.store.listToolCalls(session.id, 100_000));
  const jobs = sessions.flatMap((session) => runtime.store.listJobs(session.id, 100_000));
  const usage = sessions.flatMap((session) => runtime.store.listUsage(session.id, 100_000));
  return {
    modelRequests: events.filter((event) => event.type === "planner_attempt").length,
    toolCalls: toolCalls.length,
    subagents: jobs.filter((job) => job.kind === "agent").length,
    tokens: usage.reduce((total, record) => total + record.inputTokens + record.outputTokens, 0)
  };
}

function isQuiescent(runtime: AgentRuntime, rootSessionId: string): boolean {
  const sessions = sessionTree(runtime.store.listSessions(100_000, { includeArchived: true }), rootSessionId);
  const runningTurns = sessions.some((session) => runtime.store.listTurns(session.id, 100_000).some((turn) => turn.status === "running"));
  const activeJobs = sessions.some((session) => runtime.store.listJobs(session.id, 100_000).some((job) => ["created", "starting", "running", "cancelling"].includes(job.status)));
  return !runningTurns && !activeJobs;
}

function collectRunData(runtime: AgentRuntime, rootSessionId: string): Omit<BenchmarkBundle, "manifest" | "result"> {
  const sessions = sessionTree(runtime.store.listSessions(100_000, { includeArchived: true }), rootSessionId);
  return {
    sessions,
    turns: sessions.flatMap((session) => runtime.store.listTurns(session.id, 100_000)),
    messages: sessions.flatMap((session) => runtime.store.listMessages(session.id, 100_000)),
    events: sessions.flatMap((session) => runtime.store.listEvents(session.id, 100_000)),
    toolCalls: sessions.flatMap((session) => runtime.store.listToolCalls(session.id, 100_000)),
    jobs: sessions.flatMap((session) => runtime.store.listJobs(session.id, 100_000)),
    usage: sessions.flatMap((session) => runtime.store.listUsage(session.id, 100_000)),
    compactions: sessions.flatMap((session) => runtime.store.listCompactionBoundaries(session.id)),
    evidence: sessions.flatMap((session) => runtime.store.listEvidence(session.id))
  };
}

function stageFiles(manifest: BenchmarkManifest, workspace: string): void {
  for (const file of manifest.files ?? []) {
    const source = resolve(file.source);
    if (!existsSync(source)) throw new Error(`benchmark input does not exist: ${file.source}`);
    if (file.sha256 && hashPath(source) !== file.sha256.toLowerCase()) throw new Error(`benchmark input hash mismatch: ${file.source}`);
    const target = resolve(workspace, file.destination);
    if (relative(workspace, target).startsWith("..")) throw new Error(`benchmark destination escapes scratch workspace: ${file.destination}`);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: statSync(source).isDirectory() });
    if (!existsSync(target)) throw new Error(`benchmark input was not staged: ${file.destination}`);
    if (statSync(target).isDirectory() && !listFiles(target).length) throw new Error(`benchmark input staged an empty directory: ${file.destination}`);
  }
}

function listFiles(rootPath: string): string[] {
  if (!existsSync(rootPath)) return [];
  if (!statSync(rootPath).isDirectory()) return [rootPath];
  return readdirSync(rootPath).flatMap((name) => listFiles(join(rootPath, name)));
}

class BenchmarkHostBackend implements ToolExecutionBackend {
  readonly kind = "host";
  private readonly host: HostProcessBackend;

  constructor(private readonly workspace: string) {
    this.host = new HostProcessBackend(workspace);
  }

  async exec(command: string, timeoutMs = 120_000, signal?: AbortSignal, maxOutputChars = 8_000): Promise<BackendExecResult> {
    const result = await this.host.runOnce(this.mapWorkspacePaths(command), { timeoutMs, ...(signal ? { signal } : {}) });
    return {
      ...result,
      stdout: result.stdout.slice(0, maxOutputChars),
      stderr: result.stderr.slice(0, maxOutputChars)
    };
  }

  runOnce(command: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<BackendExecResult> {
    return this.exec(command, options.timeoutMs, options.signal);
  }

  startSession(command: string, options: { yieldMs: number; signal?: AbortSignal; kind?: SessionKind; pty?: boolean }): Promise<BackendSessionResult> {
    return this.host.startSession(this.mapWorkspacePaths(command), options);
  }

  pollSession(sessionId: string, options: { input?: string; yieldMs: number }): Promise<BackendSessionResult> {
    return this.host.pollSession(sessionId, options);
  }

  waitSession(sessionId: string): Promise<BackendSessionResult> {
    return this.host.waitSession(sessionId);
  }

  stopSession(sessionId: string): Promise<void> {
    return this.host.stopSession(sessionId);
  }

  private mapWorkspacePaths(command: string): string {
    const quoted = command.replace(/(["'])(\/workspace(?:\/[^"']*)?)\1/g, (_match, quote: string, path: string) => `${quote}${this.hostPath(path)}${quote}`);
    return quoted.replace(/(^|[\s;|&<>()])\/workspace(?=$|[\s;|&<>()/])/g, (_match, prefix: string) => `${prefix}${this.workspace}`);
  }

  private hostPath(path: string): string {
    if (path === "/workspace") return this.workspace;
    return join(this.workspace, path.slice("/workspace/".length));
  }
}

function freezeRun(manifest: BenchmarkManifest, session: Session, tools: ToolDefinition[], faraiRoot: string, provider: PlannerProvider | ChatProvider, kaliImageId?: string): BenchmarkResult["frozen"] {
  const faraiCommit = gitOutput(faraiRoot, ["rev-parse", "HEAD"]);
  const dirty = [gitOutput(faraiRoot, ["status", "--short", "--untracked-files=all"]) ?? "", gitOutput(faraiRoot, ["diff", "--no-ext-diff", "HEAD"]) ?? ""].join("\n");
  const system = buildSystemPrompt({ session });
  const catalog = buildToolsPayload(tools.map((tool) => tool.name), tools);
  const providerProtocol = "protocol" in provider ? provider.protocol : manifest.model.protocol;
  const providerModel = "stream" in provider ? provider.model ?? manifest.model.selection : manifest.model.selection;
  return {
    ...(faraiCommit ? { faraiCommit } : {}),
    dirtyStateHash: sha256(dirty),
    schemaVersion: 1,
    suiteId: manifest.suite.id,
    suiteVersion: manifest.suite.version,
    suiteSource: manifest.suite.source,
    ...(manifest.suite.sourceDigest ? { suiteSourceDigest: manifest.suite.sourceDigest } : {}),
    model: providerModel,
    provider: provider.name,
    ...(providerProtocol ? { protocol: providerProtocol } : {}),
    ...(provider.contextWindow !== undefined ? { contextWindow: provider.contextWindow } : {}),
    ...(provider.maxOutputTokens !== undefined ? { maxOutputTokens: provider.maxOutputTokens } : {}),
    ...(manifest.model.temperature !== undefined ? { temperature: manifest.model.temperature } : {}),
    ...(manifest.model.seed !== undefined ? { seed: manifest.model.seed } : {}),
    samplingEnforced: false,
    promptHash: sha256(manifest.challenge.prompt),
    systemPromptHash: sha256(system),
    toolCatalogHash: sha256(stableStringify(catalog)),
    configHash: sha256(stableStringify({ model: manifest.model, limits: manifest.limits, isolation: manifest.isolation, toolScope: manifest.toolScope })),
    kaliImage: kaliImageId ?? DEFAULT_KALI_IMAGE,
    kaliContract: KALI_IMAGE_CONTRACT,
    kaliToolManifestHash: sha256(readFileSync(KALI_TOOL_MANIFEST_PATH)),
    ...(manifest.challenge.targetImage ? { targetImage: manifest.challenge.targetImage } : {}),
    ...(manifest.challenge.targetImageDigest ? { targetImageDigest: manifest.challenge.targetImageDigest } : {}),
    ...(manifest.oracle?.executableSha256 ? { oracleExecutableHash: manifest.oracle.executableSha256 } : {}),
    ...(manifest.antiCheat?.executableSha256 ? { antiCheatExecutableHash: manifest.antiCheat.executableSha256 } : {}),
    timeoutSeconds: manifest.limits.timeoutSeconds,
    maxSteps: manifest.limits.maxSteps,
    ...(manifest.limits.maxCostUsd !== undefined ? { maxCostUsd: manifest.limits.maxCostUsd } : {}),
    ...(manifest.limits.maxModelRequests !== undefined ? { maxModelRequests: manifest.limits.maxModelRequests } : {}),
    ...(manifest.limits.maxToolCalls !== undefined ? { maxToolCalls: manifest.limits.maxToolCalls } : {}),
    ...(manifest.limits.maxSubagents !== undefined ? { maxSubagents: manifest.limits.maxSubagents } : {}),
    ...(manifest.limits.maxConcurrentSubagents !== undefined ? { maxConcurrentSubagents: manifest.limits.maxConcurrentSubagents } : {}),
    ...(manifest.limits.maxTokens !== undefined ? { maxTokens: manifest.limits.maxTokens } : {}),
    backend: manifest.isolation.backend,
    networkPolicy: manifest.isolation.network,
    internetPolicy: manifest.isolation.internet,
    projectInstructionsEnabled: false,
    mcpEnabled: false,
    knowledgeEnabled: false,
    skillsEnabled: false,
    hooksEnabled: false,
    bun: Bun.version,
    platform: platform(),
    arch: arch()
  };
}

async function validateCandidates(manifest: BenchmarkManifest, sources: string[], workspace: string): Promise<{ solved: boolean; validatedFlagHash?: string; candidates: number; attempts: number; errors: string[] }> {
  if (!manifest.oracle) return { solved: false, candidates: 0, attempts: 0, errors: [] };
  let expression: RegExp;
  try {
    const flags = [...new Set(`${manifest.oracle.flags ?? ""}g`.split(""))].join("");
    expression = new RegExp(manifest.oracle.flagPattern, flags);
  } catch (error) {
    throw new Error(`invalid oracle flag pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidates = new Set<string>();
  for (const source of sources) {
    expression.lastIndex = 0;
    for (const match of source.matchAll(expression)) {
      const candidate = match[1] ?? match[0];
      if (candidate) candidates.add(candidate);
    }
  }
  let attempts = 0;
  const errors: string[] = [];
  for (const candidate of candidates) {
    attempts += 1;
    const result = await runOracle(manifest.oracle, candidate, workspace, manifest.challenge.id);
    if (result.ok) return { solved: true, validatedFlagHash: sha256(candidate), candidates: candidates.size, attempts, errors };
    if (result.error) errors.push(result.error);
  }
  return { solved: false, candidates: candidates.size, attempts, errors };
}

async function runOracle(oracle: NonNullable<BenchmarkManifest["oracle"]>, candidate: string, workspace: string, challengeId: string): Promise<{ ok: boolean; error?: string }> {
  if (oracle.executableSha256) {
    if (!existsSync(oracle.command[0]!)) return { ok: false, error: "oracle executable missing" };
    if (hashPath(oracle.command[0]!) !== oracle.executableSha256) return { ok: false, error: "oracle executable hash mismatch" };
  }
  const child = Bun.spawn(oracle.command, {
    cwd: workspace,
    env: { ...processEnv(), ...(oracle.env ?? {}), FARAI_CHALLENGE_ID: challengeId },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  });
  child.stdin.write(candidate);
  child.stdin.end();
  const outcome = await Promise.race([child.exited, delay(oracle.timeoutSeconds ? oracle.timeoutSeconds * 1_000 : 10_000).then(() => "timeout" as const)]);
  if (outcome === "timeout") {
    child.kill();
    return { ok: false, error: "oracle timeout" };
  }
  const stderr = await new Response(child.stderr).text();
  return outcome === 0 ? { ok: true } : { ok: false, ...(stderr.trim() ? { error: stderr.trim().slice(0, 500) } : {}) };
}

function activitySummary(toolCalls: ToolCallRecord[], events: SessionEvent[], jobs: BackgroundJob[], compactions: number): BenchmarkResult["activity"] {
  const signatures = new Map<string, number>();
  for (const call of toolCalls) {
    const signature = `${call.tool}:${stableStringify(call.args)}`;
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
  }
  return {
    modelRequests: events.filter((event) => event.type === "planner_attempt").length,
    toolCalls: toolCalls.length,
    commands: toolCalls.filter((call) => call.tool === "shell_exec").length,
    toolErrors: toolCalls.filter((call) => call.status === "error").length,
    plannerErrors: events.filter((event) => event.type === "planner_error").length,
    loopSupervisions: events.filter((event) => event.type === "loop_supervision").length,
    retries: events.filter((event) => event.type === "planner_error" && Boolean((event.payload as { retrying?: unknown })?.retrying)).length,
    duplicateCalls: [...signatures.values()].reduce((total, count) => total + Math.max(0, count - 1), 0),
    compactions,
    backgroundJobs: jobs.length,
    subagents: jobs.filter((job) => job.kind === "agent").length
  };
}

function sessionTree(sessions: Session[], rootSessionId: string): Session[] {
  const ids = new Set([rootSessionId]);
  for (;;) {
    let changed = false;
    for (const session of sessions) {
      if (session.parentId && ids.has(session.parentId) && !ids.has(session.id)) {
        ids.add(session.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return sessions.filter((session) => ids.has(session.id));
}

function latestAssistantText(messages: BenchmarkBundle["messages"]): string | undefined {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "text")
    .map((part) => (part.payload as { text?: unknown }).text)
    .filter((text): text is string => typeof text === "string" && Boolean(text.trim()))
    .at(-1);
}

function gitOutput(root: string, args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return undefined;
  return result.stdout.toString("utf8").trim();
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "challenge";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export { loadBenchmarkManifest, normalizeBenchmarkManifest, writeBenchmarkResult };
export type { BenchmarkManifest, BenchmarkResult } from "./types";
