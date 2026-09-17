import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvalSuite, normalizeEvalSuite, runEvalSuite, writeEvalResult, type EvalSuite } from "../src/agent-eval/runner";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("eval suites are strict, bounded, and require explicit metrics", () => {
  expect(() => normalizeEvalSuite({ schemaVersion: 2, cases: [] })).toThrow("schemaVersion must be 1");
  expect(() => normalizeEvalSuite({ schemaVersion: 1, cases: [{ name: "empty", prompts: ["hello"], expect: {} }] })).toThrow("at least one metric");
  expect(() => normalizeEvalSuite({ schemaVersion: 1, cases: [
    { name: "same", prompts: ["hello"], expect: { turnsAtLeast: 1 } },
    { name: "same", prompts: ["again"], expect: { turnsAtLeast: 1 } }
  ] })).toThrow("duplicate eval case name");
  expect(() => normalizeEvalSuite({ schemaVersion: 1, cases: [{ name: "typo", prompts: ["hello"], expect: { event: ["loop_stop"] } }] })).toThrow("unknown field: event");
  expect(() => normalizeEvalSuite({ schemaVersion: 1, cases: [{ name: "bad event", prompts: ["hello"], expect: { events: ["imaginary"] } }] })).toThrow("must be one of");
});

test("eval runner checks tool selection and arguments, records a trace, and cleans isolated workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "farai-eval-test-"));
  roots.push(root);
  const suite: EvalSuite = {
    schemaVersion: 1,
    title: "tool trajectory",
    cases: [{
      name: "note tool",
      planner: "heuristic",
      prompts: ["remember eval target"],
      expect: {
        responseExcludes: ["planner error"],
        toolCalls: [{ tool: "knowledge_manage", status: "done", argsInclude: { operation: "add", args: { text: "remember eval target", tags: ["user"] } } }],
        toolsInOrder: ["knowledge_manage"],
        toolCallsAbsent: ["command_run"],
        plannerErrorsAtMost: 0,
        toolErrorsAtMost: 0
      }
    }]
  };

  const progress: string[] = [];
  const result = await runEvalSuite(suite, { workspacesRoot: root, onProgress: (line) => progress.push(line) });

  expect(result.ok).toBe(true);
  expect(result.suite).toBe("tool trajectory");
  expect(result.suiteHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.results[0]?.trace.toolCalls).toEqual([{ tool: "knowledge_manage", status: "done", args: { operation: "add", args: { text: "remember eval target", tags: ["user"] } } }]);
  expect(result.results[0]?.trace.eventCounts.tool_call).toBe(1);
  expect(progress).toEqual(["[1/1] running note tool", "[1/1] passed note tool"]);
  expect(await readdir(root)).toEqual([]);

  const output = join(root, "result.json");
  writeEvalResult(result, output);
  expect(JSON.parse(await readFile(output, "utf8")).suiteHash).toBe(result.suiteHash);
  expect((await stat(output)).mode & 0o777).toBe(0o600);
});

test("eval runner reports all metric failures and bounds a stalled case", async () => {
  const root = await mkdtemp(join(tmpdir(), "farai-eval-failure-"));
  roots.push(root);
  const failing: EvalSuite = {
    schemaVersion: 1,
    cases: [{
      name: "wrong expectations",
      planner: "heuristic",
      prompts: ["scan the target"],
        expect: { responseIncludes: ["not present"], notesAtLeast: 2, toolCalls: [{ tool: "knowledge_manage" }] }
    }]
  };
  const failed = await runEvalSuite(failing, { workspacesRoot: root });
  expect(failed.ok).toBe(false);
  expect(failed.results[0]?.failures).toEqual([
    "response missing: not present",
    "expected notes >= 2, got 0",
    "expected tool knowledge_manage matching criteria >= 1, got 0"
  ]);

  const stalled = await runEvalSuite({
    schemaVersion: 1,
    cases: [{ name: "stall", planner: "stall", prompts: ["wait forever"], expect: { turnsAtLeast: 1 } }]
  }, { workspacesRoot: root, timeoutMs: 25 });
  expect(stalled.ok).toBe(false);
  expect(stalled.results[0]?.error).toContain("exceeded 25ms timeout");
  expect(stalled.durationMs).toBeLessThan(2_000);
});

test("the built-in eval suite is versioned and passes without external services", async () => {
  const suite = await loadEvalSuite();
  expect(suite.schemaVersion).toBe(1);
  const result = await runEvalSuite(suite);
  expect(result.ok).toBe(true);
  expect(result.passed).toBe(suite.cases.length);
});
