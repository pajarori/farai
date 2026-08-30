import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import type {
  BackgroundJob,
  Campaign,
  CampaignAsset,
  CampaignDossier,
  CampaignHypothesis,
  CampaignObservation,
  CampaignSearchResult,
  TestAttempt,
  CompactionBoundary,
  Evidence,
  Finding,
  Message,
  MessageRole,
  MessageWithParts,
  MemoryItem,
  Note,
  OutputArtifact,
  Part,
  PartType,
  Session,
  SessionEvent,
  SessionMailboxItem,
  TodoItem,
  TodoStatus,
  Turn,
  TurnStopReason,
  TurnStatus,
  ToolCallRecord,
  UsageRecord,
  UsageSummary
} from "../types";
import { id, nowIso } from "../utils";
import { canonicalToolName } from "../tool-names";
import { DEFAULT_SESSION_TITLE, sessionDisplayName } from "../session-title";

type Row = Record<string, unknown>;
type BackgroundToolSettlementInput = {
  sessionId: string;
  status: "done" | "error";
  processId?: string;
  toolCallId?: string;
  jobId?: string;
  outputArtifactId?: string;
};
type BackgroundToolSettlement = { toolCall: ToolCallRecord; timelinePart?: Part };

const RESUMABLE_SESSION_PREDICATE = `(
  s.summary is not null
  or exists (select 1 from turns where session_id = s.id)
  or exists (select 1 from messages where session_id = s.id)
  or exists (select 1 from tool_calls where session_id = s.id)
  or exists (select 1 from background_jobs where session_id = s.id)
  or exists (select 1 from session_mailbox where session_id = s.id)
  or exists (select 1 from evidence where session_id = s.id)
  or exists (select 1 from notes where session_id = s.id)
  or exists (select 1 from findings where session_id = s.id)
  or exists (select 1 from usage where session_id = s.id)
  or exists (select 1 from compaction_boundaries where session_id = s.id)
  or exists (select 1 from memory_items where session_id = s.id)
  or exists (select 1 from todos where session_id = s.id)
  or exists (select 1 from output_artifacts where session_id = s.id)
)`;

export type StoreChange =
  | { kind: "event"; sessionId: string; event: SessionEvent }
  | { kind: "transientEvent"; sessionId: string; event: SessionEvent }
  | { kind: "part"; sessionId: string; part: Part }
  | { kind: "message"; sessionId: string; message: Message }
  | { kind: "toolCall"; sessionId: string; toolCall: ToolCallRecord }
  | { kind: "evidence"; sessionId: string; evidence: Evidence }
  | { kind: "finding"; sessionId: string; finding: Finding }
  | { kind: "memory"; sessionId: string; item: MemoryItem }
  | { kind: "todo"; sessionId: string; todo: TodoItem }
  | { kind: "note"; sessionId: string; note: Note }
  | { kind: "job"; sessionId: string; job: BackgroundJob }
  | { kind: "turn"; sessionId: string; turn: Turn }
  | { kind: "session"; sessionId: string; session: Session };

export type StoreSubscriber = (change: StoreChange) => void;
type Subscription = { sessionId: string | "*"; cb: StoreSubscriber };

export class SqliteStore {
  private db: Database | undefined;
  private closed = false;
  private readonly subscribers = new Set<Subscription>();

  constructor(private readonly root: string) {}

  subscribe(sessionId: string | "*", cb: StoreSubscriber): () => void {
    const entry: Subscription = { sessionId, cb };
    this.subscribers.add(entry);
    return () => { this.subscribers.delete(entry); };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.subscribers.clear();
    this.db?.close();
    this.db = undefined;
  }

  isOpen(): boolean {
    return this.db !== undefined;
  }

  private emit(change: StoreChange): void {
    if (this.subscribers.size === 0) return;
    for (const sub of this.subscribers) {
      if (sub.sessionId !== "*" && sub.sessionId !== change.sessionId) continue;
      try { sub.cb(change); } catch {  }
    }
  }

  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(join(this.root, "evidence"), { recursive: true });
    await mkdir(join(this.root, "artifacts"), { recursive: true });
    this.database();
  }

  database(): Database {
    if (this.closed) throw new Error("SQLite store is closed");
    if (this.db) return this.db;
    const file = join(this.root, "farai.db");
    this.db = new Database(file, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate(this.db);
    return this.db;
  }

  async createSession(options: Partial<Pick<Session, "title" | "parentId" | "provider" | "model" | "summary" | "summaryUpdatedAt" | "campaignId">> & { workspace?: string } = {}): Promise<Session> {
    await this.ensure();
    const session: Session = {
      id: id(),
      workspace: options.workspace ?? process.cwd(),
      mode: "freestyle",
      phase: "understand_goal",
      title: options.title ?? DEFAULT_SESSION_TITLE,
      ...(options.parentId ? { parentId: options.parentId } : {}),
      ...(options.campaignId ? { campaignId: options.campaignId } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.summary ? { summary: options.summary } : {}),
      ...(options.summaryUpdatedAt ? { summaryUpdatedAt: options.summaryUpdatedAt } : {}),
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    this.upsertSession(session);
    this.appendEvent({
      id: id(),
      sessionId: session.id,
      type: "phase_change",
      payload: { phase: session.phase },
      createdAt: nowIso()
    });
    this.emit({ kind: "session", sessionId: session.id, session });
    return session;
  }

  upsertSession(session: Session): void {
    this.database()
      .query(
        `insert into sessions (id, workspace, mode, phase, title, parent_id, campaign_id, provider, model, summary, summary_updated_at, tool_scope_json, archived_at, created_at, updated_at)
         values ($id, $workspace, $mode, $phase, $title, $parent, $campaign, $provider, $model, $summary, $summaryUpdated, $toolScope, $archived, $created, $updated)
         on conflict(id) do update set
           workspace = excluded.workspace,
           mode = excluded.mode,
           phase = excluded.phase,
           title = excluded.title,
           parent_id = excluded.parent_id,
           campaign_id = excluded.campaign_id,
           provider = excluded.provider,
           model = excluded.model,
           summary = excluded.summary,
           summary_updated_at = excluded.summary_updated_at,
           tool_scope_json = excluded.tool_scope_json,
           archived_at = excluded.archived_at,
           updated_at = excluded.updated_at`
      )
      .run({
        $id: session.id,
        $workspace: session.workspace,
        $mode: session.mode,
        $phase: session.phase,
        $title: session.title ?? null,
        $parent: session.parentId ?? null,
        $campaign: session.campaignId ?? null,
        $provider: session.provider ?? null,
        $model: session.model ?? null,
        $summary: session.summary ?? null,
        $summaryUpdated: session.summaryUpdatedAt ?? null,
        $toolScope: session.toolScope ? JSON.stringify(session.toolScope.map(canonicalToolName)) : null,
        $archived: session.archivedAt ?? null,
        $created: session.createdAt,
        $updated: session.updatedAt
      });
    this.emit({ kind: "session", sessionId: session.id, session });
  }

  loadSession(sessionId: string): Session {
    const row = this.database().query("select * from sessions where id = $id").get({ $id: sessionId }) as Row | null;
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    return sessionFromRow(row);
  }

  listSessions(limit = 20, options: { includeArchived?: boolean } = {}): Session[] {
    const rows = this.database()
      .query(options.includeArchived
        ? "select * from sessions order by updated_at desc limit $limit"
        : "select * from sessions where archived_at is null order by updated_at desc limit $limit")
      .all({ $limit: limit }) as Row[];
    return rows.map(sessionFromRow);
  }

  listResumableSessions(limit = 20, options: { includeArchived?: boolean } = {}): Session[] {
    const archived = options.includeArchived ? "" : "s.archived_at is null and";
    const rows = this.database()
      .query(`select s.* from sessions s
        where ${archived} ${RESUMABLE_SESSION_PREDICATE}
        order by s.updated_at desc limit $limit`)
      .all({ $limit: limit }) as Row[];
    return rows.map(sessionFromRow);
  }

  isSessionResumable(sessionId: string): boolean {
    const row = this.database()
      .query(`select 1 as resumable from sessions s where s.id = $session and ${RESUMABLE_SESSION_PREDICATE}`)
      .get({ $session: sessionId }) as Row | null;
    return Boolean(row);
  }

  discardEmptyRootSession(sessionId: string): boolean {
    const db = this.database();
    let discarded = false;
    db.transaction(() => {
      const session = db.query("select id, parent_id from sessions where id = $session")
        .get({ $session: sessionId }) as Row | null;
      if (!session || session.parent_id !== null) return;
      const child = db.query("select 1 from sessions where parent_id = $session limit 1")
        .get({ $session: sessionId }) as Row | null;
      if (child) return;
      const resumable = db.query(`select 1 from sessions s where s.id = $session and ${RESUMABLE_SESSION_PREDICATE}`)
        .get({ $session: sessionId }) as Row | null;
      if (resumable) return;
      db.query("delete from events where session_id = $session").run({ $session: sessionId });
      const result = db.query("delete from sessions where id = $session").run({ $session: sessionId });
      discarded = result.changes === 1;
    })();
    return discarded;
  }

  updateSession(sessionId: string, patch: Partial<Pick<Session, "campaignId" | "title" | "phase" | "provider" | "model" | "toolScope" | "workspace">>): Session {
    const current = this.loadSession(sessionId);
    const next: Session = {
      ...current,
      ...(patch.campaignId !== undefined ? { campaignId: patch.campaignId } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.toolScope !== undefined ? { toolScope: patch.toolScope.map(canonicalToolName) } : {}),
      ...(patch.workspace !== undefined ? { workspace: patch.workspace } : {}),
      updatedAt: nowIso()
    };
    this.upsertSession(next);
    return next;
  }

  createCampaign(input: Omit<Campaign, "id" | "createdAt" | "updatedAt">): Campaign {
    const now = nowIso();
    const campaign: Campaign = { id: id(), ...input, createdAt: now, updatedAt: now };
    this.database().query(
      `insert into campaigns (id, workspace, name, kind, status, created_at, updated_at)
       values ($id, $workspace, $name, $kind, $status, $created, $updated)`
    ).run({
      $id: campaign.id,
      $workspace: campaign.workspace,
      $name: campaign.name,
      $kind: campaign.kind,
      $status: campaign.status,
      $created: campaign.createdAt,
      $updated: campaign.updatedAt
    });
    return campaign;
  }

  loadCampaign(campaignId: string): Campaign {
    const row = this.database().query("select * from campaigns where id = $id").get({ $id: campaignId }) as Row | null;
    if (!row) throw new Error(`Campaign not found: ${campaignId}`);
    return campaignFromRow(row);
  }

  listCampaigns(workspace: string, limit = 50): Campaign[] {
    const rows = this.database().query("select * from campaigns where workspace = $workspace order by updated_at desc limit $limit")
      .all({ $workspace: workspace, $limit: limit }) as Row[];
    return rows.map(campaignFromRow);
  }

  updateCampaign(campaignId: string, patch: Partial<Pick<Campaign, "name" | "status">>): Campaign {
    const current = this.loadCampaign(campaignId);
    const next: Campaign = { ...current, ...patch, updatedAt: nowIso() };
    this.database().query("update campaigns set name = $name, status = $status, updated_at = $updated where id = $id")
      .run({ $name: next.name, $status: next.status, $updated: next.updatedAt, $id: campaignId });
    return next;
  }

  upsertAsset(input: Omit<CampaignAsset, "id" | "firstSeen" | "lastSeen">): CampaignAsset {
    const existing = this.database().query("select * from campaign_assets where campaign_id = $campaign and canonical = $canonical")
      .get({ $campaign: input.campaignId, $canonical: input.canonical }) as Row | null;
    const now = nowIso();
    const asset: CampaignAsset = existing
      ? { ...campaignAssetFromRow(existing), ...input, id: String(existing.id), firstSeen: String(existing.first_seen), lastSeen: now }
      : { id: id(), ...input, firstSeen: now, lastSeen: now };
    this.database().query(
      `insert into campaign_assets (id, campaign_id, canonical, kind, parent_id, technologies_json, metadata_json, confidence, first_seen, last_seen)
       values ($id, $campaign, $canonical, $kind, $parent, $technologies, $metadata, $confidence, $first, $last)
       on conflict(campaign_id, canonical) do update set kind = excluded.kind, parent_id = excluded.parent_id,
         technologies_json = excluded.technologies_json, metadata_json = excluded.metadata_json,
         confidence = excluded.confidence, last_seen = excluded.last_seen`
    ).run({
      $id: asset.id,
      $campaign: asset.campaignId,
      $canonical: asset.canonical,
      $kind: asset.kind,
      $parent: asset.parentId ?? null,
      $technologies: JSON.stringify(asset.technologies),
      $metadata: JSON.stringify(asset.metadata),
      $confidence: asset.confidence,
      $first: asset.firstSeen,
      $last: asset.lastSeen
    });
    return asset;
  }

  listAssets(campaignId: string): CampaignAsset[] {
    const rows = this.database().query("select * from campaign_assets where campaign_id = $campaign order by last_seen desc")
      .all({ $campaign: campaignId }) as Row[];
    return rows.map(campaignAssetFromRow);
  }

  addObservation(input: Omit<CampaignObservation, "id" | "createdAt" | "updatedAt">): CampaignObservation {
    const now = nowIso();
    const observation: CampaignObservation = { id: id(), ...input, createdAt: now, updatedAt: now };
    this.database().query(
      `insert into campaign_observations (id, campaign_id, asset_id, kind, value_json, confidence, source, evidence_ids_json, status, created_at, updated_at)
       values ($id, $campaign, $asset, $kind, $value, $confidence, $source, $evidence, $status, $created, $updated)`
    ).run({
      $id: observation.id,
      $campaign: observation.campaignId,
      $asset: observation.assetId ?? null,
      $kind: observation.kind,
      $value: JSON.stringify(observation.value),
      $confidence: observation.confidence,
      $source: observation.source,
      $evidence: JSON.stringify(observation.evidenceIds),
      $status: observation.status,
      $created: now,
      $updated: now
    });
    return observation;
  }

  listObservations(campaignId: string, assetId?: string): CampaignObservation[] {
    const rows = assetId
      ? this.database().query("select * from campaign_observations where campaign_id = $campaign and asset_id = $asset order by updated_at desc").all({ $campaign: campaignId, $asset: assetId }) as Row[]
      : this.database().query("select * from campaign_observations where campaign_id = $campaign order by updated_at desc").all({ $campaign: campaignId }) as Row[];
    return rows.map(campaignObservationFromRow);
  }

  upsertHypothesis(input: Omit<CampaignHypothesis, "id" | "createdAt" | "updatedAt">): CampaignHypothesis {
    const existing = this.database().query("select * from campaign_hypotheses where campaign_id = $campaign and title = $title and ifnull(asset_id, '') = ifnull($asset, '')")
      .get({ $campaign: input.campaignId, $title: input.title, $asset: input.assetId ?? null }) as Row | null;
    const now = nowIso();
    const hypothesis: CampaignHypothesis = existing
      ? { ...campaignHypothesisFromRow(existing), ...input, id: String(existing.id), createdAt: String(existing.created_at), updatedAt: now }
      : { id: id(), ...input, createdAt: now, updatedAt: now };
    this.database().query(
      `insert into campaign_hypotheses (id, campaign_id, asset_id, title, category, status, rationale, next_test, confidence, evidence_ids_json, created_at, updated_at)
       values ($id, $campaign, $asset, $title, $category, $status, $rationale, $next_test, $confidence, $evidence, $created, $updated)
       on conflict(id) do update set asset_id = excluded.asset_id, category = excluded.category, status = excluded.status,
         rationale = excluded.rationale, next_test = excluded.next_test, confidence = excluded.confidence,
         evidence_ids_json = excluded.evidence_ids_json, updated_at = excluded.updated_at`
    ).run({
      $id: hypothesis.id,
      $campaign: hypothesis.campaignId,
      $asset: hypothesis.assetId ?? null,
      $title: hypothesis.title,
      $category: hypothesis.category,
      $status: hypothesis.status,
      $rationale: hypothesis.rationale,
      $next_test: hypothesis.nextTest,
      $confidence: hypothesis.confidence,
      $evidence: JSON.stringify(hypothesis.evidenceIds),
      $created: hypothesis.createdAt,
      $updated: hypothesis.updatedAt
    });
    return hypothesis;
  }

  listHypotheses(campaignId: string, status?: CampaignHypothesis["status"]): CampaignHypothesis[] {
    const rows = status
      ? this.database().query("select * from campaign_hypotheses where campaign_id = $campaign and status = $status order by updated_at desc").all({ $campaign: campaignId, $status: status }) as Row[]
      : this.database().query("select * from campaign_hypotheses where campaign_id = $campaign order by updated_at desc").all({ $campaign: campaignId }) as Row[];
    return rows.map(campaignHypothesisFromRow);
  }

  createTestAttempt(input: Omit<TestAttempt, "id" | "createdAt" | "updatedAt">): TestAttempt {
    const now = nowIso();
    const attempt: TestAttempt = { id: id(), ...input, createdAt: now, updatedAt: now };
    this.database().query(
      `insert into campaign_test_attempts (id, campaign_id, session_id, hypothesis_id, title, target, method, baseline_json, mutation_json, oracle, observed_json, status, evidence_level, evidence_ids_json, created_at, updated_at)
       values ($id, $campaign, $session, $hypothesis, $title, $target, $method, $baseline, $mutation, $oracle, $observed, $status, $level, $evidence, $created, $updated)`
    ).run({
      $id: attempt.id,
      $campaign: attempt.campaignId,
      $session: attempt.sessionId,
      $hypothesis: attempt.hypothesisId ?? null,
      $title: attempt.title,
      $target: attempt.target,
      $method: attempt.method,
      $baseline: JSON.stringify(attempt.baseline),
      $mutation: JSON.stringify(attempt.mutation),
      $oracle: attempt.oracle,
      $observed: attempt.observed === undefined ? null : JSON.stringify(attempt.observed),
      $status: attempt.status,
      $level: attempt.evidenceLevel,
      $evidence: JSON.stringify(attempt.evidenceIds),
      $created: now,
      $updated: now
    });
    return attempt;
  }

  loadTestAttempt(attemptId: string): TestAttempt {
    const row = this.database().query("select * from campaign_test_attempts where id = $id").get({ $id: attemptId }) as Row | null;
    if (!row) throw new Error(`Test attempt not found: ${attemptId}`);
    return testAttemptFromRow(row);
  }

  listTestAttempts(campaignId: string, hypothesisId?: string): TestAttempt[] {
    const rows = hypothesisId
      ? this.database().query("select * from campaign_test_attempts where campaign_id = $campaign and hypothesis_id = $hypothesis order by updated_at desc").all({ $campaign: campaignId, $hypothesis: hypothesisId }) as Row[]
      : this.database().query("select * from campaign_test_attempts where campaign_id = $campaign order by updated_at desc").all({ $campaign: campaignId }) as Row[];
    return rows.map(testAttemptFromRow);
  }

  updateTestAttempt(attemptId: string, patch: Partial<Pick<TestAttempt, "status" | "observed" | "evidenceLevel" | "evidenceIds">>): TestAttempt {
    const current = this.loadTestAttempt(attemptId);
    const next: TestAttempt = { ...current, ...patch, updatedAt: nowIso() };
    this.database().query(
      `update campaign_test_attempts set observed_json = $observed, status = $status, evidence_level = $level, evidence_ids_json = $evidence, updated_at = $updated where id = $id`
    ).run({
      $observed: next.observed === undefined ? null : JSON.stringify(next.observed),
      $status: next.status,
      $level: next.evidenceLevel,
      $evidence: JSON.stringify(next.evidenceIds),
      $updated: next.updatedAt,
      $id: attemptId
    });
    return next;
  }

  searchCampaign(campaignId: string, query: string, limit = 20): CampaignSearchResult[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const needle = `%${normalized}%`;
    const terms = [...new Set(normalized.match(/[a-z0-9_.:\/-]{2,}/g) ?? [])].slice(0, 12);
    const results: CampaignSearchResult[] = [];
    const add = (kind: CampaignSearchResult["kind"], rows: Row[], title: (row: Row) => string, body: (row: Row) => string, createdAt: (row: Row) => string) => {
      for (const row of rows) {
        const itemTitle = title(row);
        const itemBody = body(row);
        const text = `${itemTitle} ${itemBody}`.toLowerCase();
        results.push({ kind, id: String(row.id), title: itemTitle, body: itemBody, score: scoreCampaignMatch(text, normalized, terms), ...(row.asset_id ? { assetId: String(row.asset_id) } : {}), createdAt: createdAt(row) });
      }
    };
    const db = this.database();
    add("asset", db.query("select * from campaign_assets where campaign_id = $campaign and (lower(canonical) like $needle or lower(technologies_json) like $needle or lower(metadata_json) like $needle) limit $limit").all({ $campaign: campaignId, $needle: needle, $limit: limit }) as Row[], (r) => String(r.canonical), (r) => `${r.kind} ${r.technologies_json} ${r.metadata_json}`, (r) => String(r.last_seen));
    add("observation", db.query("select * from campaign_observations where campaign_id = $campaign and (lower(kind) like $needle or lower(value_json) like $needle or lower(source) like $needle) limit $limit").all({ $campaign: campaignId, $needle: needle, $limit: limit }) as Row[], (r) => String(r.kind), (r) => String(r.value_json), (r) => String(r.updated_at));
    add("hypothesis", db.query("select * from campaign_hypotheses where campaign_id = $campaign and (lower(title) like $needle or lower(category) like $needle or lower(rationale) like $needle or lower(next_test) like $needle) limit $limit").all({ $campaign: campaignId, $needle: needle, $limit: limit }) as Row[], (r) => String(r.title), (r) => `${r.category}: ${r.rationale} Next: ${r.next_test}`, (r) => String(r.updated_at));
    add("finding", db.query("select * from findings where session_id in (select id from sessions where campaign_id = $campaign) and (lower(title) like $needle or lower(target) like $needle or lower(impact) like $needle or lower(reproduction) like $needle) limit $limit").all({ $campaign: campaignId, $needle: needle, $limit: limit }) as Row[], (r) => String(r.title), (r) => `${r.target}: ${r.impact} ${r.reproduction}`, (r) => String(r.created_at));
    add("message", db.query("select p.*, m.role from parts p join messages m on m.id = p.message_id join sessions s on s.id = p.session_id where s.campaign_id = $campaign and lower(p.payload_json) like $needle order by p.created_at desc limit $limit").all({ $campaign: campaignId, $needle: needle, $limit: limit }) as Row[], (r) => `${r.role}/${r.type}`, (r) => String(r.payload_json).slice(0, 1200), (r) => String(r.created_at));
    add("message", db.query("select n.* from notes n join sessions s on s.id = n.session_id where s.campaign_id = $campaign and (lower(n.text) like $needle or lower(n.tags_json) like $needle) order by n.created_at desc limit $limit").all({ $campaign: campaignId, $needle: needle, $limit: limit }) as Row[], () => "note", (r) => String(r.text), (r) => String(r.created_at));
    return results.sort((a, b) => b.score - a.score || String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
  }

  campaignDossier(campaignId: string, query = "", limit = 20): CampaignDossier {
    const campaign = this.loadCampaign(campaignId);
    const sessions = this.database().query("select id from sessions where campaign_id = $campaign").all({ $campaign: campaignId }) as Array<{ id: string }>;
    return {
      campaign,
      assets: this.listAssets(campaignId),
      observations: this.listObservations(campaignId),
      hypotheses: this.listHypotheses(campaignId),
      findings: sessions.flatMap((session) => this.listFindings(session.id)),
      recentEvidence: sessions.flatMap((session) => this.listEvidence(session.id)).slice(-20),
      searchMatches: query ? this.searchCampaign(campaignId, query, limit) : []
    };
  }

  archiveSession(sessionId: string): Session {
    this.database()
      .query("update sessions set archived_at = $archived, updated_at = $updated where id = $id")
      .run({ $archived: nowIso(), $updated: nowIso(), $id: sessionId });
    const session = this.loadSession(sessionId);
    this.emit({ kind: "session", sessionId, session });
    return session;
  }

  async forkSession(sessionId: string, title?: string): Promise<Session> {
    const source = this.loadSession(sessionId);
    const options: Partial<Pick<Session, "title" | "parentId" | "campaignId" | "provider" | "model" | "summary" | "summaryUpdatedAt">> = {
      title: title ?? `${sessionDisplayName(source)} fork`,
      parentId: source.id,
      ...(source.campaignId ? { campaignId: source.campaignId } : {})
    };
    if (source.provider) options.provider = source.provider;
    if (source.model) options.model = source.model;
    if (source.summary) options.summary = source.summary;
    if (source.summaryUpdatedAt) options.summaryUpdatedAt = source.summaryUpdatedAt;
    const fork = await this.createSession({ ...options, workspace: source.workspace });
    this.appendEvent({
      id: id(),
      sessionId: fork.id,
      type: "artifact",
      payload: { kind: "session_fork", parentId: source.id },
      createdAt: nowIso()
    });
    return fork;
  }

  publishTransientEvent(event: SessionEvent): void {
    this.emit({ kind: "transientEvent", sessionId: event.sessionId, event });
  }

  appendEvent(event: SessionEvent): SessionEvent {
    const db = this.database();
    const stored = db.transaction(() => {
      const next = db.query("select coalesce(max(sequence), 0) + 1 as sequence from events where session_id = $session")
        .get({ $session: event.sessionId }) as { sequence?: number } | null;
      const persisted: SessionEvent = { ...event, sequence: Number(next?.sequence ?? 1) };
      db.query(
        `insert into events (id, session_id, sequence, type, payload_json, created_at)
         values ($id, $session, $sequence, $type, $payload, $created)`
      ).run({
        $id: persisted.id,
        $session: persisted.sessionId,
        $sequence: persisted.sequence!,
        $type: persisted.type,
        $payload: JSON.stringify(persisted.payload),
        $created: persisted.createdAt
      });
      db.query("update sessions set updated_at = $updated where id = $session").run({
        $updated: persisted.createdAt,
        $session: persisted.sessionId
      });
      return persisted;
    })();
    this.emit({ kind: "event", sessionId: stored.sessionId, event: stored });
    return stored;
  }

  listEvents(sessionId: string, limit = 200): SessionEvent[] {
    const rows = this.database()
      .query(`select * from (
        select * from events where session_id = $session order by sequence desc limit $limit
      ) order by sequence asc`)
      .all({ $session: sessionId, $limit: limit }) as Row[];
    return rows.map(sessionEventFromRow);
  }

  listEventsAfter(sessionId: string, cursor = 0, limit = 200): SessionEvent[] {
    const rows = this.database()
      .query("select * from events where session_id = $session and sequence > $cursor order by sequence asc limit $limit")
      .all({ $session: sessionId, $cursor: cursor, $limit: limit }) as Row[];
    return rows.map(sessionEventFromRow);
  }

  latestEventSequence(sessionId: string): number {
    const row = this.database().query("select coalesce(max(sequence), 0) as sequence from events where session_id = $session")
      .get({ $session: sessionId }) as { sequence?: number } | null;
    return Number(row?.sequence ?? 0);
  }

  createTurn(sessionId: string, userInput: string, runtimeId?: string): Turn {
    const turn: Turn = {
      id: id(),
      sessionId,
      ...(runtimeId ? { runtimeId } : {}),
      status: "running",
      userInput,
      stepCount: 0,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    this.database()
      .query(
        `insert into turns (id, session_id, runtime_id, status, user_input, step_count, created_at, updated_at)
         values ($id, $session, $runtime, $status, $input, $steps, $created, $updated)`
      )
      .run({
        $id: turn.id,
        $session: turn.sessionId,
        $runtime: turn.runtimeId ?? null,
        $status: turn.status,
        $input: turn.userInput,
        $steps: turn.stepCount,
        $created: turn.createdAt,
        $updated: turn.updatedAt
      });
    this.emit({ kind: "turn", sessionId: turn.sessionId, turn });
    return turn;
  }

  updateTurn(turnId: string, patch: Partial<Pick<Turn, "status" | "stepCount" | "stopReason" | "plannerName" | "provider" | "model" | "errorSummary">>): Turn {
    const current = this.loadTurn(turnId);
    const next: Turn = {
      ...current,
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.stepCount !== undefined ? { stepCount: patch.stepCount } : {}),
      ...(patch.stopReason !== undefined ? { stopReason: patch.stopReason } : {}),
      ...(patch.plannerName !== undefined ? { plannerName: patch.plannerName } : {}),
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.errorSummary !== undefined ? { errorSummary: patch.errorSummary } : {}),
      updatedAt: nowIso()
    };
    this.database()
      .query(
        `update turns set status = $status, step_count = $steps, stop_reason = $stop, planner_name = $planner,
         provider = $provider, model = $model, error_summary = $error, updated_at = $updated where id = $id`
      )
      .run({
        $status: next.status,
        $steps: next.stepCount,
        $stop: next.stopReason ?? null,
        $planner: next.plannerName ?? null,
        $provider: next.provider ?? null,
        $model: next.model ?? null,
        $error: next.errorSummary ?? null,
        $updated: next.updatedAt,
        $id: next.id
      });
    this.emit({ kind: "turn", sessionId: next.sessionId, turn: next });
    return next;
  }

  cancelTurn(turnId: string, reason = "cancelled by user"): Turn {
    return this.updateTurn(turnId, { status: "cancelled", stopReason: "cancelled", errorSummary: reason });
  }

  latestCompactionBoundary(sessionId: string): CompactionBoundary | undefined {
    const row = this.database()
      .query("select * from compaction_boundaries where session_id = $session order by rowid desc limit 1")
      .get({ $session: sessionId }) as Row | null;
    return row ? compactionBoundaryFromRow(row) : undefined;
  }

  listCompactionBoundaries(sessionId: string): CompactionBoundary[] {
    return (this.database()
      .query("select * from compaction_boundaries where session_id = $session order by rowid asc")
      .all({ $session: sessionId }) as Row[]).map(compactionBoundaryFromRow);
  }

  maxMessageRowId(sessionId: string): number {
    const row = this.database()
      .query("select max(rowid) as max_rowid from messages where session_id = $session")
      .get({ $session: sessionId }) as { max_rowid?: number | null } | null;
    return Number(row?.max_rowid ?? 0);
  }

  commitCompaction(input: {
    sessionId: string;
    trigger: CompactionBoundary["trigger"];
    summary: string;
    throughMessageRowId: number;
    preCompactTokens?: number;
    postCompactTokens?: number;
    expectedPreviousBoundaryId?: string | null;
  }): CompactionBoundary {
    const db = this.database();
    const createdAt = nowIso();
    const boundary: CompactionBoundary = {
      id: id(),
      sessionId: input.sessionId,
      trigger: input.trigger,
      throughMessageRowId: input.throughMessageRowId,
      summary: input.summary,
      ...(input.preCompactTokens !== undefined ? { preCompactTokens: input.preCompactTokens } : {}),
      ...(input.postCompactTokens !== undefined ? { postCompactTokens: input.postCompactTokens } : {}),
      createdAt
    };
    const event: SessionEvent = {
      id: id(),
      sessionId: input.sessionId,
      type: "compaction",
      payload: {
        boundaryId: boundary.id,
        trigger: boundary.trigger,
        summaryBytes: Buffer.byteLength(boundary.summary, "utf8"),
        ...(boundary.preCompactTokens !== undefined ? { preCompactTokens: boundary.preCompactTokens } : {}),
        ...(boundary.postCompactTokens !== undefined ? { postCompactTokens: boundary.postCompactTokens } : {})
      },
      createdAt
    };
    db.transaction(() => {
      if ("expectedPreviousBoundaryId" in input) {
        const current = db.query("select id from compaction_boundaries where session_id = $session order by rowid desc limit 1")
          .get({ $session: input.sessionId }) as { id?: string } | null;
        const currentId = typeof current?.id === "string" ? current.id : null;
        if (currentId !== input.expectedPreviousBoundaryId) {
          throw new Error(`compaction conflict: expected previous boundary ${input.expectedPreviousBoundaryId ?? "none"}, found ${currentId ?? "none"}`);
        }
      }
      const next = db.query("select coalesce(max(sequence), 0) + 1 as sequence from events where session_id = $session")
        .get({ $session: event.sessionId }) as { sequence?: number } | null;
      event.sequence = Number(next?.sequence ?? 1);
      db.query(`insert into compaction_boundaries
        (id, session_id, trigger, through_message_rowid, summary, pre_compact_tokens, post_compact_tokens, created_at)
        values ($id, $session, $trigger, $through, $summary, $pre, $post, $created)`)
        .run({
          $id: boundary.id,
          $session: boundary.sessionId,
          $trigger: boundary.trigger,
          $through: boundary.throughMessageRowId,
          $summary: boundary.summary,
          $pre: boundary.preCompactTokens ?? null,
          $post: boundary.postCompactTokens ?? null,
          $created: boundary.createdAt
        });
      db.query("update sessions set summary = $summary, summary_updated_at = $created, updated_at = $created where id = $session")
        .run({ $summary: boundary.summary, $created: boundary.createdAt, $session: boundary.sessionId });
      db.query("insert into events (id, session_id, sequence, type, payload_json, created_at) values ($id, $session, $sequence, $type, $payload, $created)")
        .run({ $id: event.id, $session: event.sessionId, $sequence: event.sequence!, $type: event.type, $payload: JSON.stringify(event.payload), $created: event.createdAt });
    })();
    this.emit({ kind: "event", sessionId: event.sessionId, event });
    const session = this.loadSession(input.sessionId);
    this.emit({ kind: "session", sessionId: session.id, session });
    return boundary;
  }

  saveUsage(input: Omit<UsageRecord, "id" | "createdAt">): UsageRecord {
    const record: UsageRecord = { id: id(), createdAt: nowIso(), ...input };
    this.database().query(`insert into usage
      (id, session_id, turn_id, provider, model, input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens, pricing_json, cost, latency_ms, created_at)
      values ($id, $session, $turn, $provider, $model, $input, $output, $cached, $cacheWrite, $pricing, $cost, $latency, $created)`)
      .run({
        $id: record.id,
        $session: record.sessionId,
        $turn: record.turnId ?? null,
        $provider: record.provider,
        $model: record.model,
        $input: record.inputTokens,
        $output: record.outputTokens,
        $cached: record.cachedInputTokens ?? null,
        $cacheWrite: record.cacheWriteInputTokens ?? null,
        $pricing: record.pricing ? JSON.stringify(record.pricing) : null,
        $cost: record.cost,
        $latency: record.latencyMs,
        $created: record.createdAt
      });
    return record;
  }

  latestUsage(sessionId: string, model?: string): UsageRecord | undefined {
    const row = this.database().query(model
      ? "select * from usage where session_id = $session and model = $model order by rowid desc limit 1"
      : "select * from usage where session_id = $session order by rowid desc limit 1")
      .get(model ? { $session: sessionId, $model: model } : { $session: sessionId }) as Row | null;
    return row ? usageFromRow(row) : undefined;
  }

  listUsage(sessionId: string, limit = 100_000): UsageRecord[] {
    const rows = this.database()
      .query(`select * from (
        select rowid as _rowid, * from usage where session_id = $session order by rowid desc limit $limit
      ) order by _rowid asc`)
      .all({ $session: sessionId, $limit: limit }) as Row[];
    return rows.map(usageFromRow);
  }

  usageSummary(sessionId: string, model?: string): UsageSummary {
    const row = this.database().query(model
      ? `select count(*) as requests,
          coalesce(sum(input_tokens), 0) as input_tokens,
          coalesce(sum(output_tokens), 0) as output_tokens,
          coalesce(sum(cached_input_tokens), 0) as cached_input_tokens,
          coalesce(sum(cache_write_input_tokens), 0) as cache_write_input_tokens,
          coalesce(sum(cost), 0) as total_cost,
          coalesce(avg(latency_ms), 0) as average_latency_ms
        from usage where session_id = $session and model = $model`
      : `select count(*) as requests,
          coalesce(sum(input_tokens), 0) as input_tokens,
          coalesce(sum(output_tokens), 0) as output_tokens,
          coalesce(sum(cached_input_tokens), 0) as cached_input_tokens,
          coalesce(sum(cache_write_input_tokens), 0) as cache_write_input_tokens,
          coalesce(sum(cost), 0) as total_cost,
          coalesce(avg(latency_ms), 0) as average_latency_ms
        from usage where session_id = $session`)
      .get(model ? { $session: sessionId, $model: model } : { $session: sessionId }) as Row;
    const inputTokens = Number(row.input_tokens);
    const cachedInputTokens = Number(row.cached_input_tokens);
    return {
      requests: Number(row.requests),
      inputTokens,
      outputTokens: Number(row.output_tokens),
      cachedInputTokens,
      cacheWriteInputTokens: Number(row.cache_write_input_tokens),
      cacheHitRate: inputTokens > 0 ? cachedInputTokens / inputTokens : 0,
      totalCost: Number(row.total_cost),
      averageLatencyMs: Number(row.average_latency_ms)
    };
  }

  usageSummaryTree(rootSessionId: string): UsageSummary {
    const row = this.database().query(`with recursive session_tree(id) as (
        select id from sessions where id = $session
        union all
        select sessions.id from sessions join session_tree on sessions.parent_id = session_tree.id
      )
      select count(*) as requests,
        coalesce(sum(input_tokens), 0) as input_tokens,
        coalesce(sum(output_tokens), 0) as output_tokens,
        coalesce(sum(cached_input_tokens), 0) as cached_input_tokens,
        coalesce(sum(cache_write_input_tokens), 0) as cache_write_input_tokens,
        coalesce(sum(cost), 0) as total_cost,
        coalesce(avg(latency_ms), 0) as average_latency_ms
      from usage join session_tree on usage.session_id = session_tree.id`)
      .get({ $session: rootSessionId }) as Row;
    const inputTokens = Number(row.input_tokens);
    const cachedInputTokens = Number(row.cached_input_tokens);
    return {
      requests: Number(row.requests),
      inputTokens,
      outputTokens: Number(row.output_tokens),
      cachedInputTokens,
      cacheWriteInputTokens: Number(row.cache_write_input_tokens),
      cacheHitRate: inputTokens > 0 ? cachedInputTokens / inputTokens : 0,
      totalCost: Number(row.total_cost),
      averageLatencyMs: Number(row.average_latency_ms)
    };
  }

  clearSessionChat(sessionId: string): Session {
    const db = this.database();
    const updated = nowIso();
    db.transaction(() => {
      db.query("update todos set turn_id = null where session_id = $session").run({ $session: sessionId });
      db.query("update output_artifacts set tool_call_id = null where session_id = $session").run({ $session: sessionId });
      db.query("delete from parts where session_id = $session").run({ $session: sessionId });
      db.query("delete from messages where session_id = $session").run({ $session: sessionId });
      db.query("delete from turns where session_id = $session").run({ $session: sessionId });
      db.query("delete from tool_calls where session_id = $session").run({ $session: sessionId });
      db.query("delete from session_mailbox where session_id = $session").run({ $session: sessionId });
      db.query("delete from background_jobs where session_id = $session").run({ $session: sessionId });
      db.query("delete from events where session_id = $session").run({ $session: sessionId });
      db.query("delete from compaction_boundaries where session_id = $session").run({ $session: sessionId });
      db.query("update sessions set summary = null, summary_updated_at = null, updated_at = $updated where id = $session")
        .run({ $updated: updated, $session: sessionId });
    })();
    const session = this.loadSession(sessionId);
    this.emit({ kind: "session", sessionId, session });
    return session;
  }

  loadTurn(turnId: string): Turn {
    const row = this.database().query("select * from turns where id = $id").get({ $id: turnId }) as Row | null;
    if (!row) throw new Error(`Turn not found: ${turnId}`);
    return turnFromRow(row);
  }

  listTurns(sessionId: string, limit = 50): Turn[] {
    const rows = this.database()
      .query(`select * from (
        select rowid as _rowid, * from turns where session_id = $session order by rowid desc limit $limit
      ) order by _rowid asc`)
      .all({ $session: sessionId, $limit: limit }) as Row[];
    return rows.map(turnFromRow);
  }

  createMessage(input: { sessionId: string; turnId: string; role: MessageRole }): Message {
    const message: Message = {
      id: id(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      role: input.role,
      createdAt: nowIso()
    };
    this.database()
      .query(
        `insert into messages (id, session_id, turn_id, role, created_at)
         values ($id, $session, $turn, $role, $created)`
      )
      .run({
        $id: message.id,
        $session: message.sessionId,
        $turn: message.turnId,
        $role: message.role,
        $created: message.createdAt
      });
    this.emit({ kind: "message", sessionId: message.sessionId, message });
    return message;
  }

  addPart(input: {
    sessionId: string;
    turnId: string;
    messageId: string;
    type: PartType;
    payload: unknown;
  }): Part {
    const max = this.database()
      .query("select max(order_index) as max_order from parts where message_id = $message")
      .get({ $message: input.messageId }) as { max_order?: number | null } | null;
    const part: Part = {
      id: id(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      messageId: input.messageId,
      type: input.type,
      payload: input.payload,
      order: (max?.max_order ?? -1) + 1,
      createdAt: nowIso()
    };
    this.database()
      .query(
        `insert into parts (id, session_id, turn_id, message_id, type, payload_json, order_index, created_at)
         values ($id, $session, $turn, $message, $type, $payload, $order, $created)`
      )
      .run({
        $id: part.id,
        $session: part.sessionId,
        $turn: part.turnId,
        $message: part.messageId,
        $type: part.type,
        $payload: JSON.stringify(part.payload),
        $order: part.order,
        $created: part.createdAt
      });
    this.emit({ kind: "part", sessionId: part.sessionId, part });
    return part;
  }

  updatePartPayload(partId: string, payload: unknown): Part {
    this.database().query("update parts set payload_json = $payload where id = $id").run({
      $id: partId,
      $payload: JSON.stringify(payload)
    });
    const row = this.database().query("select * from parts where id = $id").get({ $id: partId }) as Row | null;
    if (!row) throw new Error(`Part not found: ${partId}`);
    const part = partFromRow(row);
    this.emit({ kind: "part", sessionId: part.sessionId, part });
    return part;
  }

  listMessages(sessionId: string, limit = 100): MessageWithParts[] {
    const rows = this.database()
      .query(
        `select * from (
           select rowid as _rowid, * from messages
           where session_id = $session
           order by rowid desc
           limit $limit
         ) order by _rowid asc`
      )
      .all({ $session: sessionId, $limit: limit }) as Row[];
    return this.hydrateMessages(rows);
  }

  sessionEntityCounts(sessionId: string): Record<"messages" | "todos" | "notes" | "memory" | "evidence" | "findings" | "toolCalls", number> {
    const row = this.database().query(`select
      (select count(*) from messages where session_id = $session) as messages,
      (select count(*) from todos where session_id = $session) as todos,
      (select count(*) from notes where session_id = $session) as notes,
      (select count(*) from memory_items where session_id = $session) as memory,
      (select count(*) from evidence where session_id = $session) as evidence,
      (select count(*) from findings where session_id = $session) as findings,
      (select count(*) from tool_calls where session_id = $session) as tool_calls
    `).get({ $session: sessionId }) as Row | null;
    return {
      messages: Number(row?.messages ?? 0),
      todos: Number(row?.todos ?? 0),
      notes: Number(row?.notes ?? 0),
      memory: Number(row?.memory ?? 0),
      evidence: Number(row?.evidence ?? 0),
      findings: Number(row?.findings ?? 0),
      toolCalls: Number(row?.tool_calls ?? 0)
    };
  }

  listPartsByType(sessionId: string, type: PartType, limit = 20): Part[] {
    const rows = this.database()
      .query(
        `select * from (
           select rowid as _rowid, * from parts
           where session_id = $session and type = $type
           order by rowid desc
           limit $limit
         ) order by _rowid asc`
      )
      .all({ $session: sessionId, $type: type, $limit: limit }) as Row[];
    return rows.map(partFromRow);
  }

  listContextMessages(sessionId: string, limit = 1000): MessageWithParts[] {
    const boundary = this.latestCompactionBoundary(sessionId);
    if (boundary) {
      const rows = this.database()
        .query(`select rowid as _rowid, * from messages
          where session_id = $session and rowid > $through
          order by rowid asc limit $limit`)
        .all({ $session: sessionId, $through: boundary.throughMessageRowId, $limit: limit }) as Row[];
      return this.hydrateMessages(rows);
    }
    const session = this.loadSession(sessionId);
    if (!session.summaryUpdatedAt) return this.listMessages(sessionId, limit);
    const rows = this.database()
      .query(`select rowid as _rowid, * from messages
        where session_id = $session and created_at >= $watermark
        order by rowid asc limit $limit`)
      .all({ $session: sessionId, $watermark: session.summaryUpdatedAt, $limit: limit }) as Row[];
    return this.hydrateMessages(rows);
  }

  listMessagesBetweenRows(sessionId: string, afterRowId: number, throughRowId: number, limit = 1000): MessageWithParts[] {
    if (throughRowId <= afterRowId) return [];
    const rows = this.database()
      .query(`select rowid as _rowid, * from messages
        where session_id = $session and rowid > $after and rowid <= $through
        order by rowid asc limit $limit`)
      .all({ $session: sessionId, $after: afterRowId, $through: throughRowId, $limit: limit }) as Row[];
    return this.hydrateMessages(rows);
  }

  listVisibleMessages(sessionId: string, limit = 200): MessageWithParts[] {
    const boundary = this.latestCompactionBoundary(sessionId);
    if (boundary) {
      const rows = this.database()
        .query(`select * from (
          select rowid as _rowid, * from messages
          where session_id = $session and rowid > $through
          order by rowid desc limit $limit
        ) order by _rowid asc`)
        .all({ $session: sessionId, $through: boundary.throughMessageRowId, $limit: limit }) as Row[];
      return this.hydrateMessages(rows);
    }
    const session = this.loadSession(sessionId);
    if (!session.summaryUpdatedAt) return this.listMessages(sessionId, limit);
    const rows = this.database()
      .query(`select * from (
        select rowid as _rowid, * from messages
        where session_id = $session and created_at >= $watermark
        order by rowid desc limit $limit
      ) order by _rowid asc`)
      .all({ $session: sessionId, $watermark: session.summaryUpdatedAt, $limit: limit }) as Row[];
    return this.hydrateMessages(rows);
  }

  private hydrateMessages(rows: Row[]): MessageWithParts[] {
    if (rows.length === 0) return [];
    const messages = rows.map(messageFromRow);
    const partsByMessage = new Map(messages.map((message) => [message.id, [] as Part[]]));
    const batchSize = 400;
    for (let offset = 0; offset < messages.length; offset += batchSize) {
      const batch = messages.slice(offset, offset + batchSize);
      const params: Record<string, string> = {};
      const placeholders = batch.map((message, index) => {
        const key = `$message${index}`;
        params[key] = message.id;
        return key;
      });
      const partRows = this.database()
        .query(`select * from parts where message_id in (${placeholders.join(", ")}) order by message_id asc, order_index asc`)
        .all(params) as Row[];
      for (const row of partRows) {
        const part = partFromRow(row);
        partsByMessage.get(part.messageId)?.push(part);
      }
    }
    return messages.map((message) => ({ ...message, parts: partsByMessage.get(message.id) ?? [] }));
  }

  saveJob(job: BackgroundJob): BackgroundJob {
    writeJobRow(this.database(), job);
    this.emit({ kind: "job", sessionId: job.sessionId, job });
    return job;
  }

  loadJob(jobId: string): BackgroundJob {
    const row = this.database().query("select * from background_jobs where id = $id").get({ $id: jobId }) as Row | null;
    if (!row) throw new Error(`Background job not found: ${jobId}`);
    return backgroundJobFromRow(row);
  }

  findJobByProcessId(processId: string): BackgroundJob | undefined {
    const row = this.database().query("select * from background_jobs where process_id = $process order by rowid desc limit 1")
      .get({ $process: processId }) as Row | null;
    return row ? backgroundJobFromRow(row) : undefined;
  }

  listJobs(sessionId: string, limit = 100): BackgroundJob[] {
    const rows = this.database().query("select * from background_jobs where session_id = $session order by rowid desc limit $limit")
      .all({ $session: sessionId, $limit: limit }) as Row[];
    return rows.map(backgroundJobFromRow);
  }

  findAgentJobByChildSessionId(childSessionId: string): BackgroundJob | undefined {
    const row = this.database().query("select * from background_jobs where kind = 'agent' and child_session_id = $child order by rowid desc limit 1")
      .get({ $child: childSessionId }) as Row | null;
    return row ? backgroundJobFromRow(row) : undefined;
  }

  listRecoverableJobs(limit = 10_000): BackgroundJob[] {
    const rows = this.database().query("select * from background_jobs where status in ('created', 'starting', 'running', 'cancelling') order by rowid asc limit $limit")
      .all({ $limit: limit }) as Row[];
    return rows.map(backgroundJobFromRow);
  }

  listTerminalJobsMissingMailbox(limit = 10_000): BackgroundJob[] {
    const rows = this.database().query("select * from background_jobs where status in ('succeeded', 'failed', 'cancelled', 'lost') and mailbox_id is null and delivery_state != 'suppressed' order by rowid asc limit $limit")
      .all({ $limit: limit }) as Row[];
    return rows.map(backgroundJobFromRow);
  }

  reclaimMailboxClaims(activeOwners: string[]): number {
    const rows = this.database().query("select id, lease_owner, lease_expires_at from session_mailbox where state = 'claimed'").all() as Array<{ id: string; lease_owner?: string | null; lease_expires_at?: string | null }>;
    const active = new Set(activeOwners);
    const now = Date.now();
    const update = this.database().query("update session_mailbox set state = 'queued', lease_owner = null, lease_expires_at = null, claimed_at = null where id = $id and state = 'claimed'");
    let count = 0;
    this.database().transaction(() => {
      for (const row of rows) {
        const expired = !row.lease_expires_at || Date.parse(row.lease_expires_at) <= now;
        const abandoned = !row.lease_owner || !active.has(row.lease_owner);
        if (!expired && !abandoned) continue;
        update.run({ $id: row.id });
        count += 1;
      }
    })();
    return count;
  }

  listJobsByRuntime(runtimeId: string, limit = 10_000): BackgroundJob[] {
    const rows = this.database().query("select * from background_jobs where runtime_id = $runtime order by rowid asc limit $limit")
      .all({ $runtime: runtimeId, $limit: limit }) as Row[];
    return rows.map(backgroundJobFromRow);
  }

  renewRuntimeLease(runtimeId: string, leaseMs = 60_000): void {
    const heartbeatAt = nowIso();
    const expiresAt = new Date(Date.now() + Math.max(1_000, leaseMs)).toISOString();
    this.database().query(
      `insert into runtime_leases (runtime_id, process_id, started_at, heartbeat_at, expires_at)
       values ($runtime, $process, $started, $heartbeat, $expires)
       on conflict(runtime_id) do update set process_id = excluded.process_id, heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at`
    ).run({
      $runtime: runtimeId,
      $process: process.pid,
      $started: heartbeatAt,
      $heartbeat: heartbeatAt,
      $expires: expiresAt
    });
  }

  releaseRuntimeLease(runtimeId: string): void {
    this.database().query("delete from runtime_leases where runtime_id = $runtime").run({ $runtime: runtimeId });
  }

  listActiveRuntimeIds(at = new Date()): string[] {
    const timestamp = at.toISOString();
    const db = this.database();
    return db.transaction(() => {
      db.query("delete from runtime_leases where expires_at <= $now").run({ $now: timestamp });
      const rows = db.query("select runtime_id from runtime_leases where expires_at > $now order by runtime_id asc")
        .all({ $now: timestamp }) as Array<{ runtime_id: string }>;
      return rows.map((row) => row.runtime_id);
    })();
  }

  listSessionsWithQueuedMailbox(): string[] {
    const rows = this.database().query("select distinct session_id from session_mailbox where state = 'queued' and trigger_policy in ('wake', 'queue', 'interrupt', 'context') order by session_id asc")
      .all() as Array<{ session_id: string }>;
    return rows.map((row) => String(row.session_id));
  }

  enqueueMailbox(input: Omit<SessionMailboxItem, "id" | "sequence" | "state" | "createdAt">): SessionMailboxItem {
    const db = this.database();
    const existing = db.query("select * from session_mailbox where session_id = $session and dedupe_key = $dedupe")
      .get({ $session: input.sessionId, $dedupe: input.dedupeKey }) as Row | null;
    if (existing) return mailboxItemFromRow(existing);
    const next = db.query("select coalesce(max(sequence), 0) + 1 as sequence from session_mailbox where session_id = $session")
      .get({ $session: input.sessionId }) as { sequence?: number } | null;
    const item: SessionMailboxItem = {
      id: id(),
      sessionId: input.sessionId,
      sequence: Number(next?.sequence ?? 1),
      kind: input.kind,
      payload: input.payload,
      triggerPolicy: input.triggerPolicy,
      state: "queued",
      dedupeKey: input.dedupeKey,
      ...(input.leaseOwner ? { leaseOwner: input.leaseOwner } : {}),
      ...(input.leaseExpiresAt ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
      ...(input.claimedAt ? { claimedAt: input.claimedAt } : {}),
      ...(input.consumedAt ? { consumedAt: input.consumedAt } : {}),
      createdAt: nowIso()
    };
    db.query(`insert into session_mailbox
      (id, session_id, sequence, kind, payload_json, trigger_policy, state, dedupe_key, lease_owner, lease_expires_at, created_at, claimed_at, consumed_at)
      values ($id, $session, $sequence, $kind, $payload, $trigger, $state, $dedupe, $leaseOwner, $leaseExpires, $created, $claimed, $consumed)`)
      .run({
        $id: item.id,
        $session: item.sessionId,
        $sequence: item.sequence,
        $kind: item.kind,
        $payload: JSON.stringify(item.payload),
        $trigger: item.triggerPolicy,
        $state: item.state,
        $dedupe: item.dedupeKey,
        $leaseOwner: item.leaseOwner ?? null,
        $leaseExpires: item.leaseExpiresAt ?? null,
        $created: item.createdAt,
        $claimed: item.claimedAt ?? null,
        $consumed: item.consumedAt ?? null
      });
    return item;
  }

  listMailbox(sessionId: string, state?: SessionMailboxItem["state"]): SessionMailboxItem[] {
    const rows = state
      ? this.database().query("select * from session_mailbox where session_id = $session and state = $state order by sequence asc")
          .all({ $session: sessionId, $state: state }) as Row[]
      : this.database().query("select * from session_mailbox where session_id = $session order by sequence asc")
          .all({ $session: sessionId }) as Row[];
    return rows.map(mailboxItemFromRow);
  }

  hasQueuedMailbox(sessionId: string, triggerPolicy?: SessionMailboxItem["triggerPolicy"]): boolean {
    const row = triggerPolicy
      ? this.database().query("select 1 from session_mailbox where session_id = $session and state = 'queued' and trigger_policy = $trigger limit 1")
          .get({ $session: sessionId, $trigger: triggerPolicy })
      : this.database().query("select 1 from session_mailbox where session_id = $session and state = 'queued' limit 1")
          .get({ $session: sessionId });
    return Boolean(row);
  }

  claimMailbox(
    sessionId: string,
    leaseOwner: string,
    leaseMs = 30_000,
    triggerPolicy?: SessionMailboxItem["triggerPolicy"],
    limit = 10_000
  ): SessionMailboxItem[] {
    const db = this.database();
    const now = nowIso();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    return db.transaction(() => {
      const rows = triggerPolicy
        ? db.query("select * from session_mailbox where session_id = $session and state = 'queued' and trigger_policy = $trigger order by sequence asc limit $limit")
            .all({ $session: sessionId, $trigger: triggerPolicy, $limit: Math.max(1, limit) }) as Row[]
        : db.query("select * from session_mailbox where session_id = $session and state = 'queued' order by sequence asc limit $limit")
            .all({ $session: sessionId, $limit: Math.max(1, limit) }) as Row[];
      for (const row of rows) {
        db.query("update session_mailbox set state = 'claimed', lease_owner = $owner, lease_expires_at = $expires, claimed_at = $claimed where id = $id and state = 'queued'")
          .run({ $owner: leaseOwner, $expires: leaseExpiresAt, $claimed: now, $id: String(row.id) });
      }
      return rows.map((row) => mailboxItemFromRow({ ...row, state: "claimed", lease_owner: leaseOwner, lease_expires_at: leaseExpiresAt, claimed_at: now }));
    })();
  }

  claimMailboxItem(id: string, leaseOwner: string, leaseMs = 30_000): SessionMailboxItem | undefined {
    const db = this.database();
    const now = nowIso();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    return db.transaction(() => {
      const row = db.query("select * from session_mailbox where id = $id and state = 'queued'").get({ $id: id }) as Row | null;
      if (!row) return undefined;
      db.query("update session_mailbox set state = 'claimed', lease_owner = $owner, lease_expires_at = $expires, claimed_at = $claimed where id = $id and state = 'queued'")
        .run({ $owner: leaseOwner, $expires: leaseExpiresAt, $claimed: now, $id: id });
      return mailboxItemFromRow({ ...row, state: "claimed", lease_owner: leaseOwner, lease_expires_at: leaseExpiresAt, claimed_at: now });
    })();
  }

  consumeMailbox(ids: string[], leaseOwner?: string): void {
    if (ids.length === 0) return;
    const consumedAt = nowIso();
    const update = leaseOwner
      ? this.database().query("update session_mailbox set state = 'consumed', consumed_at = $consumed, lease_owner = null, lease_expires_at = null where id = $id and state = 'claimed' and lease_owner = $owner")
      : this.database().query("update session_mailbox set state = 'consumed', consumed_at = $consumed, lease_owner = null, lease_expires_at = null where id = $id and state = 'claimed'");
    const updateJob = this.database().query("update background_jobs set delivery_state = 'consumed', updated_at = $updated where mailbox_id = $id");
    this.database().transaction(() => {
      for (const id of ids) {
        const changed = update.run({ $consumed: consumedAt, $id: id, $owner: leaseOwner ?? null }).changes;
        if (changed > 0) updateJob.run({ $updated: consumedAt, $id: id });
      }
    })();
  }

  releaseMailbox(ids: string[], leaseOwner?: string): void {
    if (ids.length === 0) return;
    const update = leaseOwner
      ? this.database().query("update session_mailbox set state = 'queued', lease_owner = null, lease_expires_at = null, claimed_at = null where id = $id and state = 'claimed' and lease_owner = $owner")
      : this.database().query("update session_mailbox set state = 'queued', lease_owner = null, lease_expires_at = null, claimed_at = null where id = $id and state = 'claimed'");
    this.database().transaction(() => {
      for (const id of ids) update.run({ $id: id, $owner: leaseOwner ?? null });
    })();
  }

  cancelMailbox(sessionId: string): void {
    this.database().query("update session_mailbox set state = 'cancelled', lease_owner = null, lease_expires_at = null where session_id = $session and state in ('queued', 'claimed')")
      .run({ $session: sessionId });
  }

  cancelMailboxItem(id: string): boolean {
    const result = this.database().query("update session_mailbox set state = 'cancelled', lease_owner = null, lease_expires_at = null where id = $id and state = 'queued'")
      .run({ $id: id });
    return result.changes > 0;
  }

  finalizeJobWithMailbox(input: {
    jobId: string;
    status: Extract<BackgroundJob["status"], "succeeded" | "failed" | "cancelled" | "lost">;
    result?: unknown;
    error?: string;
    outputArtifactId?: string;
    settleToolStatus?: "done" | "error";
    mailbox: Omit<SessionMailboxItem, "id" | "sequence" | "state" | "createdAt">;
  }): { job: BackgroundJob; mailbox: SessionMailboxItem; toolCalls: ToolCallRecord[] } {
    const db = this.database();
    const finalized = db.transaction(() => {
      const current = this.loadJob(input.jobId);
      if (["succeeded", "failed", "cancelled", "lost"].includes(current.status) && current.mailboxId) {
        const row = db.query("select * from session_mailbox where id = $id").get({ $id: current.mailboxId }) as Row | null;
        if (row) {
          const toolCalls = input.settleToolStatus
            ? settleBackgroundToolCallRows(db, {
                sessionId: current.sessionId,
                status: input.settleToolStatus,
                ...(current.processId ? { processId: current.processId } : {}),
                ...(current.toolCallId ? { toolCallId: current.toolCallId } : {}),
                jobId: current.id,
                ...(current.outputArtifactId ? { outputArtifactId: current.outputArtifactId } : {})
              })
            : [];
          return { job: current, mailbox: mailboxItemFromRow(row), toolCalls, jobChanged: false };
        }
      }
      const mailbox = this.enqueueMailbox(input.mailbox);
      const completedAt = nowIso();
      const job: BackgroundJob = {
        ...current,
        status: input.status,
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.outputArtifactId !== undefined ? { outputArtifactId: input.outputArtifactId } : {}),
        mailboxId: mailbox.id,
        deliveryState: "enqueued",
        completedAt,
        updatedAt: completedAt
      };
      writeJobRow(db, job);
      const toolCalls = input.settleToolStatus
        ? settleBackgroundToolCallRows(db, {
            sessionId: job.sessionId,
            status: input.settleToolStatus,
            ...(job.processId ? { processId: job.processId } : {}),
            ...(job.toolCallId ? { toolCallId: job.toolCallId } : {}),
            jobId: job.id,
            ...(input.outputArtifactId ? { outputArtifactId: input.outputArtifactId } : {})
          })
        : [];
      return { job, mailbox, toolCalls, jobChanged: true };
    })();
    if (finalized.jobChanged) this.emit({ kind: "job", sessionId: finalized.job.sessionId, job: finalized.job });
    for (const item of finalized.toolCalls) {
      this.emit({ kind: "toolCall", sessionId: item.toolCall.sessionId, toolCall: item.toolCall });
      if (item.timelinePart) this.emit({ kind: "part", sessionId: item.timelinePart.sessionId, part: item.timelinePart });
    }
    return { job: finalized.job, mailbox: finalized.mailbox, toolCalls: finalized.toolCalls.map((item) => item.toolCall) };
  }

  finalizeJobWithoutMailbox(input: {
    jobId: string;
    status: Extract<BackgroundJob["status"], "succeeded" | "failed" | "cancelled" | "lost">;
    result?: unknown;
    error?: string;
    outputArtifactId?: string;
    settleToolStatus?: "done" | "error";
    deliveryState: "suppressed";
  }): { job: BackgroundJob; toolCalls: ToolCallRecord[] } {
    const db = this.database();
    const finalized = db.transaction(() => {
      const current = this.loadJob(input.jobId);
      const completedAt = nowIso();
      const job: BackgroundJob = {
        ...current,
        status: input.status,
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.outputArtifactId !== undefined ? { outputArtifactId: input.outputArtifactId } : {}),
        deliveryState: input.deliveryState,
        completedAt,
        updatedAt: completedAt
      };
      writeJobRow(db, job);
      const toolCalls = input.settleToolStatus
        ? settleBackgroundToolCallRows(db, {
            sessionId: job.sessionId,
            status: input.settleToolStatus,
            ...(job.processId ? { processId: job.processId } : {}),
            ...(job.toolCallId ? { toolCallId: job.toolCallId } : {}),
            jobId: job.id,
            ...(input.outputArtifactId ? { outputArtifactId: input.outputArtifactId } : {})
          })
        : [];
      return { job, toolCalls };
    })();
    this.emit({ kind: "job", sessionId: finalized.job.sessionId, job: finalized.job });
    for (const item of finalized.toolCalls) {
      this.emit({ kind: "toolCall", sessionId: item.toolCall.sessionId, toolCall: item.toolCall });
      if (item.timelinePart) this.emit({ kind: "part", sessionId: item.timelinePart.sessionId, part: item.timelinePart });
    }
    return { job: finalized.job, toolCalls: finalized.toolCalls.map((item) => item.toolCall) };
  }

  saveToolCall(record: ToolCallRecord): void {
    const canonicalRecord = { ...record, tool: canonicalToolName(record.tool) };
    writeToolCallRow(this.database(), canonicalRecord);
    this.emit({ kind: "toolCall", sessionId: canonicalRecord.sessionId, toolCall: canonicalRecord });
  }

  settleToolCall(
    record: ToolCallRecord,
    terminal?: { type: "tool_result" | "error"; payload: unknown }
  ): { toolCall: ToolCallRecord; timelinePart?: Part; terminalPart?: Part } {
    const canonicalRecord = { ...record, tool: canonicalToolName(record.tool) };
    const db = this.database();
    const settled = db.transaction(() => {
      writeToolCallRow(db, canonicalRecord);
      const timelinePart = syncToolCallTimelineRow(db, canonicalRecord);
      const terminalPart = terminal && canonicalRecord.turnId && canonicalRecord.messageId
        ? ensureTerminalToolPart(db, canonicalRecord, terminal)
        : undefined;
      return { timelinePart, terminalPart };
    })();
    this.emit({ kind: "toolCall", sessionId: canonicalRecord.sessionId, toolCall: canonicalRecord });
    if (settled.timelinePart) this.emit({ kind: "part", sessionId: settled.timelinePart.sessionId, part: settled.timelinePart });
    if (settled.terminalPart?.inserted || settled.terminalPart?.updated) this.emit({ kind: "part", sessionId: settled.terminalPart.part.sessionId, part: settled.terminalPart.part });
    return {
      toolCall: canonicalRecord,
      ...(settled.timelinePart ? { timelinePart: settled.timelinePart } : {}),
      ...(settled.terminalPart ? { terminalPart: settled.terminalPart.part } : {})
    };
  }

  loadToolCall(toolCallId: string): ToolCallRecord {
    const row = this.database().query("select * from tool_calls where id = $id").get({ $id: toolCallId }) as Row | null;
    if (!row) throw new Error(`Tool call not found: ${toolCallId}`);
    return toolCallFromRow(row);
  }

  listToolCalls(sessionId: string, limit = 20): ToolCallRecord[] {
    const rows = this.database()
      .query("select * from tool_calls where session_id = $session order by created_at desc, rowid desc limit $limit")
      .all({ $session: sessionId, $limit: limit }) as Row[];
    return rows.map(toolCallFromRow);
  }

  settleBackgroundToolCalls(input: {
    sessionId: string;
    status: "done" | "error";
    processId?: string;
    toolCallId?: string;
    jobId?: string;
    outputArtifactId?: string;
  }): ToolCallRecord[] {
    if (!input.processId && !input.toolCallId) return [];
    const db = this.database();
    const settled = db.transaction(() => settleBackgroundToolCallRows(db, input))();
    for (const item of settled) {
      this.emit({ kind: "toolCall", sessionId: item.toolCall.sessionId, toolCall: item.toolCall });
      if (item.timelinePart) this.emit({ kind: "part", sessionId: item.timelinePart.sessionId, part: item.timelinePart });
    }
    return settled.map((item) => item.toolCall);
  }

  settleBackgroundProcess(sessionId: string, processId: string, status: "done" | "error"): ToolCallRecord[] {
    return this.settleBackgroundToolCalls({ sessionId, processId, status });
  }

  saveEvidence(evidence: Evidence, content?: string): Evidence {
    let finalEvidence = evidence;
    if (content !== undefined) {
      const file = join(this.root, "evidence", `${evidence.id}.txt`);
      Bun.write(file, content);
      finalEvidence = { ...evidence, path: file };
    }
    this.database()
      .query(
        `insert into evidence (id, session_id, source, title, path, summary, created_at)
         values ($id, $session, $source, $title, $path, $summary, $created)
         on conflict(id) do update set
          session_id = excluded.session_id,
          source = excluded.source,
          title = excluded.title,
          path = excluded.path,
          summary = excluded.summary,
          created_at = excluded.created_at`
      )
      .run({
        $id: finalEvidence.id,
        $session: finalEvidence.sessionId,
        $source: finalEvidence.source,
        $title: finalEvidence.title,
        $path: finalEvidence.path ?? null,
        $summary: finalEvidence.summary,
        $created: finalEvidence.createdAt
      });
    this.emit({ kind: "evidence", sessionId: finalEvidence.sessionId, evidence: finalEvidence });
    return finalEvidence;
  }

  saveOutputArtifact(input: { sessionId: string; toolCallId?: string; content: string }): OutputArtifact {
    const artifact: OutputArtifact = {
      id: id(),
      sessionId: input.sessionId,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      path: join(this.root, "artifacts", `${id()}.txt`),
      bytes: Buffer.byteLength(input.content, "utf8"),
      createdAt: nowIso()
    };
    writeFileSync(artifact.path, input.content);
    this.database()
      .query(
        `insert into output_artifacts (id, session_id, tool_call_id, path, bytes, created_at)
         values ($id, $session, $toolCall, $path, $bytes, $created)`
      )
      .run({
        $id: artifact.id,
        $session: artifact.sessionId,
        $toolCall: artifact.toolCallId ?? null,
        $path: artifact.path,
        $bytes: artifact.bytes,
        $created: artifact.createdAt
      });
    return artifact;
  }

  readOutputArtifact(artifactId: string, options: { offset?: number; limit?: number } = {}): { artifact: OutputArtifact; content: string; totalLines: number; from: number; to: number } | undefined {
    const row = this.database().query("select * from output_artifacts where id = $id").get({ $id: artifactId }) as Row | null;
    if (!row) return undefined;
    const artifact = outputArtifactFromRow(row);
    if (!existsSync(artifact.path)) return undefined;
    const lines = readFileSync(artifact.path, "utf8").split("\n");
    const from = Math.min(Math.max(0, Math.floor(options.offset ?? 0)), lines.length);
    const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : 400;
    const to = Math.min(lines.length, from + limit);
    return { artifact, content: lines.slice(from, to).join("\n"), totalLines: lines.length, from, to };
  }

  listEvidence(sessionId: string): Evidence[] {
    const rows = this.database()
      .query("select * from evidence where session_id = $session order by created_at asc")
      .all({ $session: sessionId }) as Row[];
    return rows.map((row) => {
      const evidence: Evidence = {
        id: String(row.id),
        sessionId: String(row.session_id),
        source: row.source as Evidence["source"],
        title: String(row.title),
        summary: String(row.summary),
        createdAt: String(row.created_at)
      };
      if (typeof row.path === "string") evidence.path = row.path;
      return evidence;
    });
  }

  loadEvidence(evidenceId: string): Evidence {
    const row = this.database().query("select * from evidence where id = $id").get({ $id: evidenceId }) as Row | null;
    if (!row) throw new Error(`evidence not found: ${evidenceId}`);
    const evidence: Evidence = {
      id: String(row.id),
      sessionId: String(row.session_id),
      source: row.source as Evidence["source"],
      title: String(row.title),
      summary: String(row.summary),
      createdAt: String(row.created_at)
    };
    if (typeof row.path === "string") evidence.path = row.path;
    return evidence;
  }

  addNote(note: Note): void {
    this.database()
      .query("insert into notes (id, session_id, text, tags_json, created_at) values ($id, $session, $text, $tags, $created)")
      .run({
        $id: note.id,
        $session: note.sessionId,
        $text: note.text,
        $tags: JSON.stringify(note.tags),
        $created: note.createdAt
      });
    this.emit({ kind: "note", sessionId: note.sessionId, note });
  }

  listNotes(sessionId: string): Note[] {
    const rows = this.database()
      .query("select * from notes where session_id = $session order by created_at asc")
      .all({ $session: sessionId }) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      text: String(row.text),
      tags: JSON.parse(String(row.tags_json)) as string[],
      createdAt: String(row.created_at)
    }));
  }

  saveFinding(finding: Finding): void {
    this.database()
      .query(
        `insert into findings (id, session_id, title, severity, target, evidence_ids_json, impact, reproduction, remediation, status, campaign_id, hypothesis_id, duplicate_of, created_at)
         values ($id, $session, $title, $severity, $target, $evidence, $impact, $reproduction, $remediation, $status, $campaign, $hypothesis, $duplicate, $created)`
      )
      .run({
        $id: finding.id,
        $session: finding.sessionId,
        $title: finding.title,
        $severity: finding.severity,
        $target: finding.target,
        $evidence: JSON.stringify(finding.evidenceIds),
        $impact: finding.impact,
        $reproduction: finding.reproduction,
        $remediation: finding.remediation,
        $status: finding.status ?? "candidate",
        $campaign: finding.campaignId ?? null,
        $hypothesis: finding.hypothesisId ?? null,
        $duplicate: finding.duplicateOf ?? null,
        $created: nowIso()
      });
    this.emit({ kind: "finding", sessionId: finding.sessionId, finding });
  }

  listFindings(sessionId: string): Finding[] {
    const rows = this.database()
      .query("select * from findings where session_id = $session order by created_at asc")
      .all({ $session: sessionId }) as Row[];
    return rows.map(findingFromRow);
  }

  loadFinding(findingId: string): Finding {
    const row = this.database().query("select * from findings where id = $id").get({ $id: findingId }) as Row | null;
    if (!row) throw new Error(`Finding not found: ${findingId}`);
    return findingFromRow(row);
  }

  updateFinding(findingId: string, patch: Partial<Pick<Finding, "status" | "evidenceIds" | "impact" | "reproduction" | "remediation" | "duplicateOf">>): Finding {
    const current = this.loadFinding(findingId);
    const next: Finding = { ...current, ...patch };
    this.database().query(
      `update findings set status = $status, evidence_ids_json = $evidence, impact = $impact,
       reproduction = $reproduction, remediation = $remediation, duplicate_of = $duplicate where id = $id`
    ).run({
      $status: next.status ?? "candidate",
      $evidence: JSON.stringify(next.evidenceIds),
      $impact: next.impact,
      $reproduction: next.reproduction,
      $remediation: next.remediation,
      $duplicate: next.duplicateOf ?? null,
      $id: findingId
    });
    this.emit({ kind: "finding", sessionId: next.sessionId, finding: next });
    return next;
  }

  upsertMemory(item: Omit<MemoryItem, "id" | "createdAt" | "updatedAt">): MemoryItem {
    const existing = this.database()
      .query("select * from memory_items where session_id = $session and kind = $kind and key = $key")
      .get({ $session: item.sessionId, $kind: item.kind, $key: item.key }) as Row | null;
    const now = nowIso();
    const next: MemoryItem = existing
      ? {
          id: String(existing.id),
          sessionId: item.sessionId,
          kind: item.kind,
          key: item.key,
          value: item.value,
          createdAt: String(existing.created_at),
          updatedAt: now
        }
      : {
          id: id(),
          sessionId: item.sessionId,
          kind: item.kind,
          key: item.key,
          value: item.value,
          createdAt: now,
          updatedAt: now
        };
    this.database()
      .query(
        `insert into memory_items (id, session_id, kind, key, value_json, created_at, updated_at)
         values ($id, $session, $kind, $key, $value, $created, $updated)
         on conflict(session_id, kind, key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run({
        $id: next.id,
        $session: next.sessionId,
        $kind: next.kind,
        $key: next.key,
        $value: JSON.stringify(next.value),
        $created: next.createdAt,
        $updated: next.updatedAt
      });
    this.emit({ kind: "memory", sessionId: next.sessionId, item: next });
    return next;
  }

  listMemory(sessionId: string, kind?: MemoryItem["kind"]): MemoryItem[] {
    const rows = kind
      ? (this.database()
          .query("select * from memory_items where session_id = $session and kind = $kind order by updated_at desc")
          .all({ $session: sessionId, $kind: kind }) as Row[])
      : (this.database()
          .query("select * from memory_items where session_id = $session order by updated_at desc")
          .all({ $session: sessionId }) as Row[]);
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      kind: row.kind as MemoryItem["kind"],
      key: String(row.key),
      value: JSON.parse(String(row.value_json)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
  }

  createTodo(item: Omit<TodoItem, "id" | "createdAt" | "updatedAt">): TodoItem {
    const now = nowIso();
    const todo: TodoItem = {
      id: id(),
      ...item,
      createdAt: now,
      updatedAt: now
    };
    this.database()
      .query(
        `insert into todos (id, session_id, turn_id, text, status, priority, created_at, updated_at)
         values ($id, $session, $turn, $text, $status, $priority, $created, $updated)`
      )
      .run({
        $id: todo.id,
        $session: todo.sessionId,
        $turn: todo.turnId ?? null,
        $text: todo.text,
        $status: todo.status,
        $priority: todo.priority,
        $created: todo.createdAt,
        $updated: todo.updatedAt
      });
    this.emit({ kind: "todo", sessionId: todo.sessionId, todo });
    return todo;
  }

  updateTodo(todoId: string, patch: Partial<Pick<TodoItem, "text" | "status" | "priority">>): TodoItem {
    const current = this.loadTodo(todoId);
    const next: TodoItem = {
      ...current,
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      updatedAt: nowIso()
    };
    this.database()
      .query("update todos set text = $text, status = $status, priority = $priority, updated_at = $updated where id = $id")
      .run({
        $id: next.id,
        $text: next.text,
        $status: next.status,
        $priority: next.priority,
        $updated: next.updatedAt
      });
    this.emit({ kind: "todo", sessionId: next.sessionId, todo: next });
    return next;
  }

  loadTodo(todoId: string): TodoItem {
    const row = this.database().query("select * from todos where id = $id").get({ $id: todoId }) as Row | null;
    if (!row) throw new Error(`Todo not found: ${todoId}`);
    return todoFromRow(row);
  }

  listTodos(sessionId: string, options: { turnId?: string; status?: TodoStatus; limit?: number } = {}): TodoItem[] {
    const clauses = ["session_id = $session"];
    const params: Record<string, string | number> = { $session: sessionId, $limit: options.limit ?? 50 };
    if (options.turnId) {
      clauses.push("turn_id = $turn");
      params.$turn = options.turnId;
    }
    if (options.status) {
      clauses.push("status = $status");
      params.$status = options.status;
    }
    const rows = this.database()
      .query(`select * from todos where ${clauses.join(" and ")} order by created_at asc limit $limit`)
      .all(params) as Row[];
    return rows.map(todoFromRow);
  }

  private migrate(db: Database): void {
    const version = Number((db.query("pragma user_version").get() as { user_version?: number } | null)?.user_version ?? 0);
    if (version > 9) throw new Error(`Unsupported Farai database version: ${version}`);
    db.transaction(() => {
      this.ensureBaselineSchema(db);
      if (version < 2) this.addJobAndMailboxSchema(db);
      if (version < 3) this.addEventSequenceSchema(db);
      if (version < 4) this.addJobOwnershipSchema(db);
      if (version < 5) this.addTurnOwnershipSchema(db);
      if (version < 6) this.addUsageCacheMetricsSchema(db);
      if (version < 7) this.addRuntimeLeaseSchema(db);
      if (version < 8) this.addAgentJobMetadataSchema(db);
      if (version < 9) this.addUsagePricingSchema(db);
      db.exec("pragma user_version = 9");
    })();
  }

  private addUsagePricingSchema(db: Database): void {
    addColumnIfMissing(db, "usage", "pricing_json", "text");
  }

  private addAgentJobMetadataSchema(db: Database): void {
    addColumnIfMissing(db, "background_jobs", "title", "text");
    addColumnIfMissing(db, "background_jobs", "lane", "text");
    addColumnIfMissing(db, "background_jobs", "agent_mode", "text");
  }

  private addRuntimeLeaseSchema(db: Database): void {
    db.exec(`
      create table if not exists runtime_leases (
        runtime_id text primary key,
        process_id integer not null,
        started_at text not null,
        heartbeat_at text not null,
        expires_at text not null
      );
      create index if not exists runtime_leases_expiry_idx on runtime_leases(expires_at);
    `);
  }

  private addUsageCacheMetricsSchema(db: Database): void {
    addColumnIfMissing(db, "usage", "cached_input_tokens", "integer");
    addColumnIfMissing(db, "usage", "cache_write_input_tokens", "integer");
  }

  private addTurnOwnershipSchema(db: Database): void {
    const turns = db.query("select name from sqlite_master where type = 'table' and name = 'turns'").get();
    if (turns) addColumnIfMissing(db, "turns", "runtime_id", "text");
  }

  private addJobOwnershipSchema(db: Database): void {
    addColumnIfMissing(db, "sessions", "tool_scope_json", "text");
    addColumnIfMissing(db, "tool_calls", "job_id", "text");
    addColumnIfMissing(db, "background_jobs", "delivery_state", "text not null default 'pending'");
  }

  private addEventSequenceSchema(db: Database): void {
    addColumnIfMissing(db, "events", "sequence", "integer");
    const sessions = db.query("select distinct session_id from events").all() as Array<{ session_id: string }>;
    const rows = db.query("select rowid, id from events where session_id = $session order by rowid asc");
    const update = db.query("update events set sequence = $sequence where id = $id");
    for (const session of sessions) {
      const events = rows.all({ $session: session.session_id }) as Array<{ rowid: number; id: string }>;
      for (const [index, event] of events.entries()) update.run({ $sequence: index + 1, $id: event.id });
    }
    db.exec("create unique index if not exists events_session_sequence_idx on events(session_id, sequence)");
  }

  private addJobAndMailboxSchema(db: Database): void {
    db.exec(`
      create table if not exists background_jobs (
        id text primary key,
        kind text not null,
        status text not null,
        runtime_id text not null,
        session_id text not null,
        turn_id text,
        tool_call_id text,
        child_session_id text,
        title text,
        lane text,
        agent_mode text,
        backend_kind text,
        process_id text,
        cancellation_policy text not null,
        delivery_state text not null default 'pending',
        output_artifact_id text,
        result_json text,
        error text,
        mailbox_id text,
        created_at text not null,
        started_at text,
        completed_at text,
        updated_at text not null
      );
      create index if not exists background_jobs_session_idx on background_jobs(session_id, updated_at);
      create index if not exists background_jobs_process_idx on background_jobs(process_id);
      create table if not exists session_mailbox (
        id text primary key,
        session_id text not null,
        sequence integer not null,
        kind text not null,
        payload_json text not null,
        trigger_policy text not null,
        state text not null,
        dedupe_key text not null,
        lease_owner text,
        lease_expires_at text,
        created_at text not null,
        claimed_at text,
        consumed_at text,
        unique(session_id, sequence),
        unique(session_id, dedupe_key)
      );
      create index if not exists session_mailbox_pending_idx on session_mailbox(session_id, state, trigger_policy, sequence);
    `);
  }

  private ensureBaselineSchema(db: Database): void {
    db.exec(`
      create table if not exists sessions (
        id text primary key,
        workspace text not null,
        mode text not null,
        phase text not null,
        title text,
        parent_id text,
        campaign_id text,
        provider text,
        model text,
        summary text,
        summary_updated_at text,
        tool_scope_json text,
        archived_at text,
        created_at text not null,
        updated_at text not null
      );
      create table if not exists events (
        id text primary key,
        session_id text not null,
        type text not null,
        payload_json text not null,
        created_at text not null
      );
      create table if not exists turns (
        id text primary key,
        session_id text not null,
        runtime_id text,
        status text not null,
        user_input text not null,
        step_count integer not null,
        stop_reason text,
        planner_name text,
        provider text,
        model text,
        error_summary text,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists turns_session_idx on turns(session_id, created_at);
      create table if not exists messages (
        id text primary key,
        session_id text not null,
        turn_id text not null,
        role text not null,
        created_at text not null
      );
      create index if not exists messages_session_idx on messages(session_id, created_at);
      create index if not exists messages_turn_idx on messages(turn_id, created_at);
      create table if not exists parts (
        id text primary key,
        session_id text not null,
        turn_id text not null,
        message_id text not null,
        type text not null,
        payload_json text not null,
        order_index integer not null,
        created_at text not null
      );
      create index if not exists parts_message_idx on parts(message_id, order_index);
      create index if not exists parts_session_idx on parts(session_id, created_at);
      create table if not exists tool_calls (
        id text primary key,
        session_id text not null,
        tool text not null,
        args_json text not null,
        status text not null,
        evidence_ids_json text not null,
        output_artifact_id text,
        turn_id text,
        message_id text,
        timeline_part_id text,
        created_at text not null,
        updated_at text not null
      );
      create table if not exists evidence (
        id text primary key,
        session_id text not null,
        source text not null,
        title text not null,
        path text,
        summary text not null,
        created_at text not null
      );
      create table if not exists notes (
        id text primary key,
        session_id text not null,
        text text not null,
        tags_json text not null,
        created_at text not null
      );
      create table if not exists findings (
        id text primary key,
        session_id text not null,
        title text not null,
        severity text not null,
        target text not null,
        evidence_ids_json text not null,
        impact text not null,
        reproduction text not null,
        remediation text not null,
        status text,
        campaign_id text,
        hypothesis_id text,
        duplicate_of text,
        created_at text not null
      );
      create table if not exists campaigns (
        id text primary key,
        workspace text not null,
        name text not null,
        kind text not null,
        status text not null,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists campaigns_workspace_idx on campaigns(workspace, updated_at);
      create table if not exists campaign_assets (
        id text primary key,
        campaign_id text not null,
        canonical text not null,
        kind text not null,
        parent_id text,
        technologies_json text not null,
        metadata_json text not null,
        confidence real not null,
        first_seen text not null,
        last_seen text not null,
        unique(campaign_id, canonical)
      );
      create index if not exists campaign_assets_campaign_idx on campaign_assets(campaign_id, last_seen);
      create table if not exists campaign_observations (
        id text primary key,
        campaign_id text not null,
        asset_id text,
        kind text not null,
        value_json text not null,
        confidence real not null,
        source text not null,
        evidence_ids_json text not null,
        status text not null,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists campaign_observations_campaign_idx on campaign_observations(campaign_id, updated_at);
      create table if not exists campaign_hypotheses (
        id text primary key,
        campaign_id text not null,
        asset_id text,
        title text not null,
        category text not null,
        status text not null,
        rationale text not null,
        next_test text not null,
        confidence real not null,
        evidence_ids_json text not null,
        created_at text not null,
        updated_at text not null,
        unique(campaign_id, title, asset_id)
      );
      create index if not exists campaign_hypotheses_campaign_idx on campaign_hypotheses(campaign_id, status, updated_at);
      create table if not exists campaign_test_attempts (
        id text primary key,
        campaign_id text not null,
        session_id text not null,
        hypothesis_id text,
        title text not null,
        target text not null,
        method text not null,
        baseline_json text not null,
        mutation_json text not null,
        oracle text not null,
        observed_json text,
        status text not null,
        evidence_level text not null,
        evidence_ids_json text not null,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists campaign_test_attempts_campaign_idx on campaign_test_attempts(campaign_id, updated_at);
      create index if not exists campaign_test_attempts_hypothesis_idx on campaign_test_attempts(hypothesis_id, updated_at);
      create table if not exists usage (
        id text primary key,
        session_id text not null,
        turn_id text,
        provider text not null,
        model text not null,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        pricing_json text,
        cost real not null default 0,
        latency_ms integer not null default 0,
        created_at text not null
      );
      create index if not exists usage_session_idx on usage(session_id, created_at);
      create table if not exists compaction_boundaries (
        id text primary key,
        session_id text not null,
        trigger text not null,
        through_message_rowid integer not null,
        summary text not null,
        pre_compact_tokens integer,
        post_compact_tokens integer,
        created_at text not null
      );
      create index if not exists compaction_boundaries_session_idx on compaction_boundaries(session_id, created_at);
      create table if not exists memory_items (
        id text primary key,
        session_id text not null,
        kind text not null,
        key text not null,
        value_json text not null,
        created_at text not null,
        updated_at text not null
      );
      create unique index if not exists memory_unique_idx on memory_items(session_id, kind, key);
      create index if not exists memory_session_kind_idx on memory_items(session_id, kind, key);
      create table if not exists todos (
        id text primary key,
        session_id text not null,
        turn_id text,
        text text not null,
        status text not null,
        priority text not null,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists todos_session_idx on todos(session_id, status, created_at);
      create index if not exists todos_turn_idx on todos(turn_id, created_at);
      create table if not exists output_artifacts (
        id text primary key,
        session_id text not null,
        tool_call_id text,
        path text not null,
        bytes integer not null,
        created_at text not null
      );
      create index if not exists output_artifacts_session_idx on output_artifacts(session_id, created_at);
      create table if not exists runtime_leases (
        runtime_id text primary key,
        process_id integer not null,
        started_at text not null,
        heartbeat_at text not null,
        expires_at text not null
      );
      create index if not exists runtime_leases_expiry_idx on runtime_leases(expires_at);
    `);
    addColumnIfMissing(db, "sessions", "title", "text");
    addColumnIfMissing(db, "sessions", "parent_id", "text");
    addColumnIfMissing(db, "sessions", "campaign_id", "text");
    addColumnIfMissing(db, "sessions", "provider", "text");
    addColumnIfMissing(db, "sessions", "model", "text");
    addColumnIfMissing(db, "sessions", "summary", "text");
    addColumnIfMissing(db, "sessions", "summary_updated_at", "text");
    addColumnIfMissing(db, "sessions", "tool_scope_json", "text");
    addColumnIfMissing(db, "sessions", "archived_at", "text");
    addColumnIfMissing(db, "turns", "runtime_id", "text");
    addColumnIfMissing(db, "turns", "stop_reason", "text");
    addColumnIfMissing(db, "turns", "planner_name", "text");
    addColumnIfMissing(db, "turns", "provider", "text");
    addColumnIfMissing(db, "turns", "model", "text");
    addColumnIfMissing(db, "turns", "error_summary", "text");
    addColumnIfMissing(db, "tool_calls", "output_artifact_id", "text");
    addColumnIfMissing(db, "tool_calls", "turn_id", "text");
    addColumnIfMissing(db, "tool_calls", "message_id", "text");
    addColumnIfMissing(db, "tool_calls", "timeline_part_id", "text");
    addColumnIfMissing(db, "tool_calls", "job_id", "text");
    addColumnIfMissing(db, "tool_calls", "process_id", "text");
    addColumnIfMissing(db, "tool_calls", "provider_tool_call_id", "text");
    addColumnIfMissing(db, "findings", "status", "text");
    addColumnIfMissing(db, "findings", "campaign_id", "text");
    addColumnIfMissing(db, "findings", "hypothesis_id", "text");
    addColumnIfMissing(db, "findings", "duplicate_of", "text");
    db.exec("drop table if exists approvals");
    db.exec("drop table if exists campaign_rules");
    dropColumnIfPresent(db, "sessions", "permission_profile");
    dropColumnIfPresent(db, "sessions", "scope_json");
    dropColumnIfPresent(db, "turns", "scope");
    dropColumnIfPresent(db, "tool_calls", "risk");
    dropColumnIfPresent(db, "tool_calls", "approval_id");
    dropColumnIfPresent(db, "campaigns", "scope_json");
    dropColumnIfPresent(db, "campaign_assets", "scope_status");
  }
}

function addColumnIfMissing(db: Database, table: string, column: string, type: string): void {
  const rows = db.query(`pragma table_info(${table})`).all() as Array<{ name?: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`alter table ${table} add column ${column} ${type}`);
}

function dropColumnIfPresent(db: Database, table: string, column: string): void {
  const rows = db.query(`pragma table_info(${table})`).all() as Array<{ name?: string }>;
  if (!rows.some((row) => row.name === column)) return;
  db.exec(`alter table ${table} drop column ${column}`);
}

function writeJobRow(db: Database, job: BackgroundJob): void {
  db.query(
    `insert into background_jobs
     (id, kind, status, runtime_id, session_id, turn_id, tool_call_id, child_session_id, title, lane, agent_mode, backend_kind, process_id,
      cancellation_policy, delivery_state, output_artifact_id, result_json, error, mailbox_id, created_at, started_at, completed_at, updated_at)
     values ($id, $kind, $status, $runtime, $session, $turn, $toolCall, $childSession, $title, $lane, $agentMode, $backend, $process,
      $cancelPolicy, $delivery, $artifact, $result, $error, $mailbox, $created, $started, $completed, $updated)
     on conflict(id) do update set status = excluded.status, title = excluded.title, lane = excluded.lane, agent_mode = excluded.agent_mode, backend_kind = excluded.backend_kind,
      process_id = excluded.process_id, output_artifact_id = excluded.output_artifact_id, result_json = excluded.result_json,
      error = excluded.error, mailbox_id = excluded.mailbox_id, delivery_state = excluded.delivery_state, started_at = excluded.started_at,
      completed_at = excluded.completed_at, updated_at = excluded.updated_at`
  ).run({
    $id: job.id,
    $kind: job.kind,
    $status: job.status,
    $runtime: job.runtimeId,
    $session: job.sessionId,
    $turn: job.turnId ?? null,
    $toolCall: job.toolCallId ?? null,
    $childSession: job.childSessionId ?? null,
    $title: job.title ?? null,
    $lane: job.lane ?? null,
    $agentMode: job.agentMode ?? null,
    $backend: job.backendKind ?? null,
    $process: job.processId ?? null,
    $cancelPolicy: job.cancellationPolicy,
    $delivery: job.deliveryState ?? "pending",
    $artifact: job.outputArtifactId ?? null,
    $result: job.result === undefined ? null : JSON.stringify(job.result),
    $error: job.error ?? null,
    $mailbox: job.mailboxId ?? null,
    $created: job.createdAt,
    $started: job.startedAt ?? null,
    $completed: job.completedAt ?? null,
    $updated: job.updatedAt
  });
}

function writeToolCallRow(db: Database, record: ToolCallRecord): void {
  const stored = { ...record, tool: canonicalToolName(record.tool) };
  const timestamp = nowIso();
  db.query(
    `insert into tool_calls (id, session_id, tool, args_json, status, evidence_ids_json, output_artifact_id, turn_id, message_id, timeline_part_id, job_id, process_id, provider_tool_call_id, created_at, updated_at)
     values ($id, $session, $tool, $args, $status, $evidence, $artifact, $turn, $message, $part, $job, $process, $providerToolCallId, $created, $updated)
     on conflict(id) do update set tool = excluded.tool, args_json = excluded.args_json, status = excluded.status,
       evidence_ids_json = excluded.evidence_ids_json, output_artifact_id = excluded.output_artifact_id,
       turn_id = excluded.turn_id, message_id = excluded.message_id, timeline_part_id = excluded.timeline_part_id,
       job_id = excluded.job_id, process_id = excluded.process_id, provider_tool_call_id = excluded.provider_tool_call_id, updated_at = excluded.updated_at`
  ).run({
    $id: stored.id,
    $session: stored.sessionId,
    $tool: stored.tool,
    $args: JSON.stringify(stored.args),
    $status: stored.status,
    $evidence: JSON.stringify(stored.evidenceIds),
    $artifact: stored.outputArtifactId ?? null,
    $turn: stored.turnId ?? null,
    $message: stored.messageId ?? null,
    $part: stored.timelinePartId ?? null,
    $job: stored.jobId ?? null,
    $process: stored.processId ?? null,
    $providerToolCallId: stored.providerToolCallId ?? null,
    $created: timestamp,
    $updated: timestamp
  });
}

function syncToolCallTimelineRow(db: Database, record: ToolCallRecord): Part | undefined {
  if (!record.timelinePartId) return undefined;
  const updated = db.query("update parts set payload_json = $payload where id = $id").run({
    $id: record.timelinePartId,
    $payload: JSON.stringify({ record })
  });
  if (updated.changes === 0) return undefined;
  const row = db.query("select * from parts where id = $id").get({ $id: record.timelinePartId }) as Row | null;
  return row ? partFromRow(row) : undefined;
}

function settleBackgroundToolCallRows(db: Database, input: BackgroundToolSettlementInput): BackgroundToolSettlement[] {
  if (!input.processId && !input.toolCallId) return [];
  const rows = db.query(
    `select * from tool_calls
     where session_id = $session
       and (($process is not null and process_id = $process and status = 'running_background')
         or ($toolCall is not null and id = $toolCall and status in ('running_background', 'done', 'error')))`
  ).all({
    $session: input.sessionId,
    $process: input.processId ?? null,
    $toolCall: input.toolCallId ?? null
  }) as Row[];
  return rows.map(toolCallFromRow).map((record) => {
    const toolCall = {
      ...record,
      status: input.status,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.outputArtifactId ? { outputArtifactId: input.outputArtifactId } : {})
    };
    writeToolCallRow(db, toolCall);
    const timelinePart = syncToolCallTimelineRow(db, toolCall);
    return { toolCall, ...(timelinePart ? { timelinePart } : {}) };
  });
}

function ensureTerminalToolPart(
  db: Database,
  record: ToolCallRecord,
  terminal: { type: "tool_result" | "error"; payload: unknown }
): { part: Part; inserted: boolean; updated: boolean } {
  if (!record.turnId || !record.messageId) throw new Error(`Tool call ${record.id} has no timeline owner`);
  const rows = db.query(
    "select * from parts where message_id = $message and type in ('tool_result', 'error') order by order_index asc"
  ).all({ $message: record.messageId }) as Row[];
  const matching = rows.map(partFromRow).filter((part) => {
    if (!part.payload || typeof part.payload !== "object") return false;
    return (part.payload as { toolCallId?: unknown }).toolCallId === record.id;
  });
  const existing = matching[0];
  if (existing) {
    for (const duplicate of matching.slice(1)) db.query("delete from parts where id = $id").run({ $id: duplicate.id });
    const payload = JSON.stringify(terminal.payload);
    const changed = matching.length > 1 || existing.type !== terminal.type || JSON.stringify(existing.payload) !== payload;
    if (!changed) return { part: existing, inserted: false, updated: false };
    db.query("update parts set type = $type, payload_json = $payload where id = $id").run({
      $id: existing.id,
      $type: terminal.type,
      $payload: payload
    });
    return { part: { ...existing, type: terminal.type, payload: terminal.payload }, inserted: false, updated: true };
  }
  const max = db.query("select max(order_index) as max_order from parts where message_id = $message")
    .get({ $message: record.messageId }) as { max_order?: number | null } | null;
  const part: Part = {
    id: id(),
    sessionId: record.sessionId,
    turnId: record.turnId,
    messageId: record.messageId,
    type: terminal.type,
    payload: terminal.payload,
    order: (max?.max_order ?? -1) + 1,
    createdAt: nowIso()
  };
  db.query(
    `insert into parts (id, session_id, turn_id, message_id, type, payload_json, order_index, created_at)
     values ($id, $session, $turn, $message, $type, $payload, $order, $created)`
  ).run({
    $id: part.id,
    $session: part.sessionId,
    $turn: part.turnId,
    $message: part.messageId,
    $type: part.type,
    $payload: JSON.stringify(part.payload),
    $order: part.order,
    $created: part.createdAt
  });
  return { part, inserted: true, updated: false };
}

function compactionBoundaryFromRow(row: Row): CompactionBoundary {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    trigger: row.trigger as CompactionBoundary["trigger"],
    throughMessageRowId: Number(row.through_message_rowid),
    summary: String(row.summary),
    ...(typeof row.pre_compact_tokens === "number" ? { preCompactTokens: row.pre_compact_tokens } : {}),
    ...(typeof row.post_compact_tokens === "number" ? { postCompactTokens: row.post_compact_tokens } : {}),
    createdAt: String(row.created_at)
  };
}

function usageFromRow(row: Row): UsageRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    ...(typeof row.turn_id === "string" ? { turnId: row.turn_id } : {}),
    provider: String(row.provider),
    model: String(row.model),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    ...(typeof row.cached_input_tokens === "number" ? { cachedInputTokens: row.cached_input_tokens } : {}),
    ...(typeof row.cache_write_input_tokens === "number" ? { cacheWriteInputTokens: row.cache_write_input_tokens } : {}),
    ...(typeof row.pricing_json === "string" ? { pricing: JSON.parse(row.pricing_json) as NonNullable<UsageRecord["pricing"]> } : {}),
    cost: Number(row.cost),
    latencyMs: Number(row.latency_ms),
    createdAt: String(row.created_at)
  };
}

function sessionEventFromRow(row: Row): SessionEvent {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    ...(typeof row.sequence === "number" ? { sequence: row.sequence } : {}),
    type: row.type as SessionEvent["type"],
    payload: JSON.parse(String(row.payload_json)),
    createdAt: String(row.created_at)
  };
}

function backgroundJobFromRow(row: Row): BackgroundJob {
  return {
    id: String(row.id),
    kind: row.kind as BackgroundJob["kind"],
    status: row.status as BackgroundJob["status"],
    runtimeId: String(row.runtime_id),
    sessionId: String(row.session_id),
    ...(typeof row.turn_id === "string" ? { turnId: row.turn_id } : {}),
    ...(typeof row.tool_call_id === "string" ? { toolCallId: row.tool_call_id } : {}),
    ...(typeof row.child_session_id === "string" ? { childSessionId: row.child_session_id } : {}),
    ...(typeof row.title === "string" ? { title: row.title } : {}),
    ...(typeof row.lane === "string" ? { lane: row.lane } : {}),
    ...(row.agent_mode === "attached" || row.agent_mode === "detached" ? { agentMode: row.agent_mode } : {}),
    ...(typeof row.backend_kind === "string" ? { backendKind: row.backend_kind } : {}),
    ...(typeof row.process_id === "string" ? { processId: row.process_id } : {}),
    cancellationPolicy: row.cancellation_policy as BackgroundJob["cancellationPolicy"],
    deliveryState: (typeof row.delivery_state === "string" ? row.delivery_state : "pending") as BackgroundJob["deliveryState"],
    ...(typeof row.output_artifact_id === "string" ? { outputArtifactId: row.output_artifact_id } : {}),
    ...(typeof row.result_json === "string" ? { result: JSON.parse(row.result_json) } : {}),
    ...(typeof row.error === "string" ? { error: row.error } : {}),
    ...(typeof row.mailbox_id === "string" ? { mailboxId: row.mailbox_id } : {}),
    createdAt: String(row.created_at),
    ...(typeof row.started_at === "string" ? { startedAt: row.started_at } : {}),
    ...(typeof row.completed_at === "string" ? { completedAt: row.completed_at } : {}),
    updatedAt: String(row.updated_at)
  };
}

function mailboxItemFromRow(row: Row): SessionMailboxItem {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    sequence: Number(row.sequence),
    kind: row.kind as SessionMailboxItem["kind"],
    payload: JSON.parse(String(row.payload_json)),
    triggerPolicy: row.trigger_policy as SessionMailboxItem["triggerPolicy"],
    state: row.state as SessionMailboxItem["state"],
    dedupeKey: String(row.dedupe_key),
    ...(typeof row.lease_owner === "string" ? { leaseOwner: row.lease_owner } : {}),
    ...(typeof row.lease_expires_at === "string" ? { leaseExpiresAt: row.lease_expires_at } : {}),
    createdAt: String(row.created_at),
    ...(typeof row.claimed_at === "string" ? { claimedAt: row.claimed_at } : {}),
    ...(typeof row.consumed_at === "string" ? { consumedAt: row.consumed_at } : {})
  };
}

function outputArtifactFromRow(row: Row): OutputArtifact {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    ...(typeof row.tool_call_id === "string" ? { toolCallId: row.tool_call_id } : {}),
    path: String(row.path),
    bytes: Number(row.bytes),
    createdAt: String(row.created_at)
  };
}

function sessionFromRow(row: Row): Session {
  const session: Session = {
    id: String(row.id),
    workspace: String(row.workspace),
    mode: "freestyle",
    phase: row.phase as Session["phase"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
  if (typeof row.title === "string") session.title = row.title;
  if (typeof row.parent_id === "string") session.parentId = row.parent_id;
  if (typeof row.campaign_id === "string") session.campaignId = row.campaign_id;
  if (typeof row.provider === "string") session.provider = row.provider;
  if (typeof row.model === "string") session.model = row.model;
  if (typeof row.summary === "string") session.summary = row.summary;
  if (typeof row.summary_updated_at === "string") session.summaryUpdatedAt = row.summary_updated_at;
  if (typeof row.tool_scope_json === "string") session.toolScope = (JSON.parse(row.tool_scope_json) as string[]).map(canonicalToolName);
  if (typeof row.archived_at === "string") session.archivedAt = row.archived_at;
  return session;
}

function campaignFromRow(row: Row): Campaign {
  const campaign: Campaign = {
    id: String(row.id),
    workspace: String(row.workspace),
    name: String(row.name),
    kind: row.kind as Campaign["kind"],
    status: row.status as Campaign["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
  return campaign;
}

function campaignAssetFromRow(row: Row): CampaignAsset {
  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    canonical: String(row.canonical),
    kind: row.kind as CampaignAsset["kind"],
    ...(typeof row.parent_id === "string" ? { parentId: row.parent_id } : {}),
    technologies: JSON.parse(String(row.technologies_json)) as string[],
    metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
    confidence: Number(row.confidence),
    firstSeen: String(row.first_seen),
    lastSeen: String(row.last_seen)
  };
}

function campaignObservationFromRow(row: Row): CampaignObservation {
  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    ...(typeof row.asset_id === "string" ? { assetId: row.asset_id } : {}),
    kind: String(row.kind),
    value: JSON.parse(String(row.value_json)),
    confidence: Number(row.confidence),
    source: String(row.source),
    evidenceIds: JSON.parse(String(row.evidence_ids_json)) as string[],
    status: row.status as CampaignObservation["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function campaignHypothesisFromRow(row: Row): CampaignHypothesis {
  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    ...(typeof row.asset_id === "string" ? { assetId: row.asset_id } : {}),
    title: String(row.title),
    category: String(row.category),
    status: row.status as CampaignHypothesis["status"],
    rationale: String(row.rationale),
    nextTest: String(row.next_test),
    confidence: Number(row.confidence),
    evidenceIds: JSON.parse(String(row.evidence_ids_json)) as string[],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function testAttemptFromRow(row: Row): TestAttempt {
  const attempt: TestAttempt = {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    sessionId: String(row.session_id),
    title: String(row.title),
    target: String(row.target),
    method: String(row.method),
    baseline: JSON.parse(String(row.baseline_json)),
    mutation: JSON.parse(String(row.mutation_json)),
    oracle: String(row.oracle),
    status: row.status as TestAttempt["status"],
    evidenceLevel: row.evidence_level as TestAttempt["evidenceLevel"],
    evidenceIds: JSON.parse(String(row.evidence_ids_json)) as string[],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
  if (typeof row.hypothesis_id === "string") attempt.hypothesisId = row.hypothesis_id;
  if (typeof row.observed_json === "string") attempt.observed = JSON.parse(row.observed_json);
  return attempt;
}

function findingFromRow(row: Row): Finding {
  const finding: Finding = {
    id: String(row.id),
    sessionId: String(row.session_id),
    title: String(row.title),
    severity: row.severity as Finding["severity"],
    target: String(row.target),
    evidenceIds: JSON.parse(String(row.evidence_ids_json)) as string[],
    impact: String(row.impact),
    reproduction: String(row.reproduction),
    remediation: String(row.remediation)
  };
  if (typeof row.status === "string") finding.status = row.status as NonNullable<Finding["status"]>;
  if (typeof row.campaign_id === "string") finding.campaignId = row.campaign_id;
  if (typeof row.hypothesis_id === "string") finding.hypothesisId = row.hypothesis_id;
  if (typeof row.duplicate_of === "string") finding.duplicateOf = row.duplicate_of;
  return finding;
}

function toolCallFromRow(row: Row): ToolCallRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    tool: canonicalToolName(String(row.tool)),
    args: JSON.parse(String(row.args_json)),
    status: row.status as ToolCallRecord["status"],
    evidenceIds: JSON.parse(String(row.evidence_ids_json)) as string[],
    ...(typeof row.output_artifact_id === "string" ? { outputArtifactId: row.output_artifact_id } : {}),
    ...(typeof row.turn_id === "string" ? { turnId: row.turn_id } : {}),
    ...(typeof row.message_id === "string" ? { messageId: row.message_id } : {}),
    ...(typeof row.timeline_part_id === "string" ? { timelinePartId: row.timeline_part_id } : {}),
    ...(typeof row.job_id === "string" ? { jobId: row.job_id } : {}),
    ...(typeof row.process_id === "string" ? { processId: row.process_id } : {}),
    ...(typeof row.provider_tool_call_id === "string" ? { providerToolCallId: row.provider_tool_call_id } : {})
  };
}

function turnFromRow(row: Row): Turn {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    ...(typeof row.runtime_id === "string" ? { runtimeId: row.runtime_id } : {}),
    status: row.status as TurnStatus,
    userInput: String(row.user_input),
    stepCount: Number(row.step_count),
    ...(typeof row.stop_reason === "string" ? { stopReason: row.stop_reason as TurnStopReason } : {}),
    ...(typeof row.planner_name === "string" ? { plannerName: row.planner_name } : {}),
    ...(typeof row.provider === "string" ? { provider: row.provider } : {}),
    ...(typeof row.model === "string" ? { model: row.model } : {}),
    ...(typeof row.error_summary === "string" ? { errorSummary: row.error_summary } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function todoFromRow(row: Row): TodoItem {
  const todo: TodoItem = {
    id: String(row.id),
    sessionId: String(row.session_id),
    text: String(row.text),
    status: row.status as TodoItem["status"],
    priority: row.priority as TodoItem["priority"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
  if (typeof row.turn_id === "string") todo.turnId = row.turn_id;
  return todo;
}

function messageFromRow(row: Row): Message {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    turnId: String(row.turn_id),
    role: row.role as MessageRole,
    createdAt: String(row.created_at)
  };
}

function partFromRow(row: Row): Part {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    turnId: String(row.turn_id),
    messageId: String(row.message_id),
    type: row.type as PartType,
    payload: JSON.parse(String(row.payload_json)),
    order: Number(row.order_index),
    createdAt: String(row.created_at)
  };
}

function scoreCampaignMatch(text: string, phrase: string, terms: string[]): number {
  if (text.includes(phrase)) return 1;
  if (!terms.length) return 0.4;
  let matched = 0;
  for (const term of terms) if (text.includes(term)) matched += term.length >= 5 ? 1 : 0.6;
  const coverage = matched / terms.length;
  return Math.min(0.9, 0.3 + coverage * 0.6);
}
