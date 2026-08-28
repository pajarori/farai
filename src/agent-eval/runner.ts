import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../agent-core/runtime";
import { HeuristicPlanner, type PlannerAction, type PlannerInput, type PlannerProvider } from "../agent-core/provider";
import type { SessionEvent, TurnStopReason } from "../types";

export type EvalSuite = {
  title?: string;
  cases: EvalCase[];
};

export type EvalCase = {
  name: string;
  planner?: "heuristic" | "malformed-once" | "unknown-tool-once";
  prompts: string[];
  expect?: {
    responseIncludes?: string[];
    events?: SessionEvent["type"][];
    notesAtLeast?: number;
    turnsAtLeast?: number;
    stopReasons?: TurnStopReason[];
  };
};

export type EvalCaseResult = {
  name: string;
  ok: boolean;
  error?: string;
  response?: string;
};

export type EvalRunResult = {
  ok: boolean;
  passed: number;
  failed: number;
  results: EvalCaseResult[];
};

export async function loadEvalSuite(file?: string): Promise<EvalSuite> {
  if (!file) return defaultEvalSuite();
  const parsed = JSON.parse(await Bun.file(file).text()) as EvalSuite;
  if (!Array.isArray(parsed.cases)) throw new Error("eval file must contain cases[]");
  return parsed;
}

export async function runEvalSuite(suite: EvalSuite): Promise<EvalRunResult> {
  const results: EvalCaseResult[] = [];
  for (const item of suite.cases) results.push(await runEvalCase(item));
  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  return { ok: failed === 0, passed, failed, results };
}

async function runEvalCase(item: EvalCase): Promise<EvalCaseResult> {
  const dir = await mkdtemp(join(tmpdir(), "farai-eval-"));
  const runtime = new AgentRuntime(dir, plannerFor(item.planner));
  let response = "";
  try {
    const session = await runtime.createSession();
    for (const prompt of item.prompts) {
      const result = await runtime.prompt(session, prompt);
      response = result.response;
    }
    const events = runtime.store.listEvents(session.id);
    const turns = runtime.store.listTurns(session.id);
    const notes = runtime.store.listNotes(session.id);
    for (const text of item.expect?.responseIncludes ?? []) {
      if (!response.includes(text)) throw new Error(`response missing: ${text}`);
    }
    for (const type of item.expect?.events ?? []) {
      if (!events.some((event) => event.type === type)) throw new Error(`event missing: ${type}`);
    }
    if (item.expect?.notesAtLeast !== undefined && notes.length < item.expect.notesAtLeast) throw new Error(`expected notes >= ${item.expect.notesAtLeast}, got ${notes.length}`);
    if (item.expect?.turnsAtLeast !== undefined && turns.length < item.expect.turnsAtLeast) throw new Error(`expected turns >= ${item.expect.turnsAtLeast}, got ${turns.length}`);
    for (const reason of item.expect?.stopReasons ?? []) {
      if (!turns.some((turn) => turn.stopReason === reason)) throw new Error(`stop reason missing: ${reason}`);
    }
    return { name: item.name, ok: true, response };
  } catch (error) {
    return { name: item.name, ok: false, error: error instanceof Error ? error.message : String(error), response };
  } finally {
    await runtime.shutdown();
  }
}

function plannerFor(name: EvalCase["planner"]): PlannerProvider {
  if (name === "malformed-once") return new MalformedOncePlanner();
  if (name === "unknown-tool-once") return new UnknownToolOncePlanner();
  return new HeuristicPlanner();
}

class MalformedOncePlanner implements PlannerProvider {
  name = "malformed-once";
  private calls = 0;

  async plan(_input: PlannerInput): Promise<PlannerAction[]> {
    this.calls += 1;
    if (this.calls === 1) return [{ kind: "respond", text: "" } as PlannerAction];
    return [{ kind: "respond", text: "Recovered from malformed planner output." }];
  }
}

class UnknownToolOncePlanner implements PlannerProvider {
  name = "unknown-tool-once";
  private calls = 0;

  async plan(_input: PlannerInput): Promise<PlannerAction[]> {
    this.calls += 1;
    if (this.calls === 1) return [{ kind: "tool", tool: "missing_tool", args: {}, rationale: "Exercise stale tool behavior." }];
    return [{ kind: "respond", text: "Recovered from unknown tool." }];
  }
}

function defaultEvalSuite(): EvalSuite {
  return {
    title: "Farai Agent Loop Self-Test",
    cases: [
      {
        name: "note memory",
        prompts: ["remember local target context"],
        expect: { notesAtLeast: 1, events: ["tool_call", "tool_result", "loop_stop"], stopReasons: ["final_response"] }
      },
      {
        name: "missing target guidance",
        prompts: ["scan the target"],
        expect: { responseIncludes: ["Freestyle ready"], events: ["loop_stop"], turnsAtLeast: 1 }
      },
      {
        name: "malformed planner repair",
        planner: "malformed-once",
        prompts: ["trigger malformed output"],
        expect: { responseIncludes: ["Recovered from malformed"], events: ["planner_error"], stopReasons: ["final_response"] }
      },
      {
        name: "unknown tool recovery",
        planner: "unknown-tool-once",
        prompts: ["trigger unknown tool"],
        expect: { responseIncludes: ["Recovered from unknown tool"], events: ["planner_error"], stopReasons: ["final_response"] }
      }
    ]
  };
}
