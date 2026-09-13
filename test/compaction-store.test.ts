import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/agent-store/sqlite-store";
import { id, nowIso } from "../src/utils";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "farai-compact-store-"));
  roots.push(value);
  return value;
}

test("compaction boundary scopes active history while retaining the full transcript", async () => {
  const store = new SqliteStore(join(root(), ".farai"));
  const session = await store.createSession({ workspace: "/tmp", model: "model-a" });
  const firstTurn = store.createTurn(session.id, "first");
  const firstUser = store.createMessage({ sessionId: session.id, turnId: firstTurn.id, role: "user" });
  store.addPart({ sessionId: session.id, turnId: firstTurn.id, messageId: firstUser.id, type: "text", payload: { text: "first" } });
  const firstAssistant = store.createMessage({ sessionId: session.id, turnId: firstTurn.id, role: "assistant" });
  store.addPart({ sessionId: session.id, turnId: firstTurn.id, messageId: firstAssistant.id, type: "text", payload: { text: "first answer" } });

  const through = store.maxMessageRowId(session.id);
  const boundary = store.commitCompaction({
    sessionId: session.id,
    trigger: "manual",
    summary: "summary of first turn",
    throughMessageRowId: through,
    preCompactTokens: 900,
    postCompactTokens: 120
  });

  const secondTurn = store.createTurn(session.id, "second");
  const secondUser = store.createMessage({ sessionId: session.id, turnId: secondTurn.id, role: "user" });
  store.addPart({ sessionId: session.id, turnId: secondTurn.id, messageId: secondUser.id, type: "text", payload: { text: "second" } });

  expect(store.latestCompactionBoundary(session.id)).toEqual(boundary);
  expect(store.listMessages(session.id).map((message) => message.id)).toEqual([firstUser.id, firstAssistant.id, secondUser.id]);
  expect(store.listContextMessages(session.id).map((message) => message.id)).toEqual([secondUser.id]);
  expect(store.listVisibleMessages(session.id).map((message) => message.id)).toEqual([secondUser.id]);
  expect(store.loadSession(session.id).summary).toBe("summary of first turn");
});

test("message hydration preserves message and part order across SQL batches", async () => {
  const store = new SqliteStore(join(root(), ".farai"));
  const session = await store.createSession({ workspace: "/tmp" });
  const turn = store.createTurn(session.id, "batched history");
  for (let index = 0; index < 405; index += 1) {
    const message = store.createMessage({ sessionId: session.id, turnId: turn.id, role: index % 2 === 0 ? "user" : "assistant" });
    store.addPart({ sessionId: session.id, turnId: turn.id, messageId: message.id, type: "text", payload: { text: `first-${index}` } });
    store.addPart({ sessionId: session.id, turnId: turn.id, messageId: message.id, type: "text", payload: { text: `second-${index}` } });
  }

  const messages = store.listMessages(session.id, 500);
  expect(messages).toHaveLength(405);
  expect(messages[0]?.parts.map((part) => (part.payload as { text: string }).text)).toEqual(["first-0", "second-0"]);
  expect(messages.at(-1)?.parts.map((part) => (part.payload as { text: string }).text)).toEqual(["first-404", "second-404"]);
});

test("usage persists and clearSessionChat preserves durable pentest work", async () => {
  const store = new SqliteStore(join(root(), ".farai"));
  const session = await store.createSession({ workspace: "/tmp", model: "model-a", title: "target" });
  const turn = store.createTurn(session.id, "scan");
  const user = store.createMessage({ sessionId: session.id, turnId: turn.id, role: "user" });
  store.addPart({ sessionId: session.id, turnId: turn.id, messageId: user.id, type: "text", payload: { text: "scan" } });
  const artifact = store.saveOutputArtifact({ sessionId: session.id, toolCallId: "tool-1", content: "full output" });
  store.saveToolCall({ id: "tool-1", sessionId: session.id, tool: "shell_exec", args: {}, status: "done", evidenceIds: [], turnId: turn.id, messageId: user.id, outputArtifactId: artifact.id });
  store.saveEvidence({ id: id(), sessionId: session.id, source: "tool", title: "open port", summary: "443 open", createdAt: nowIso() });
  store.addNote({ id: id(), sessionId: session.id, text: "keep note", tags: [], createdAt: nowIso() });
  store.upsertMemory({ sessionId: session.id, kind: "fact", key: "host", value: "example.test" });
  store.replacePlan(session.id, [{ step: "verify", status: "in_progress" }]);
  store.createTodo({ sessionId: session.id, turnId: turn.id, text: "verify", status: "pending", priority: "high" });
  store.commitCompaction({ sessionId: session.id, trigger: "auto", summary: "summary", throughMessageRowId: store.maxMessageRowId(session.id) });
  const usage = store.saveUsage({
    sessionId: session.id,
    turnId: turn.id,
    provider: "p",
    model: "model-a",
    inputTokens: 1000,
    outputTokens: 50,
    cachedInputTokens: 800,
    cacheWriteInputTokens: 125,
    cost: 0,
    latencyMs: 20
  });

  expect(store.latestUsage(session.id, "model-a")).toEqual(usage);
  expect(store.usageSummary(session.id, "model-a")).toEqual({
    requests: 1,
    inputTokens: 1000,
    outputTokens: 50,
    cachedInputTokens: 800,
    cacheWriteInputTokens: 125,
    cacheHitRate: 0.8,
    totalCost: 0,
    averageLatencyMs: 20
  });
  const cleared = store.clearSessionChat(session.id);

  expect(cleared.model).toBe("model-a");
  expect(cleared.title).toBe("target");
  expect(cleared.summary).toBeUndefined();
  expect(store.listMessages(session.id)).toEqual([]);
  expect(store.listTurns(session.id)).toEqual([]);
  expect(store.listToolCalls(session.id)).toEqual([]);
  expect(store.listEvents(session.id)).toEqual([]);
  expect(store.latestCompactionBoundary(session.id)).toBeUndefined();
  expect(store.loadPlan(session.id)).toEqual([]);
  expect(store.listEvidence(session.id)).toHaveLength(1);
  expect(store.listNotes(session.id)).toHaveLength(1);
  expect(store.listMemory(session.id)).toHaveLength(1);
  const todos = store.listTodos(session.id);
  expect(todos).toEqual([expect.objectContaining({ text: "verify" })]);
  expect("turnId" in todos[0]!).toBe(false);
  expect(store.readOutputArtifact(artifact.id)?.content).toBe("full output");
  expect(store.latestUsage(session.id, "model-a")).toEqual(usage);
  expect(store.usageSummary(session.id, "model-a").cacheHitRate).toBe(0.8);
});

test("compaction commit rolls back the boundary and session summary when event persistence fails", async () => {
  const store = new SqliteStore(join(root(), ".farai"));
  const session = await store.createSession({ workspace: "/tmp", model: "model-a" });
  const turn = store.createTurn(session.id, "request");
  const message = store.createMessage({ sessionId: session.id, turnId: turn.id, role: "user" });
  store.addPart({ sessionId: session.id, turnId: turn.id, messageId: message.id, type: "text", payload: { text: "request" } });
  store.database().exec(`create trigger fail_compaction_event before insert on events
    when new.type = 'compaction'
    begin
      select raise(abort, 'forced compaction event failure');
    end`);

  expect(() => store.commitCompaction({
    sessionId: session.id,
    trigger: "manual",
    summary: "must roll back",
    throughMessageRowId: store.maxMessageRowId(session.id),
    expectedPreviousBoundaryId: null
  })).toThrow("forced compaction event failure");

  expect(store.latestCompactionBoundary(session.id)).toBeUndefined();
  expect(store.loadSession(session.id).summary).toBeUndefined();
  expect(store.listEvents(session.id).some((event) => event.type === "compaction")).toBe(false);
});

test("terminal turn transitions roll back state when the stop event cannot be persisted", async () => {
  const store = new SqliteStore(join(root(), ".farai"));
  const session = await store.createSession({ workspace: "/tmp", model: "model-a" });
  const turn = store.createTurn(session.id, "request");
  store.database().exec(`create trigger fail_turn_stop before insert on events
    when new.type = 'loop_stop'
    begin
      select raise(abort, 'forced turn stop event failure');
    end`);

  expect(() => store.settleTurn(turn.id, "completed", "final_response")).toThrow("forced turn stop event failure");
  expect(store.loadTurn(turn.id).status).toBe("running");
  expect(store.listEvents(session.id).some((event) => event.type === "loop_stop")).toBe(false);
});

test("terminal turn transitions are idempotent after the first settlement", async () => {
  const store = new SqliteStore(join(root(), ".farai"));
  const session = await store.createSession({ workspace: "/tmp", model: "model-a" });
  const turn = store.createTurn(session.id, "request");

  const settled = store.settleTurn(turn.id, "cancelled", "cancelled", "user cancel");
  const repeated = store.settleTurn(turn.id, "failed", "planner_error", "late failure");

  expect(settled.status).toBe("cancelled");
  expect(repeated).toEqual(settled);
  expect(store.listEvents(session.id).filter((event) => event.type === "loop_stop")).toHaveLength(1);
});

test("stale compaction commits are rejected without replacing the winning boundary", async () => {
  const store = new SqliteStore(join(root(), ".farai"));
  const session = await store.createSession({ workspace: "/tmp", model: "model-a" });
  const turn = store.createTurn(session.id, "request");
  const message = store.createMessage({ sessionId: session.id, turnId: turn.id, role: "user" });
  store.addPart({ sessionId: session.id, turnId: turn.id, messageId: message.id, type: "text", payload: { text: "request" } });
  const winning = store.commitCompaction({
    sessionId: session.id,
    trigger: "manual",
    summary: "winning summary",
    throughMessageRowId: store.maxMessageRowId(session.id),
    expectedPreviousBoundaryId: null
  });

  expect(() => store.commitCompaction({
    sessionId: session.id,
    trigger: "manual",
    summary: "stale summary",
    throughMessageRowId: store.maxMessageRowId(session.id),
    expectedPreviousBoundaryId: null
  })).toThrow("compaction conflict");
  expect(store.latestCompactionBoundary(session.id)).toEqual(winning);
  expect(store.loadSession(session.id).summary).toBe("winning summary");
});
