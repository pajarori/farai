export type AgentMode = "freestyle";

export type InternalPhase =
  | "understand_goal"
  | "research"
  | "code_assist"
  | "recon"
  | "enumeration"
  | "hypothesis"
  | "verification"
  | "exploit_lab"
  | "post_exploit_lab"
  | "reporting";

export type CampaignKind = "pentest" | "bug_bounty" | "ctf" | "lab";
export type CampaignStatus = "active" | "paused" | "completed" | "archived";
export type AssetKind = "domain" | "subdomain" | "ip" | "url" | "endpoint" | "api" | "repository" | "mobile_app" | "service" | "other";
export type ObservationStatus = "active" | "stale" | "disproven" | "archived";
export type HypothesisStatus = "open" | "testing" | "verified" | "disproven" | "blocked" | "archived";
export type FindingStatus = "candidate" | "needs_verification" | "verified" | "duplicate" | "not_applicable" | "reported" | "accepted" | "rejected";
export type TestAttemptStatus = "planned" | "running" | "passed" | "failed" | "inconclusive" | "cancelled";
export type EvidenceLevel = "signal" | "differential_observed" | "reproduced" | "impact_demonstrated" | "independently_verified";
export type ToolVisibility = "core" | "workspace" | "recon" | "verification" | "callback" | "external";
export type ToolConcurrencyScope = "runtime" | "workspace" | "session";

export type ToolStatus = "pending" | "running" | "running_background" | "done" | "error";
export type JobKind = "process" | "agent";
export type JobStatus = "created" | "starting" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "lost";
export type JobCancellationPolicy = "turn" | "session" | "runtime";
export type JobDeliveryState = "pending" | "enqueued" | "consumed" | "suppressed";
export type MailboxKind = "user" | "job_completion" | "agent_completion" | "system" | "control";
export type MailboxTriggerPolicy = "wake" | "queue" | "interrupt" | "control" | "context";
export type MailboxState = "queued" | "claimed" | "consumed" | "cancelled";
export type TurnStatus = "running" | "completed" | "failed" | "cancelled";
export type TurnStopReason =
  | "final_response"
  | "cancelled"
  | "planner_error"
  | "no_actions"
  | "step_limit"
  | "time_limit"
  | "context_budget"
  | "cost_budget";
export type MessageRole = "user" | "assistant" | "tool" | "system";
export type TodoStatus = "pending" | "in_progress" | "done" | "blocked" | "cancelled";
export type TodoPriority = "low" | "medium" | "high";
export type PartType =
  | "text"
  | "provider_context"
  | "provider_catalog"
  | "reasoning_summary"
  | "tool_call"
  | "tool_result"
  | "artifact"
  | "finding"
  | "error"
  | "planner_attempt"
  | "planner_error"
  | "loop_stop"
  | "compaction"
  | "tool_started"
  | "tool_progress"
  | "mcp_startup_update"
  | "mcp_startup_complete"
  | "phase_change";

export type SessionEventType =
  | PartType
  | "job_started"
  | "job_progress"
  | "job_completed"
  | "job_failed"
  | "job_cancelled"
  | "job_lost"
  | "mailbox_queued"
  | "mailbox_consumed"
  | "tool_input_start"
  | "tool_input_delta"
  | "tool_input_end"
  | "loop_supervision"
  | "stream_text";

export type Campaign = {
  id: string;
  workspace: string;
  name: string;
  kind: CampaignKind;
  status: CampaignStatus;
  createdAt: string;
  updatedAt: string;
};

export type CampaignAsset = {
  id: string;
  campaignId: string;
  canonical: string;
  kind: AssetKind;
  parentId?: string;
  technologies: string[];
  metadata: Record<string, unknown>;
  confidence: number;
  firstSeen: string;
  lastSeen: string;
};

export type CampaignObservation = {
  id: string;
  campaignId: string;
  assetId?: string;
  kind: string;
  value: unknown;
  confidence: number;
  source: string;
  evidenceIds: string[];
  status: ObservationStatus;
  createdAt: string;
  updatedAt: string;
};

export type CampaignHypothesis = {
  id: string;
  campaignId: string;
  assetId?: string;
  title: string;
  category: string;
  status: HypothesisStatus;
  rationale: string;
  nextTest: string;
  confidence: number;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type CampaignSearchResult = {
  kind: "asset" | "observation" | "hypothesis" | "message" | "finding";
  id: string;
  title: string;
  body: string;
  score: number;
  assetId?: string;
  createdAt?: string;
};

export type CampaignDossier = {
  campaign: Campaign;
  assets: CampaignAsset[];
  observations: CampaignObservation[];
  hypotheses: CampaignHypothesis[];
  findings: Finding[];
  recentEvidence: Evidence[];
  searchMatches: CampaignSearchResult[];
};

export type TestAttempt = {
  id: string;
  campaignId: string;
  sessionId: string;
  hypothesisId?: string;
  title: string;
  target: string;
  method: string;
  baseline: unknown;
  mutation: unknown;
  oracle: string;
  observed?: unknown;
  status: TestAttemptStatus;
  evidenceLevel: EvidenceLevel;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type CampaignNextAction = {
  lane: "discovery" | "mapping" | "web_api" | "authz" | "injection" | "business_logic" | "client_side" | "cloud_config" | "verification" | "reporting";
  title: string;
  rationale: string;
  priority: number;
  assetId?: string;
  hypothesisId?: string;
  prompt: string;
};

export type Session = {
  id: string;
  workspace: string;
  mode: AgentMode;
  phase: InternalPhase;
  title?: string;
  parentId?: string;
  campaignId?: string;
  provider?: string;
  model?: string;
  summary?: string;
  summaryUpdatedAt?: string;
  toolScope?: string[];
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type Note = {
  id: string;
  sessionId: string;
  text: string;
  tags: string[];
  createdAt: string;
};

export type SessionEvent = {
  id: string;
  sessionId: string;
  sequence?: number;
  type: SessionEventType;
  payload: unknown;
  createdAt: string;
};

export type ToolInputPreview = {
  id: string;
  turnId: string;
  index: number;
  providerToolCallId?: string;
  tool: string;
  rawArguments: string;
};

export type CompactionBoundary = {
  id: string;
  sessionId: string;
  trigger: "manual" | "auto";
  throughMessageRowId: number;
  summary: string;
  preCompactTokens?: number;
  postCompactTokens?: number;
  createdAt: string;
};

export type UsageRecord = {
  id: string;
  sessionId: string;
  turnId?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  pricing?: ModelPricingSnapshot;
  cost: number;
  latencyMs: number;
  createdAt: string;
};

export type ModelPricingSnapshot = {
  source: "models.dev" | "runtime";
  currency: "USD";
  unitTokens: 1_000_000;
  providerId?: string;
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
};

export type UsageSummary = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  cacheHitRate: number;
  totalCost: number;
  averageLatencyMs: number;
};

export type ToolSchemaSnapshot = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type Turn = {
  id: string;
  sessionId: string;
  runtimeId?: string;
  status: TurnStatus;
  userInput: string;
  stepCount: number;
  stopReason?: TurnStopReason;
  plannerName?: string;
  provider?: string;
  model?: string;
  errorSummary?: string;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  sessionId: string;
  turnId: string;
  role: MessageRole;
  createdAt: string;
};

export type Part = {
  id: string;
  sessionId: string;
  turnId: string;
  messageId: string;
  type: PartType;
  payload: unknown;
  order: number;
  createdAt: string;
};

export type MessageWithParts = Message & {
  parts: Part[];
};

export type Evidence = {
  id: string;
  sessionId: string;
  source: "tool" | "manual" | "file" | "screenshot" | "http";
  title: string;
  path?: string;
  summary: string;
  createdAt: string;
};

export type Finding = {
  id: string;
  sessionId: string;
  title: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  target: string;
  evidenceIds: string[];
  impact: string;
  reproduction: string;
  remediation: string;
  status?: FindingStatus;
  campaignId?: string;
  hypothesisId?: string;
  duplicateOf?: string;
};

export type MemoryItem = {
  id: string;
  sessionId: string;
  kind: "service" | "credential" | "endpoint" | "hypothesis" | "failed_attempt" | "fact";
  key: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
};

export type TodoItem = {
  id: string;
  sessionId: string;
  turnId?: string;
  text: string;
  status: TodoStatus;
  priority: TodoPriority;
  createdAt: string;
  updatedAt: string;
};

export type ToolCallRecord = {
  id: string;
  sessionId: string;
  tool: string;
  args: unknown;
  status: ToolStatus;
  evidenceIds: string[];
  outputArtifactId?: string;
  turnId?: string;
  messageId?: string;
  timelinePartId?: string;
  jobId?: string;
  processId?: string;
  providerToolCallId?: string;
  liveOutput?: string;
};

export type BackgroundJob = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  runtimeId: string;
  sessionId: string;
  turnId?: string;
  toolCallId?: string;
  childSessionId?: string;
  title?: string;
  lane?: string;
  agentMode?: "attached" | "detached";
  backendKind?: string;
  processId?: string;
  cancellationPolicy: JobCancellationPolicy;
  deliveryState: JobDeliveryState;
  outputArtifactId?: string;
  result?: unknown;
  error?: string;
  mailboxId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type SessionMailboxItem = {
  id: string;
  sessionId: string;
  sequence: number;
  kind: MailboxKind;
  payload: unknown;
  triggerPolicy: MailboxTriggerPolicy;
  state: MailboxState;
  dedupeKey: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  claimedAt?: string;
  consumedAt?: string;
};

export type QueuedUserInput = {
  id: string;
  sequence: number;
  text: string;
  action: "plain" | "slash" | "shell";
  createdAt: string;
};

export type OutputArtifact = {
  id: string;
  sessionId: string;
  toolCallId?: string;
  path: string;
  bytes: number;
  createdAt: string;
};

export type AgentPromptResult = {
  session: Session;
  response: string;
  events: SessionEvent[];
};

export type ToolResult = {
  ok: boolean;
  summary: string;
  output?: string;
  evidence?: Evidence[];
  status?: ToolStatus;
  outputArtifactId?: string;
  metadata?: Record<string, unknown>;
  jobId?: string;
  processId?: string;
};

export type FileStateEntry = {
  path: string;
  content: string;
  mtime: number;
  offset?: number;
  limit?: number;
  readSeq: number;
};

export interface FileStateStore {
  get(sessionId: string, path: string): FileStateEntry | undefined;
  set(sessionId: string, entry: Omit<FileStateEntry, "readSeq">): void;
  invalidate(sessionId: string, path: string): void;
  recent(sessionId: string, limit: number): FileStateEntry[];
  clear(sessionId: string): void;
}

export type ToolContext = {
  session: Session;
  workspace: string;
  toolCallId?: string;
  now: () => string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fileState?: FileStateStore;
  lsp?: import("./agent-lsp/types").LspPort;
  knowledge?: import("./agent-knowledge/types").KnowledgeQuery;
  executionBackend?: import("./agent-tools/shared/backend").ToolExecutionBackend;
  onOutputChunk?: (chunk: string, stream: "stdout" | "stderr") => void;
  cancelJob?: (jobId: string) => Promise<BackgroundJob>;
  availableTools?: () => ToolDefinition[];
  invokeTool?: (name: string, args: unknown) => Promise<ToolResult>;
  delegateSession?: (input: { title: string; prompt: string; lane?: string; tools?: string[]; model?: string; mode?: "attached" | "detached"; sessionId?: string; linkToolCall?: boolean }) => Promise<{ sessionId: string; response?: string; jobId?: string }>;
  store: {
    saveEvidence: (evidence: Evidence, content?: string) => Evidence;
    listEvidence?: (sessionId: string) => Evidence[];
    loadEvidence?: (evidenceId: string) => Evidence;
    loadSession?: (sessionId: string) => Session;
    saveOutputArtifact: (input: { sessionId: string; toolCallId?: string; content: string }) => OutputArtifact;
    readOutputArtifact?: (artifactId: string, options?: { offset?: number; limit?: number }) => { artifact: OutputArtifact; content: string; totalLines: number; from: number; to: number } | undefined;
    loadJob?: (jobId: string) => BackgroundJob;
    findJobByProcessId?: (processId: string) => BackgroundJob | undefined;
    addNote: (note: Note) => void;
    saveFinding: (finding: Finding) => void;
    updateFinding?: (findingId: string, patch: Partial<Pick<Finding, "status" | "evidenceIds" | "impact" | "reproduction" | "remediation" | "duplicateOf">>) => Finding;
    loadFinding?: (findingId: string) => Finding;
    updateSession?: (sessionId: string, patch: Partial<Pick<Session, "campaignId" | "title" | "phase">>) => Session;
    upsertMemory: (item: Omit<MemoryItem, "id" | "createdAt" | "updatedAt">) => MemoryItem;
    createTodo: (item: Omit<TodoItem, "id" | "createdAt" | "updatedAt">) => TodoItem;
    updateTodo: (todoId: string, patch: Partial<Pick<TodoItem, "text" | "status" | "priority">>) => TodoItem;
    listTodos: (sessionId: string, options?: { turnId?: string; status?: TodoStatus; limit?: number }) => TodoItem[];
    createCampaign?: (input: Omit<Campaign, "id" | "createdAt" | "updatedAt">) => Campaign;
    loadCampaign?: (campaignId: string) => Campaign;
    listCampaigns?: (workspace: string, limit?: number) => Campaign[];
    upsertAsset?: (asset: Omit<CampaignAsset, "id" | "firstSeen" | "lastSeen">) => CampaignAsset;
    listAssets?: (campaignId: string) => CampaignAsset[];
    addObservation?: (observation: Omit<CampaignObservation, "id" | "createdAt" | "updatedAt">) => CampaignObservation;
    listObservations?: (campaignId: string, assetId?: string) => CampaignObservation[];
    upsertHypothesis?: (hypothesis: Omit<CampaignHypothesis, "id" | "createdAt" | "updatedAt">) => CampaignHypothesis;
    listHypotheses?: (campaignId: string, status?: HypothesisStatus) => CampaignHypothesis[];
    searchCampaign?: (campaignId: string, query: string, limit?: number) => CampaignSearchResult[];
    campaignDossier?: (campaignId: string, query?: string, limit?: number) => CampaignDossier;
    createTestAttempt?: (attempt: Omit<TestAttempt, "id" | "createdAt" | "updatedAt">) => TestAttempt;
    loadTestAttempt?: (attemptId: string) => TestAttempt;
    listTestAttempts?: (campaignId: string, hypothesisId?: string) => TestAttempt[];
    updateTestAttempt?: (attemptId: string, patch: Partial<Pick<TestAttempt, "status" | "observed" | "evidenceLevel" | "evidenceIds">>) => TestAttempt;
  };
};

export type ToolDefinition<TArgs = unknown> = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutates: boolean;
  timeoutMs: number;
  parallel: boolean;
  concurrencyScope?: ToolConcurrencyScope;
  visibility?: ToolVisibility;
  renderHuman: (result: ToolResult) => string;
  renderModel: (result: ToolResult) => string;
  run: (args: TArgs, context: ToolContext) => Promise<ToolResult>;
};
