import type { AgentLifecycleEntry, ToolDefinition, ToolResult } from "../../types";
import { normalizeSessionTitle, titleFromPrompt } from "../../session-title";
import { assertObject, asString, maybeString } from "../../utils";

function requireDelegation(context: Parameters<ToolDefinition["run"]>[1]) {
  if (!context.delegateSession) throw new Error("subagent delegation is unavailable in this runtime");
  return context.delegateSession;
}

function requireControl(context: Parameters<ToolDefinition["run"]>[1]) {
  if (!context.agentControl) throw new Error("subagent lifecycle control is unavailable in this runtime");
  return context.agentControl;
}

function childTitle(context: Parameters<ToolDefinition["run"]>[1], sessionId: string, fallback = "subagent"): string {
  const child = context.store.loadSession?.(sessionId);
  if (!child || child.parentId !== context.session.id) throw new Error(`subagent session ${sessionId} does not belong to this parent`);
  return child.title ?? fallback;
}

function lifecycleLine(entry: AgentLifecycleEntry): string {
  const label = entry.title ? `${entry.title} (${entry.sessionId})` : entry.sessionId;
  const details = [entry.status, entry.mode, entry.lane].filter(Boolean).join(" · ");
  return `${label}: ${details}${entry.error ? ` · ${entry.error}` : ""}`;
}

function lifecycleResult(summary: string, entries: AgentLifecycleEntry[]): ToolResult {
  return { ok: true, summary, output: entries.length ? entries.map(lifecycleLine).join("\n") : "no subagents", metadata: { agents: entries } };
}

const spawnProperties = {
  title: { type: "string" },
  prompt: { type: "string" },
  lane: { type: "string", description: "built-in explore, recon, web, code, or verify lane, or a configured specialist lane" },
  tools: { type: "array", minItems: 1, items: { type: "string" }, description: "optional restriction that cannot exceed the parent scope" },
  mode: { type: "string", enum: ["attached", "detached"] }
} as const;

function parseDelegation(args: Record<string, unknown>, context: Parameters<ToolDefinition["run"]>[1], resumeSessionId?: string) {
  const prompt = asString(args.prompt, "prompt").trim();
  if (!prompt) throw new Error("prompt must be a non-empty string");
  const mode: "attached" | "detached" = args.mode === "detached" ? "detached" : "attached";
  const lane = maybeString(args.lane);
  const tools = Array.isArray(args.tools)
    ? [...new Set(args.tools.map((item) => asString(item, "tools[]").trim()).filter(Boolean))]
    : undefined;
  if (Array.isArray(args.tools) && !tools?.length) throw new Error("tools must contain at least one non-empty tool name");
  if (resumeSessionId && (lane || tools)) throw new Error("resumed subagents preserve their original lane and tool scope");
  if (mode === "detached" && !resumeSessionId && !lane && !tools?.length) throw new Error("detached subagents require an explicit lane or tool scope");
  const title = normalizeSessionTitle(maybeString(args.title) ?? (resumeSessionId ? childTitle(context, resumeSessionId) : titleFromPrompt(prompt, lane ? `${lane} task` : "subagent task")));
  return { title, prompt, mode, lane, tools };
}

async function delegate(args: Record<string, unknown>, context: Parameters<ToolDefinition["run"]>[1], resumeSessionId?: string): Promise<ToolResult> {
  const input = parseDelegation(args, context, resumeSessionId);
  const result = await requireDelegation(context)({
    title: input.title,
    prompt: input.prompt,
    mode: input.mode,
    ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
    ...(input.lane ? { lane: input.lane } : {}),
    ...(input.tools?.length ? { tools: input.tools } : {})
  });
  return {
    ok: true,
    summary: input.mode === "detached" ? `${input.title} is running in the background` : `${input.title} returned a result`,
    ...(result.response ? { output: result.response } : {}),
    ...(result.jobId ? { jobId: result.jobId } : {}),
    ...(input.mode === "detached" ? { status: "running_background" as const } : {}),
    metadata: { kind: "agent_lifecycle", operation: resumeSessionId ? "resume" : "spawn", mode: input.mode, title: input.title, childSessionId: result.sessionId, ...(input.lane ? { lane: input.lane } : {}) }
  };
}

const agentResultRenderer = (result: ToolResult): string => result.output ?? result.summary;

export const agentSpawnTool: ToolDefinition = {
  name: "agent_spawn",
  description: "Start a bounded leaf subagent. Attached waits; detached runs independently and requires a lane or tool scope.",
  inputSchema: { type: "object", required: ["prompt"], properties: spawnProperties, additionalProperties: false },
  mutates: true,
  timeoutMs: 900_000,
  parallel: true,
  concurrencyScope: "session",
  renderHuman: agentResultRenderer,
  renderModel: agentResultRenderer,
  run: async (args, context) => { assertObject(args, "args"); return await delegate(args, context); }
};

export const agentListTool: ToolDefinition = {
  name: "agent_list",
  description: "List child agents owned by this session with their lifecycle state.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  mutates: false,
  timeoutMs: 10_000,
  parallel: true,
  concurrencyScope: "session",
  renderHuman: agentResultRenderer,
  renderModel: agentResultRenderer,
  run: async (_args, context) => lifecycleResult("listed subagents", requireControl(context).list())
};

export const agentWaitTool: ToolDefinition = {
  name: "agent_wait",
  description: "Wait until any selected child agent reaches a terminal or idle state. Returns all selected states on timeout.",
  inputSchema: { type: "object", properties: { sessionIds: { type: "array", items: { type: "string" } }, timeoutSeconds: { type: "number", minimum: 0, maximum: 60 } }, additionalProperties: false },
  mutates: false,
  timeoutMs: 65_000,
  parallel: true,
  concurrencyScope: "session",
  renderHuman: agentResultRenderer,
  renderModel: agentResultRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const sessionIds = Array.isArray(args.sessionIds) ? [...new Set(args.sessionIds.map((item) => asString(item, "sessionIds[]")))] : undefined;
    const seconds = typeof args.timeoutSeconds === "number" ? Math.max(0, Math.min(60, args.timeoutSeconds)) : 30;
    const entries = await requireControl(context).wait(sessionIds, seconds * 1000, context.signal);
    return lifecycleResult("waited for subagents", entries);
  }
};

export const agentMessageTool: ToolDefinition = {
  name: "agent_message",
  description: "Send steering text to a child agent that is currently running. This does not start a new child turn.",
  inputSchema: { type: "object", required: ["sessionId", "message"], properties: { sessionId: { type: "string" }, message: { type: "string" } }, additionalProperties: false },
  mutates: true,
  timeoutMs: 10_000,
  parallel: true,
  concurrencyScope: "session",
  renderHuman: agentResultRenderer,
  renderModel: agentResultRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const sessionId = asString(args.sessionId, "sessionId");
    const message = asString(args.message, "message").trim();
    if (!message) throw new Error("message must be non-empty");
    requireControl(context).message(sessionId, message);
    return { ok: true, summary: `message delivered to ${childTitle(context, sessionId)}`, output: `delivered to ${sessionId}` };
  }
};

function followupTool(): ToolDefinition {
  return {
    name: "agent_followup",
    description: "Give an idle child agent a new bounded task, preserving its model, lane, tool scope, and conversation context.",
    inputSchema: { type: "object", required: ["sessionId", "prompt"], properties: { sessionId: { type: "string" }, prompt: { type: "string" }, mode: { type: "string", enum: ["attached", "detached"] } }, additionalProperties: false },
    mutates: true,
    timeoutMs: 900_000,
    parallel: true,
    concurrencyScope: "session",
    renderHuman: agentResultRenderer,
    renderModel: agentResultRenderer,
    run: async (args, context) => {
      assertObject(args, "args");
      return await delegate(args, context, asString(args.sessionId, "sessionId"));
    }
  };
}

export const agentFollowupTool = followupTool();

export const agentInterruptTool: ToolDefinition = {
  name: "agent_interrupt",
  description: "Interrupt the active turn of a child agent without archiving its session.",
  inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" }, reason: { type: "string" } }, additionalProperties: false },
  mutates: true,
  timeoutMs: 15_000,
  parallel: true,
  concurrencyScope: "session",
  renderHuman: agentResultRenderer,
  renderModel: agentResultRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const entry = await requireControl(context).interrupt(asString(args.sessionId, "sessionId"), maybeString(args.reason));
    return lifecycleResult(`interrupted ${entry.title ?? entry.sessionId}`, [entry]);
  }
};

export const agentCloseTool: ToolDefinition = {
  name: "agent_close",
  description: "Stop outstanding work for a child agent and archive its session.",
  inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" } }, additionalProperties: false },
  mutates: true,
  timeoutMs: 30_000,
  parallel: true,
  concurrencyScope: "session",
  renderHuman: agentResultRenderer,
  renderModel: agentResultRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const entry = await requireControl(context).close(asString(args.sessionId, "sessionId"));
    return lifecycleResult(`closed ${entry.title ?? entry.sessionId}`, [entry]);
  }
};

export const agentLifecycleTools: ToolDefinition[] = [
  agentSpawnTool,
  agentListTool,
  agentWaitTool,
  agentMessageTool,
  agentFollowupTool,
  agentInterruptTool,
  agentCloseTool
];
