import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type {
  Campaign,
  CampaignProgressKind,
  CampaignRun,
  CampaignRunStatus,
  CampaignWave
} from "../types";
import { nowIso } from "../utils";
import type { SqliteStore } from "../agent-store/sqlite-store";

const LEASE_TTL_MS = 45_000;
const ACTIVE_RUN_STATUSES = new Set<CampaignRunStatus>(["draft", "ready", "running", "waiting", "rate_limited", "budget_limited", "time_limited"]);
const AUTO_RESUME_RUN_STATUSES = new Set<CampaignRunStatus>(["draft", "ready", "running", "waiting", "rate_limited"]);
const NONTERMINAL_RUN_STATUSES = new Set<CampaignRunStatus>([...ACTIVE_RUN_STATUSES, "paused", "blocked"]);
const ACTIVE_JOB_STATUSES = new Set(["created", "starting", "running", "cancelling"]);

export type CampaignEvent = {
  kind: "campaign_created" | "campaign_run_started" | "campaign_wave_started" | "campaign_wave_settled" | "campaign_status";
  runId: string;
  campaignId: string;
  status?: CampaignRunStatus;
  wave?: number;
  objective?: string;
};

type CampaignCheckpoint = {
  status: "continue" | "waiting" | "blocked" | "complete";
  summary: string;
  blocker?: string;
  evidenceIds?: string[];
  waveId?: string;
};

export class CampaignSupervisor {
  constructor(
    private readonly store: SqliteStore,
    private readonly workspace: string,
    private readonly owner: string,
    private readonly emit?: (sessionId: string, payload: CampaignEvent) => void,
    private readonly scheduleContinuation?: (run: CampaignRun) => void,
    private readonly stopWorkers?: (runId: string) => void
  ) {}

  activeRunForSession(sessionId: string): CampaignRun | undefined {
    const session = this.store.loadSession(sessionId);
    if (session.campaignRunId) {
      try {
        const linked = this.store.loadCampaignRun(session.campaignRunId);
        if (linked.workspace === this.workspace && AUTO_RESUME_RUN_STATUSES.has(linked.status) && this.store.campaignLeaseOwner(linked.id) === this.owner) return linked;
      } catch {
      }
    }
    return this.store.listCampaignRuns(this.workspace).find((run) => run.rootSessionId === sessionId && AUTO_RESUME_RUN_STATUSES.has(run.status) && this.store.campaignLeaseOwner(run.id) === this.owner);
  }

  prepare(sessionId: string, objective?: string): CampaignRun | undefined {
    const session = this.store.loadSession(sessionId);
    if (!this.sessionBelongsToWorkspace(session.workspace)) throw new Error("session belongs to another workspace");
    const run = this.store.listCampaignRuns(this.workspace).find((item) => item.rootSessionId === sessionId && AUTO_RESUME_RUN_STATUSES.has(item.status));
    if (!run) return undefined;
    if (!this.store.acquireCampaignLease(run.id, this.owner, LEASE_TTL_MS)) throw new Error(`campaign run is owned by another runtime: ${run.id}`);
    this.store.updateSession(sessionId, { campaignId: run.campaignId, campaignRunId: run.id });
    this.ensureWave(run, objective?.trim() || run.objective);
    return this.store.loadCampaignRun(run.id);
  }

  start(sessionId: string, campaignId: string, objective: string): CampaignRun {
    const session = this.store.loadSession(sessionId);
    if (!this.sessionBelongsToWorkspace(session.workspace)) throw new Error("session belongs to another workspace");
    if (session.campaignRunId) {
      let linked: CampaignRun | undefined;
      try {
        linked = this.store.loadCampaignRun(session.campaignRunId);
      } catch {
      }
      if (linked && linked.workspace !== this.workspace) throw new Error("session campaign run belongs to another workspace");
      if (linked && ACTIVE_RUN_STATUSES.has(linked.status)) {
        if (linked.campaignId !== campaignId) throw new Error(`session already belongs to campaign run ${linked.id}`);
        if (!this.store.acquireCampaignLease(linked.id, this.owner, LEASE_TTL_MS)) throw new Error(`campaign run is owned by another runtime: ${linked.id}`);
        return linked;
      }
    }
    const existing = this.store.listCampaignRuns(this.workspace).find((run) => run.rootSessionId === sessionId && run.campaignId === campaignId && ACTIVE_RUN_STATUSES.has(run.status));
    if (existing) {
      this.store.updateSession(sessionId, { campaignId: existing.campaignId, campaignRunId: existing.id });
      if (!this.store.acquireCampaignLease(existing.id, this.owner, LEASE_TTL_MS)) throw new Error(`campaign run is owned by another runtime: ${existing.id}`);
      this.ensureWave(existing, objective);
      return this.store.loadCampaignRun(existing.id);
    }
    const other = this.store.listCampaignRuns(this.workspace).find((run) => run.rootSessionId === sessionId && NONTERMINAL_RUN_STATUSES.has(run.status));
    if (other) throw new Error(`session already has an active campaign run: ${other.id}`);
    const campaign: Campaign = this.store.loadCampaign(campaignId);
    if (campaign.workspace !== this.workspace) throw new Error("campaign belongs to another workspace");
    const normalizedObjective = objective.trim();
    if (!normalizedObjective) throw new Error("campaign objective must be non-empty");
    const run = this.store.createCampaignRun({
      campaignId: campaign.id,
      rootSessionId: sessionId,
      workspace: this.workspace,
      objective: normalizedObjective,
      status: "running",
      metadata: { owner: this.owner }
    });
    if (!this.store.acquireCampaignLease(run.id, this.owner, LEASE_TTL_MS)) throw new Error(`campaign run is owned by another runtime: ${run.id}`);
    const wave = this.ensureWave(run, normalizedObjective);
    this.store.updateSession(sessionId, { campaignId: campaign.id, campaignRunId: run.id, phase: "research" });
    this.emit?.(sessionId, { kind: "campaign_created", runId: run.id, campaignId: campaign.id, status: run.status, objective: run.objective });
    this.emit?.(sessionId, { kind: "campaign_run_started", runId: run.id, campaignId: campaign.id, status: run.status, objective: run.objective });
    this.emit?.(sessionId, { kind: "campaign_wave_started", runId: run.id, campaignId: campaign.id, status: run.status, wave: wave.sequence, objective: wave.objective });
    return this.store.loadCampaignRun(run.id);
  }

  ensureWave(run: CampaignRun, objective: string): CampaignWave {
    const waves = this.store.listCampaignWaves(run.id);
    const active = waves.find((wave) => ["planned", "leased", "running", "settling"].includes(wave.status));
    if (active) return active;
    const sequence = (waves.at(-1)?.sequence ?? 0) + 1;
    const wave = this.store.createCampaignWave({ runId: run.id, sequence, status: "running", objective: objective.trim() || run.objective, startedAt: nowIso() });
    this.store.updateCampaignRun(run.id, { status: "running", currentWaveId: wave.id, startedAt: run.startedAt ?? nowIso() });
    if (sequence > 1) this.emit?.(run.rootSessionId, { kind: "campaign_wave_started", runId: run.id, campaignId: run.campaignId, status: "running", wave: sequence, objective: wave.objective });
    return wave;
  }

  settleAfterTurn(runId: string, sessionId: string, stopReason?: string): CampaignRun {
    const run = this.store.loadCampaignRun(runId);
    if (run.rootSessionId !== sessionId) return run;
    if (!this.store.heartbeatCampaignLease(run.id, this.owner, LEASE_TTL_MS)) return run;
    this.store.releaseExpiredCampaignClaims(run.id);
    const wave = this.store.listCampaignWaves(run.id).find((item) => item.id === run.currentWaveId) ?? this.store.listCampaignWaves(run.id).at(-1);
    const state = this.durableState(run);
    const activeJobs = this.runSessions(run).some((session) => this.store.listJobs(session.id, 10_000).some((job) => job.campaignRunId === run.id && ACTIVE_JOB_STATUSES.has(job.status)));
    const activeClaims = this.store.listCampaignWaves(run.id).flatMap((item) => this.store.listCampaignClaims(item.id)).some((claim) => claim.status === "leased");
    if (activeJobs || activeClaims) {
      this.store.recordCampaignProgress({ runId: run.id, ...(wave ? { waveId: wave.id } : {}), kind: "verified_wait", fingerprint: state.fingerprint, summary: "waiting for active campaign workers or claims", evidenceCount: state.evidenceCount, findingCount: state.findingCount });
      if (wave) this.store.updateCampaignWave(wave.id, { status: "settling", progressSummary: "waiting for active campaign workers or claims" });
      const next = this.store.updateCampaignRun(run.id, { status: "waiting" });
      this.heartbeat();
      return next;
    }
    const previous = this.store.listCampaignProgress(run.id, 1)[0];
    const kind: CampaignProgressKind = previous && previous.fingerprint === state.fingerprint ? "no_progress" : "progress";
    this.store.recordCampaignProgress({ runId: run.id, ...(wave ? { waveId: wave.id } : {}), kind, fingerprint: state.fingerprint, summary: kind === "progress" ? "durable campaign state changed" : "no new durable campaign state", evidenceCount: state.evidenceCount, findingCount: state.findingCount });
    if (wave) this.store.updateCampaignWave(wave.id, { status: "completed", progressSummary: kind === "progress" ? "progress recorded" : "no progress recorded", finishedAt: nowIso() });
    const checkpoint = readCheckpoint(run, wave?.id);
    const previousProgress = this.store.listCampaignProgress(run.id, 3);
    const stalled = kind === "no_progress" && previousProgress.length >= 3 && previousProgress.every((item) => item.kind === "no_progress");
    const nextStatus: CampaignRunStatus = stalled
      ? "blocked"
      : checkpoint?.status === "blocked"
        ? "blocked"
        : checkpoint?.status === "waiting"
          ? "waiting"
          : checkpoint?.status === "complete"
            ? "completed"
            : stopReason === "cost_budget"
              ? "budget_limited"
              : "waiting";
    const next = this.store.updateCampaignRun(run.id, {
      status: nextStatus,
      ...(nextStatus === "blocked" ? { blocker: checkpoint?.blocker ?? "the campaign made no meaningful progress across consecutive waves" } : {}),
      ...(nextStatus === "completed" ? { completedAt: nowIso() } : {}),
      metadata: { ...run.metadata, ...(checkpoint ? { checkpoint } : {}) }
    });
    this.heartbeat();
    this.emit?.(sessionId, { kind: "campaign_wave_settled", runId: run.id, campaignId: run.campaignId, status: next.status, ...(wave ? { wave: wave.sequence } : {}) });
    const limitCanContinue = stopReason === "step_limit" || stopReason === "time_limit";
    if (next.status === "waiting" && checkpoint?.status !== "waiting" && checkpoint?.status !== "blocked" && (checkpoint?.status === "continue" || kind !== "no_progress" || limitCanContinue)) this.scheduleContinuation?.(next);
    return next;
  }

  checkpoint(runId: string, input: CampaignCheckpoint): CampaignRun {
    const run = this.store.loadCampaignRun(runId);
    if (!this.store.heartbeatCampaignLease(run.id, this.owner, LEASE_TTL_MS)) throw new Error("campaign run is owned by another runtime");
    const evidenceIds = input.evidenceIds ?? [];
    const wave = this.store.listCampaignWaves(run.id).find((item) => item.id === run.currentWaveId);
    if (input.status === "blocked" && !input.blocker?.trim()) throw new Error("blocked campaign checkpoints require blocker");
    if (input.status === "complete") {
      this.store.releaseExpiredCampaignClaims(run.id);
      const sessions = this.runSessions(run);
      const evidence = sessions.flatMap((item) => this.store.listEvidence(item.id));
      const requirements = this.store.listCampaignRequirements(run.id);
      const activeJobs = sessions.some((item) => this.store.listJobs(item.id, 10_000).some((job) => job.campaignRunId === run.id && ACTIVE_JOB_STATUSES.has(job.status)));
      const activeClaims = this.store.listCampaignWaves(run.id).flatMap((item) => this.store.listCampaignClaims(item.id)).some((claim) => claim.status === "leased");
      if (activeJobs || activeClaims) throw new Error("campaign cannot complete while workers or claims are active");
      if (evidence.length === 0 && evidenceIds.length === 0) throw new Error("campaign completion requires durable evidence");
      if (evidenceIds.length > 0 && evidenceIds.some((id) => !evidence.some((item) => item.id === id))) throw new Error("campaign completion evidence must belong to the campaign run");
      const pending = requirements.filter((item) => item.status === "pending");
      if (pending.length > 0) throw new Error(`campaign has unsatisfied requirements: ${pending.map((item) => item.key).join(", ")}`);
      const knownEvidence = new Set(evidence.map((item) => item.id));
      if (requirements.some((item) => item.status === "satisfied" && item.evidenceIds.length === 0)) throw new Error("satisfied campaign requirements require evidence");
      if (requirements.some((item) => item.evidenceIds.some((id) => !knownEvidence.has(id)))) throw new Error("campaign requirement evidence must belong to the campaign run");
    }
    const checkpoint = { ...input, ...(wave ? { waveId: wave.id } : {}), recordedAt: nowIso() };
    if (input.status === "complete" && wave) {
      const state = this.durableState(run);
      const previous = this.store.listCampaignProgress(run.id, 1)[0];
      const kind: CampaignProgressKind = previous?.fingerprint === state.fingerprint ? "no_progress" : "progress";
      this.store.recordCampaignProgress({ runId: run.id, waveId: wave.id, kind, fingerprint: state.fingerprint, summary: input.summary, evidenceCount: state.evidenceCount, findingCount: state.findingCount });
      this.store.updateCampaignWave(wave.id, { status: "completed", progressSummary: input.summary, finishedAt: nowIso() });
    }
    const next = this.store.updateCampaignRun(run.id, {
      metadata: { ...run.metadata, checkpoint },
      ...(input.status === "complete" ? { status: "completed", completedAt: nowIso() } : {}),
      ...(input.status === "blocked" ? { status: "blocked", blocker: input.blocker } : {}),
      ...(input.status === "waiting" ? { status: "waiting" } : {})
    });
    if (input.status === "complete") {
      this.emit?.(run.rootSessionId, { kind: "campaign_wave_settled", runId: run.id, campaignId: run.campaignId, status: next.status, ...(wave ? { wave: wave.sequence } : {}) });
      this.store.releaseCampaignLease(run.id, this.owner);
    }
    return next;
  }

  pause(runId: string): CampaignRun {
    const run = this.store.loadCampaignRun(runId);
    if (["completed", "cancelled", "failed", "paused"].includes(run.status)) return run;
    if (this.store.campaignLeaseOwner(run.id) !== this.owner) throw new Error("campaign run is owned by another runtime");
    this.cancelQueuedContinuations(run);
    const next = this.store.updateCampaignRun(run.id, { status: "paused", pausedAt: nowIso() });
    this.store.releaseCampaignLease(run.id, this.owner);
    return next;
  }

  resume(runId: string): CampaignRun {
    const run = this.store.loadCampaignRun(runId);
    if (!NONTERMINAL_RUN_STATUSES.has(run.status)) throw new Error(`campaign run cannot resume from ${run.status}`);
    if (!this.store.acquireCampaignLease(run.id, this.owner, LEASE_TTL_MS)) throw new Error(`campaign run is owned by another runtime: ${run.id}`);
    const next = this.store.updateCampaignRun(run.id, { status: "running" });
    this.ensureWave(next, next.objective);
    return this.store.loadCampaignRun(next.id);
  }

  stop(runId: string): CampaignRun {
    const run = this.store.loadCampaignRun(runId);
    if (["completed", "cancelled", "failed"].includes(run.status)) return run;
    if (this.store.campaignLeaseOwner(run.id) !== this.owner) throw new Error("campaign run is owned by another runtime");
    this.cancelQueuedContinuations(run);
    const next = this.store.updateCampaignRun(run.id, { status: "cancelled", completedAt: nowIso() });
    for (const wave of this.store.listCampaignWaves(run.id)) {
      for (const claim of this.store.listCampaignClaims(wave.id)) {
        if (claim.status === "leased" || claim.status === "available") this.store.updateCampaignClaim(claim.id, { status: "released", leaseOwner: null, leaseExpiresAt: null });
      }
      if (["planned", "leased", "running", "settling"].includes(wave.status)) this.store.updateCampaignWave(wave.id, { status: "cancelled", finishedAt: nowIso(), blocker: "campaign stopped" });
    }
    this.stopWorkers?.(run.id);
    this.store.releaseCampaignLease(run.id, this.owner);
    return next;
  }

  status(runId: string): { run: CampaignRun; waves: CampaignWave[]; requirements: ReturnType<SqliteStore["listCampaignRequirements"]>; progress: ReturnType<SqliteStore["listCampaignProgress"]> } {
    const run = this.store.loadCampaignRun(runId);
    return { run, waves: this.store.listCampaignWaves(run.id), requirements: this.store.listCampaignRequirements(run.id), progress: this.store.listCampaignProgress(run.id, 20) };
  }

  recover(): void {
    for (const run of this.store.listCampaignRuns(this.workspace, 10_000)) {
      if (!ACTIVE_RUN_STATUSES.has(run.status)) continue;
      this.store.recoverCampaignRun(run.id, this.owner, LEASE_TTL_MS);
    }
  }

  resumeWaiting(): void {
    for (const run of this.store.listCampaignRuns(this.workspace, 10_000)) {
      const wave = this.store.listCampaignWaves(run.id).find((item) => item.id === run.currentWaveId);
      const checkpoint = readCheckpoint(run, wave?.id);
      if (run.status === "waiting" && checkpoint?.status !== "waiting" && checkpoint?.status !== "blocked") this.scheduleContinuation?.(run);
    }
  }

  heartbeat(): void {
    for (const run of this.store.listCampaignRuns(this.workspace, 10_000)) {
      if (!ACTIVE_RUN_STATUSES.has(run.status)) continue;
      this.store.releaseExpiredCampaignClaims(run.id);
      this.store.heartbeatCampaignLease(run.id, this.owner, LEASE_TTL_MS);
      for (const wave of this.store.listCampaignWaves(run.id)) {
        for (const claim of this.store.listCampaignClaims(wave.id)) {
          if (claim.status === "leased" && claim.leaseOwner === this.owner) this.store.heartbeatCampaignClaim(claim.id, this.owner, LEASE_TTL_MS);
        }
      }
    }
  }

  private runSessions(run: CampaignRun) {
    return this.store.listSessions(10_000, { includeArchived: true }).filter((session) => session.id === run.rootSessionId || session.campaignRunId === run.id);
  }

  private cancelQueuedContinuations(run: CampaignRun): void {
    const prefix = `campaign-continuation:${run.id}:`;
    for (const item of this.store.listMailbox(run.rootSessionId, "queued")) {
      if (!item.dedupeKey.startsWith(prefix)) continue;
      this.store.cancelMailboxItem(item.id);
    }
  }

  private sessionBelongsToWorkspace(sessionWorkspace: string): boolean {
    const rel = relative(this.workspace, sessionWorkspace);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) return !rel;
    const normalized = rel.split(/[\\/]+/).join("/");
    return normalized === ".farai/worktrees" || normalized.startsWith(".farai/worktrees/");
  }

  private durableState(run: CampaignRun): { fingerprint: string; evidenceCount: number; findingCount: number } {
    const sessions = this.runSessions(run);
    const evidence = sessions.flatMap((session) => this.store.listEvidence(session.id));
    const findings = sessions.flatMap((session) => this.store.listFindings(session.id));
    const assets = this.store.listAssets(run.campaignId);
    const observations = this.store.listObservations(run.campaignId);
    const hypotheses = this.store.listHypotheses(run.campaignId);
    const attempts = this.store.listTestAttempts(run.campaignId);
    const requirements = this.store.listCampaignRequirements(run.id);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      assets: assets.map((item) => [item.id, item.lastSeen, item.confidence]),
      observations: observations.map((item) => [item.id, item.updatedAt, item.status]),
      hypotheses: hypotheses.map((item) => [item.id, item.updatedAt, item.status, item.confidence]),
      attempts: attempts.map((item) => [item.id, item.updatedAt, item.status, item.evidenceLevel]),
      evidence: evidence.map((item) => [item.id, item.createdAt]),
      findings: findings.map((item) => [item.id, item.status]),
      requirements: requirements.map((item) => [item.key, item.status, item.evidenceIds])
    })).digest("hex");
    return { fingerprint, evidenceCount: evidence.length, findingCount: findings.length };
  }
}

function readCheckpoint(run: CampaignRun, waveId?: string): CampaignCheckpoint | undefined {
  const value = run.metadata.checkpoint;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!["continue", "waiting", "blocked", "complete"].includes(item.status as string) || typeof item.summary !== "string") return undefined;
  if (waveId && item.waveId !== waveId) return undefined;
  return {
    status: item.status as CampaignCheckpoint["status"],
    summary: item.summary,
    ...(typeof item.blocker === "string" ? { blocker: item.blocker } : {}),
    ...(Array.isArray(item.evidenceIds) ? { evidenceIds: item.evidenceIds.map(String) } : {}),
    ...(typeof item.waveId === "string" ? { waveId: item.waveId } : {})
  };
}
