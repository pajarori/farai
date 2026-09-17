import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../src/agent-core/runtime";
import type { ConversationEntry, PlannerAction, PlannerInput, PlannerProvider } from "../src/agent-core/provider";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class RecordingPlanner implements PlannerProvider {
  name = "recording";
  lastHistory: ConversationEntry[] = [];
  lastSummary: string | undefined;
  async plan(input: PlannerInput): Promise<PlannerAction[]> {
    this.lastHistory = input.history;
    this.lastSummary = input.compactedSummary;
    return [{ kind: "respond", text: "ok" }];
  }
}

test("auto-compaction commits a boundary and continues on a fresh visible message", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-compact-ws-"));
  const { registerTool, unregisterTool } = await import("../src/agent-tools/registry");
  const noop = {
    name: "test_noop_compact",
    description: "noop",
    inputSchema: {},
    mutates: false,
    timeoutMs: 1_000,
    parallel: true,
    renderHuman: (r: { summary: string }) => r.summary,
    renderModel: (r: { summary: string }) => r.summary,
    run: async () => ({ ok: true, summary: `tool evidence ${"x".repeat(9_000)}` })
  };
  registerTool(noop as never);

  class OverThresholdPlanner implements PlannerProvider {
    name = "over";
    contextWindow = 12_000;
    maxOutputTokens = 1_000;
    normalCalls = 0;
    compactionCalls = 0;
    normalInputs: PlannerInput[] = [];
    async plan(input: PlannerInput): Promise<PlannerAction[]> {
      if (input.tools.length === 0 && (input.userText ?? "").includes("CONTEXT CHECKPOINT COMPACTION")) {
        this.compactionCalls += 1;
        return [{ kind: "respond", text: `<summary>SUMMARY-${this.compactionCalls}</summary>` }];
      }
      this.normalCalls += 1;
      this.normalInputs.push(input);
      if (this.normalCalls >= 4) return [{ kind: "respond", text: "done" }];
      return [{ kind: "tool", tool: "test_noop_compact", args: {}, rationale: "" }];
    }
  }

  let runtime: AgentRuntime | undefined;
  try {
    const planner = new OverThresholdPlanner();
    runtime = new AgentRuntime(workspace, planner);
    const created = await runtime.createSession();
    const session = runtime.updateSession(created.id, { toolScope: [noop.name] });
    const result = await runtime.prompt(session, `do a long multi-step task ${"context ".repeat(6_000)}`);
    expect(result.response).toContain("done");
    const boundaries = runtime.store.database().query("select * from compaction_boundaries where session_id = $session order by rowid asc")
      .all({ $session: session.id }) as Array<{ pre_compact_tokens: number; post_compact_tokens: number }>;
    expect(boundaries).toHaveLength(2);
    expect(boundaries.every((boundary) => boundary.post_compact_tokens < boundary.pre_compact_tokens)).toBe(true);
    expect(runtime.store.latestCompactionBoundary(session.id)).toMatchObject({ trigger: "auto", summary: "SUMMARY-2" });
    expect(planner.normalInputs[0]?.history.at(-1)).toMatchObject({ role: "context", text: expect.stringContaining("SUMMARY-") });
    expect(planner.normalInputs.at(-1)?.history.at(-1)).toMatchObject({ role: "context", text: expect.stringContaining("SUMMARY-") });
    const visible = runtime.store.listVisibleMessages(session.id);
    expect(visible.some((message) => message.parts.some((part) => part.type === "text" && (part.payload as { text?: string }).text === "done"))).toBe(true);
  } finally {
    await runtime?.shutdown();
    unregisterTool(noop as never);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("failed auto compaction preserves history instead of replacing it with a lossy fallback", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-compact-fallback-"));
  dirs.push(workspace);
  class MalformedPlanner implements PlannerProvider {
    name = "model";
    compactionMode = "model" as const;
    async plan(input: PlannerInput): Promise<PlannerAction[]> {
      if (input.tools.length === 0) return [{ kind: "respond", text: "<analysis>provider stopped before producing a summary" }];
      return [{ kind: "respond", text: "done" }];
    }
  }
  const runtime = new AgentRuntime(workspace, new MalformedPlanner());
  const created = await runtime.createSession();
  const session = runtime.updateSession(created.id, { toolScope: ["file_read"] });
  await runtime.prompt(session, `continue this task ${"context ".repeat(1200)}`);

  const before = runtime.store.listContextMessages(session.id);
  await expect(runtime.compactSessionWithPlanner(runtime.loadSession(session.id), new MalformedPlanner(), { trigger: "auto" })).rejects.toThrow("incomplete private analysis");
  expect(runtime.store.latestCompactionBoundary(session.id)).toBeUndefined();
  expect(runtime.store.listContextMessages(session.id)).toEqual(before);
  await runtime.shutdown();
});

test("an expanding auto-compaction fails closed instead of compacting forever", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-compact-ineffective-"));
  dirs.push(workspace);
  class ExpandingPlanner implements PlannerProvider {
    name = "expanding";
    contextWindow = 12_000;
    maxOutputTokens = 1_000;
    compactionCalls = 0;
    normalCalls = 0;
    async plan(input: PlannerInput): Promise<PlannerAction[]> {
      if (input.tools.length === 0 && (input.userText ?? "").includes("CONTEXT CHECKPOINT COMPACTION")) {
        this.compactionCalls += 1;
        return [{ kind: "respond", text: `<summary>${"oversized ".repeat(4_000)}</summary>` }];
      }
      this.normalCalls += 1;
      return [{ kind: "respond", text: "should not be reached" }];
    }
  }

  const planner = new ExpandingPlanner();
  const runtime = new AgentRuntime(workspace, planner);
  const created = await runtime.createSession();
  const session = runtime.updateSession(created.id, { toolScope: ["file_read"] });
  const result = await runtime.prompt(session, `trigger compaction ${"context ".repeat(4_000)}`);
  const turn = runtime.store.listTurns(session.id)[0];
  const boundaryCount = runtime.store.database().query("select count(*) as count from compaction_boundaries where session_id = $session")
    .get({ $session: session.id }) as { count: number };

  expect(planner.compactionCalls).toBe(1);
  expect(planner.normalCalls).toBe(0);
  expect(boundaryCount.count).toBe(0);
  expect(runtime.loadSession(session.id).summary).toBeUndefined();
  expect(runtime.store.listVisibleMessages(session.id).length).toBeGreaterThan(0);
  expect(result.response).toContain("did not reduce active context");
  expect(turn?.stopReason).toBe("context_budget");
  await runtime.shutdown();
});

test("manual compaction accepts short nonempty history like Codex", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-compact-tiny-"));
  dirs.push(workspace);
  class CountingPlanner implements PlannerProvider {
    name = "model";
    calls = 0;
    async plan(): Promise<PlannerAction[]> { this.calls += 1; return [{ kind: "respond", text: "summary" }]; }
  }
  const planner = new CountingPlanner();
  const runtime = new AgentRuntime(workspace, planner);
  const session = await runtime.createSession();
  await runtime.prompt(session, "hi");
  planner.calls = 0;
  await runtime.compactSessionWithPlanner(session, planner, { trigger: "manual" });
  expect(planner.calls).toBe(1);
  expect(runtime.store.latestCompactionBoundary(session.id)).toBeDefined();
});

test("manual model compaction commits a boundary and hides old messages without deleting them", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-compact-model-"));
  dirs.push(workspace);
  class CompactPlanner implements PlannerProvider {
    name = "model";
    async plan(input: PlannerInput): Promise<PlannerAction[]> {
      if (input.tools.length !== 0) throw new Error("compactor must not receive tools");
      return [{ kind: "respond", text: "<analysis>draft</analysis><summary>durable model summary</summary>" }];
    }
  }
  const planner = new CompactPlanner();
  const runtime = new AgentRuntime(workspace, planner);
  const session = await runtime.createSession();
  await runtime.prompt(session, `first request ${"context ".repeat(1200)}`);
  const fullBefore = runtime.store.listMessages(session.id);

  const compacted = await runtime.compactSessionWithPlanner(session, planner, { trigger: "manual" });

  expect(compacted.summary).toBe("durable model summary");
  expect(runtime.store.latestCompactionBoundary(session.id)).toMatchObject({ trigger: "manual", summary: "durable model summary" });
  expect(runtime.store.listVisibleMessages(session.id)).toEqual([]);
  expect(runtime.store.listMessages(session.id)).toEqual(fullBefore);
});

test("failed manual compaction leaves transcript and boundary untouched", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-compact-fail-"));
  dirs.push(workspace);
  class FailingPlanner implements PlannerProvider {
    name = "model";
    async plan(): Promise<PlannerAction[]> { throw new Error("summary unavailable"); }
  }
  const planner = new FailingPlanner();
  const runtime = new AgentRuntime(workspace, planner);
  const session = await runtime.createSession();
  await runtime.prompt(session, `keep this ${"context ".repeat(1200)}`);
  const before = runtime.store.listMessages(session.id);

  await expect(runtime.compactSessionWithPlanner(session, planner, { trigger: "manual" })).rejects.toThrow("summary unavailable");
  expect(runtime.store.latestCompactionBoundary(session.id)).toBeUndefined();
  expect(runtime.store.listMessages(session.id)).toEqual(before);
  expect(runtime.loadSession(session.id).summary).toBeUndefined();
});

test("cancelled compaction cannot commit after a provider ignores the abort", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-compact-cancel-"));
  dirs.push(workspace);
  const controller = new AbortController();
  class CancellingPlanner implements PlannerProvider {
    name = "cancelling";
    async plan(input: PlannerInput): Promise<PlannerAction[]> {
      if ((input.userText ?? "").includes("CONTEXT CHECKPOINT COMPACTION")) {
        controller.abort("user cancelled");
        return [{ kind: "respond", text: "summary that must not commit" }];
      }
      return [{ kind: "respond", text: "seeded" }];
    }
  }
  const planner = new CancellingPlanner();
  const runtime = new AgentRuntime(workspace, planner);
  const session = await runtime.createSession();
  await runtime.prompt(session, `keep this context ${"context ".repeat(1200)}`);

  await expect(runtime.compactSessionWithPlanner(session, planner, { trigger: "manual", signal: controller.signal })).rejects.toThrow("compaction cancelled");
  expect(runtime.store.latestCompactionBoundary(session.id)).toBeUndefined();
  expect(runtime.loadSession(session.id).summary).toBeUndefined();
});

test("compaction summarizes an immutable message snapshot and leaves later messages active", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-compact-snapshot-"));
  dirs.push(workspace);
  class SnapshotPlanner implements PlannerProvider {
    name = "snapshot";
    compactionHistory: ConversationEntry[] = [];
    async plan(input: PlannerInput): Promise<PlannerAction[]> {
      if ((input.userText ?? "").includes("CONTEXT CHECKPOINT COMPACTION")) {
        this.compactionHistory = input.history;
        return [{ kind: "respond", text: "snapshot summary" }];
      }
      return [{ kind: "respond", text: "seeded" }];
    }
  }
  const planner = new SnapshotPlanner();
  const runtime = new AgentRuntime(workspace, planner);
  const session = await runtime.createSession();
  await runtime.prompt(session, `initial request ${"context ".repeat(1200)}`);
  const originalMaxMessageRowId = runtime.store.maxMessageRowId.bind(runtime.store);
  let inserted = false;
  runtime.store.maxMessageRowId = (sessionId: string): number => {
    const through = originalMaxMessageRowId(sessionId);
    if (!inserted) {
      inserted = true;
      const lateTurn = runtime.store.createTurn(sessionId, "late request");
      const lateMessage = runtime.store.createMessage({ sessionId, turnId: lateTurn.id, role: "user" });
      runtime.store.addPart({ sessionId, turnId: lateTurn.id, messageId: lateMessage.id, type: "text", payload: { text: "late message after snapshot" } });
    }
    return through;
  };

  await runtime.compactSessionWithPlanner(session, planner, { trigger: "manual" });

  expect(planner.compactionHistory.some((entry) => entry.role === "user" && entry.text.includes("late message after snapshot"))).toBe(false);
  expect(runtime.store.listVisibleMessages(session.id).some((message) => message.parts.some((part) => part.type === "text" && (part.payload as { text?: string }).text === "late message after snapshot"))).toBe(true);
});

test("deterministic repeated compaction carries the prior summary forward", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-compact-rolling-"));
  dirs.push(workspace);
  class DeterministicPlanner implements PlannerProvider {
    name = "deterministic";
    compactionMode = "deterministic" as const;
    async plan(): Promise<PlannerAction[]> { return [{ kind: "respond", text: "ok" }]; }
  }
  const planner = new DeterministicPlanner();
  const runtime = new AgentRuntime(workspace, planner);
  const session = await runtime.createSession();
  await runtime.prompt(session, `FIRST-DISTINCT-REQUEST ${"context ".repeat(1200)}`);
  const first = await runtime.compactSessionWithPlanner(session, planner, { trigger: "manual" });
  await runtime.prompt(first, `SECOND-DISTINCT-REQUEST ${"context ".repeat(1200)}`);
  const second = await runtime.compactSessionWithPlanner(runtime.loadSession(session.id), planner, { trigger: "manual" });

  expect(second.summary).toContain("Prior compacted context:");
  expect(second.summary).toContain("FIRST-DISTINCT-REQUEST");
  expect(second.summary).toContain("SECOND-DISTINCT-REQUEST");
});

test("once a session is compacted, prior-turn history is scoped out and replaced by the summary", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-compact-"));
  dirs.push(workspace);
  const planner = new RecordingPlanner();
  const runtime = new AgentRuntime(workspace, planner);
  const session = await runtime.createSession();

  await runtime.prompt(session, "first request about the target");
  const watermark = new Date(Date.now() + 1).toISOString();
  runtime.store.database().query("update sessions set summary = $summary, summary_updated_at = $watermark where id = $id")
    .run({ $summary: "Summary covering the first request.", $watermark: watermark, $id: session.id });
  await Bun.sleep(2);

  await runtime.prompt(runtime.loadSession(session.id), "second request about the endpoint");

  const userTexts = planner.lastHistory.filter((entry) => entry.role === "user").map((entry) => (entry as { text: string }).text);
  expect(userTexts.some((text) => text.includes("second request"))).toBe(true);
  expect(userTexts.some((text) => text.includes("first request"))).toBe(false);
  expect(planner.lastSummary).toContain("Summary covering the first request.");
});

test("compaction retains the active user task and durable security state across restart", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-compact-retained-"));
  dirs.push(workspace);
  class RetainedPlanner implements PlannerProvider {
    name = "retained";
    compactionMode = "model" as const;
    normalInputs: PlannerInput[] = [];
    async plan(input: PlannerInput): Promise<PlannerAction[]> {
      if ((input.userText ?? "").includes("CONTEXT CHECKPOINT COMPACTION")) {
        return [{ kind: "respond", text: "model handoff summary" }];
      }
      this.normalInputs.push(input);
      return [{ kind: "respond", text: "continued" }];
    }
  }
  const planner = new RetainedPlanner();
  const runtime = new AgentRuntime(workspace, planner);
  const session = await runtime.createSession({ title: "htb 975" });
  const request = `solve #975 interactively and submit the final flag before creating evidence and a finding; source uses Template(result).render() and Font4 passes through \${} ${"context ".repeat(1200)}`;
  await runtime.prompt(session, request);
  runtime.store.replacePlan(session.id, [
    { step: "Exploit the template injection", status: "completed" },
    { step: "Submit the final flag", status: "in_progress" },
    { step: "Record verified evidence", status: "pending" }
  ]);
  runtime.store.createTodo({ sessionId: session.id, text: "submit the final flag, then create evidence and finding", status: "in_progress", priority: "high" });
  runtime.store.saveEvidence({ id: "evidence-975", sessionId: session.id, source: "http", title: "Mako SSTI response", summary: "payload returned HTB{proof}", createdAt: new Date().toISOString() });
  runtime.store.saveFinding({ id: "finding-975", sessionId: session.id, title: "Mako server-side template injection", severity: "critical", cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", cvssScore: 9.8, target: "challenge-975", evidenceIds: ["evidence-975"], impact: "remote command execution", reproduction: "send the Mako expression in the text parameter", remediation: "never render user-controlled template source", status: "verified" });
  await runtime.compactSessionWithPlanner(runtime.loadSession(session.id), planner, { trigger: "manual" });
  await runtime.shutdown();

  const resumedPlanner = new RetainedPlanner();
  const resumedRuntime = new AgentRuntime(workspace, resumedPlanner);
  await resumedRuntime.prompt(resumedRuntime.loadSession(session.id), "lanjutkan");
  const resumed = resumedPlanner.normalInputs.at(-1)!;
  const userTexts = resumed.history.filter((entry) => entry.role === "user").map((entry) => entry.text);
  expect(userTexts.some((text) => text.includes("solve #975 interactively"))).toBe(true);
  expect(userTexts.some((text) => text === "lanjutkan")).toBe(true);
  expect(resumed.compactedSummary).toContain("model handoff summary");
  expect(resumed.compactedSummary).toContain("evidence-975");
  expect(resumed.compactedSummary).toContain("finding-975");
  expect(resumed.compactedSummary).toContain("submit the final flag");
  expect(resumed.compactedSummary).toContain("Submit the final flag");
  await resumedRuntime.shutdown();
});

test("provider overflow triggers compaction even when the local estimate fits", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-overflow-recovery-"));
  dirs.push(workspace);
  let normalCalls = 0;
  let compactCalls = 0;
  const planner: PlannerProvider = {
    name: "overflow-recovery",
    async plan(input) {
      if (input.toolChoice === "none") {
        compactCalls++;
        return [{ kind: "respond", text: "Continue the requested work." }];
      }
      normalCalls++;
      if (normalCalls === 1) throw new Error("context_length_exceeded");
      return [{ kind: "respond", text: "recovered" }];
    }
  };
  const runtime = new AgentRuntime(workspace, planner);
  const session = runtime.updateSession((await runtime.createSession()).id, { toolScope: ["file_read"] });
  const result = await runtime.prompt(session, "continue this task ".repeat(6000));
  expect(result.response).toContain("recovered");
  expect(compactCalls).toBe(1);
  expect(normalCalls).toBe(2);
  await runtime.shutdown();
});

test("persisted replacement history is stable across repeated compaction and restart", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-replacement-replay-"));
  dirs.push(workspace);
  const planner: PlannerProvider = { name: "summary", plan: async () => [{ kind: "respond", text: "handoff" }] };
  let runtime = new AgentRuntime(workspace, planner);
  const session = runtime.updateSession((await runtime.createSession()).id, { toolScope: ["file_read"] });
  await runtime.prompt(session, "OLD-DROPPED-USER");
  await runtime.prompt(session, "latest user ".repeat(12000));
  await runtime.compactSessionWithPlanner(session, planner);
  const replacement = runtime.store.latestCompactionBoundary(session.id)!.replacementHistory!;
  expect(JSON.stringify(replacement)).not.toContain("OLD-DROPPED-USER");
  await runtime.shutdown();
  runtime = new AgentRuntime(workspace, planner);
  expect(runtime.store.latestCompactionBoundary(session.id)!.replacementHistory).toEqual(replacement);
  await runtime.prompt(runtime.loadSession(session.id), "new steering");
  await runtime.compactSessionWithPlanner(session, planner);
  const next = runtime.store.latestCompactionBoundary(session.id)!.replacementHistory!;
  expect(JSON.stringify(next)).not.toContain("OLD-DROPPED-USER");
  expect(next.filter((entry) => entry.role === "context")).toHaveLength(1);
  expect(next.at(-2)).toEqual({ role: "user", text: "new steering" });
  await runtime.shutdown();
});

test("streaming provider overflow uses the same compaction request and resumes with summary history", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-stream-overflow-"));
  dirs.push(workspace);
  const requests: import("../src/agent-core/provider/protocol").ChatRequest[] = [];
  const provider: import("../src/agent-core/provider/protocol").ChatProvider = {
    name: "stream-overflow", protocol: "openai-chat",
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        yield { type: "error", status: 400, message: "context_length_exceeded" };
        return;
      }
      yield { type: "text_delta", delta: request.toolChoice === "none" ? "stream handoff" : "stream recovered" };
      yield { type: "message_complete", finishReason: "stop" };
    }
  };
  const runtime = new AgentRuntime(workspace, provider);
  const session = runtime.updateSession((await runtime.createSession()).id, { toolScope: ["file_read"] });
  const result = await runtime.prompt(session, "continue the work ".repeat(7000));
  expect(result.response).toContain("stream recovered");
  expect(requests).toHaveLength(3);
  expect(requests[1]!.tools).toEqual([]);
  expect(requests[1]!.messages.at(-1)?.text).toContain("CONTEXT CHECKPOINT COMPACTION");
  expect(requests[1]!.system).toBe(requests[0]!.system);
  expect(requests[2]!.system).not.toContain("stream handoff");
  expect(requests[2]!.messages.at(-1)).toMatchObject({ role: "context", text: expect.stringContaining("stream handoff") });
  await runtime.shutdown();
});
