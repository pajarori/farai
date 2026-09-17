import type { BackgroundJob, Evidence, Finding, MemoryItem, OutputArtifact, Session, ToolCallRecord, Turn } from "../types";
import type { SqliteStore } from "./sqlite-store";

export type ThreadRepository = Readonly<{
  create: (input?: Parameters<SqliteStore["createSession"]>[0]) => Promise<Session>;
  get: (id: string) => Session;
  update: SqliteStore["updateSession"];
  list: SqliteStore["listSessions"];
}>;

export type TurnRepository = Readonly<{
  get: (id: string) => Turn;
  list: (sessionId: string, limit?: number) => Turn[];
}>;

export type JobRepository = Readonly<{
  get: (id: string) => BackgroundJob;
  list: (sessionId: string, limit?: number) => BackgroundJob[];
  listByRuntime: (runtimeId: string, limit?: number) => BackgroundJob[];
}>;

export type EvidenceRepository = Readonly<{
  save: (evidence: Evidence, content?: string) => Evidence;
  list: (sessionId: string) => Evidence[];
}>;

export type FindingRepository = Readonly<{
  save: (finding: Finding) => void;
  get: (id: string) => Finding;
}>;

export type MemoryRepository = Readonly<{
  upsert: (item: Omit<MemoryItem, "id" | "createdAt" | "updatedAt">) => MemoryItem;
}>;

export type ArtifactRepository = Readonly<{
  saveOutput: (input: { sessionId: string; toolCallId?: string; content: string }) => OutputArtifact;
  readOutput: SqliteStore["readOutputArtifact"];
}>;

export type ToolInvocationRepository = Readonly<{
  list: (sessionId: string, limit?: number) => ToolCallRecord[];
}>;

export type FaraiRepositories = Readonly<{
  threads: ThreadRepository;
  turns: TurnRepository;
  jobs: JobRepository;
  evidence: EvidenceRepository;
  findings: FindingRepository;
  memory: MemoryRepository;
  artifacts: ArtifactRepository;
  toolInvocations: ToolInvocationRepository;
}>;

export function repositories(store: SqliteStore): FaraiRepositories {
  return {
    threads: {
      create: (input) => store.createSession(input),
      get: (id) => store.loadSession(id),
      update: store.updateSession.bind(store),
      list: store.listSessions.bind(store)
    },
    turns: {
      get: (id) => store.loadTurn(id),
      list: store.listTurns.bind(store)
    },
    jobs: {
      get: (id) => store.loadJob(id),
      list: store.listJobs.bind(store),
      listByRuntime: store.listJobsByRuntime.bind(store)
    },
    evidence: {
      save: store.saveEvidence.bind(store),
      list: (sessionId) => store.listEvidence(sessionId)
    },
    findings: {
      save: store.saveFinding.bind(store),
      get: (id) => store.loadFinding(id)
    },
    memory: {
      upsert: store.upsertMemory.bind(store)
    },
    artifacts: {
      saveOutput: store.saveOutputArtifact.bind(store),
      readOutput: store.readOutputArtifact.bind(store)
    },
    toolInvocations: {
      list: store.listToolCalls.bind(store)
    }
  };
}
