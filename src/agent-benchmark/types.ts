import type { BackgroundJob, CompactionBoundary, Evidence, MessageWithParts, Session, SessionEvent, ToolCallRecord, Turn, UsageRecord, UsageSummary } from "../types";

export type BenchmarkNetworkPolicy = "host" | "none" | "target_only";
export type BenchmarkInternetPolicy = "enabled" | "disabled";
export type BenchmarkBackend = "host" | "docker";

export type BenchmarkManifest = {
  schemaVersion: 1;
  suite: {
    id: string;
    version: string;
    source: string;
    sourceDigest?: string;
  };
  challenge: {
    id: string;
    prompt: string;
    category?: string;
    difficulty?: string;
    source?: string;
    targetImage?: string;
    targetImageDigest?: string;
    targetCommand?: string[];
  };
  model: {
    selection: string;
    provider?: string;
    protocol?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    temperature?: number;
    seed?: number;
  };
  limits: {
    timeoutSeconds: number;
    maxSteps: number;
    maxCostUsd?: number;
    maxModelRequests?: number;
    maxToolCalls?: number;
    maxSubagents?: number;
    maxConcurrentSubagents?: number;
    maxTokens?: number;
  };
  isolation: {
    backend: BenchmarkBackend;
    network: BenchmarkNetworkPolicy;
    internet: BenchmarkInternetPolicy;
    projectInstructions: false;
    mcp: false;
    knowledge: false;
    skills: false;
    hooks: false;
    resources?: {
      cpus?: number;
      memoryMb?: number;
      diskMb?: number;
      pids?: number;
    };
  };
  files?: Array<{ source: string; destination: string; sha256?: string }>;
  toolScope: string[];
  oracle?: {
    command: string[];
    executableSha256?: string;
    flagPattern: string;
    flags?: string;
    timeoutSeconds?: number;
    env?: Record<string, string>;
  };
  antiCheat?: {
    executable: string;
    executableSha256: string;
    args?: string[];
  };
};

export type BenchmarkStopReason =
  | "challenge_timeout"
  | "model_request_limit"
  | "tool_call_limit"
  | "subagent_limit"
  | "token_limit"
  | "runtime_error"
  | "final_response"
  | "cancelled"
  | "planner_error"
  | "no_actions"
  | "step_limit"
  | "time_limit"
  | "context_budget"
  | "cost_budget"
  | "unknown";

export type BenchmarkResult = {
  runId: string;
  suiteId: string;
  suiteVersion: string;
  challengeId: string;
  repetition: number;
  manifestHash: string;
  solved: boolean;
  validatedFlagHash?: string;
  stopReason: BenchmarkStopReason;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  workspace: string;
  bundlePath: string;
  model: string;
  responseHash: string;
  response: string;
  usage: UsageSummary;
  activity: {
    modelRequests: number;
    toolCalls: number;
    commands: number;
    toolErrors: number;
    plannerErrors: number;
    loopSupervisions: number;
    retries: number;
    duplicateCalls: number;
    compactions: number;
    backgroundJobs: number;
    subagents: number;
  };
  oracle: {
    configured: boolean;
    candidates: number;
    attempts: number;
    errors: string[];
  };
  lifecycle: {
    backend: BenchmarkBackend;
    scratchWorkspace: true;
    docker?: {
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
  };
  evidence: Array<{ id: string; source: string; title: string; summaryHash: string }>;
  frozen: {
    faraiCommit?: string;
    dirtyStateHash: string;
    schemaVersion: 1;
    suiteId: string;
    suiteVersion: string;
    suiteSource: string;
    suiteSourceDigest?: string;
    model: string;
    provider?: string;
    protocol?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    temperature?: number;
    seed?: number;
    samplingEnforced: false;
    promptHash: string;
    systemPromptHash: string;
    toolCatalogHash: string;
    configHash: string;
    kaliImage: string;
    kaliContract: string;
    kaliToolManifestHash: string;
    targetImage?: string;
    targetImageDigest?: string;
    oracleExecutableHash?: string;
    antiCheatExecutableHash?: string;
    timeoutSeconds: number;
    maxSteps: number;
    maxCostUsd?: number;
    maxModelRequests?: number;
    maxToolCalls?: number;
    maxSubagents?: number;
    maxConcurrentSubagents?: number;
    maxTokens?: number;
    backend: BenchmarkBackend;
    networkPolicy: BenchmarkNetworkPolicy;
    internetPolicy: BenchmarkInternetPolicy;
    projectInstructionsEnabled: false;
    mcpEnabled: false;
    knowledgeEnabled: false;
    skillsEnabled: false;
    hooksEnabled: false;
    bun: string;
    platform: string;
    arch: string;
  };
};

export type BenchmarkBundle = {
  manifest: BenchmarkManifest;
  result: BenchmarkResult;
  sessions: Session[];
  turns: Turn[];
  messages: MessageWithParts[];
  events: SessionEvent[];
  toolCalls: ToolCallRecord[];
  jobs: BackgroundJob[];
  usage: UsageRecord[];
  compactions: CompactionBoundary[];
  evidence: Evidence[];
};

export type BenchmarkSuiteManifest = {
  schemaVersion: 1;
  id: string;
  version: string;
  source: string;
  sourceDigest?: string;
  repetitions: number;
  concurrency: number;
  runs: BenchmarkManifest[];
};

export type BenchmarkCampaignResult = {
  campaignId: string;
  bundlePath: string;
  suiteId: string;
  suiteVersion: string;
  manifestHash: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  repetitions: number;
  challengeCount: number;
  runCount: number;
  solvedRuns: number;
  solvedChallenges: number;
  solveRate: number;
  passAtK: Record<string, number>;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  toolErrors: number;
  results: Array<{
    runId: string;
    challengeId: string;
    repetition: number;
    solved: boolean;
    stopReason: BenchmarkStopReason;
    durationMs: number;
    cost: number;
    bundlePath: string;
    error?: string;
  }>;
};
