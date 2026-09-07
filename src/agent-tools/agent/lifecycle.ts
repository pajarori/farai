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
  title: { type: "string", description: "optional concise label for the child; omit to derive it from the prompt" },
  prompt: { type: "string", description: "complete bounded task contract with objective, scope, useful context, constraints, and expected deliverable; give parallel children non-overlapping ownership" },
  lane: { type: "string", description: "capability profile: explore for read-only inspection, recon for discovery shell, web for browser and HTTP work, code for edits, verify for independent validation, or an explicitly configured specialist lane" },
  tools: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" }, description: "optional exact tool-name subset; omit to use the selected lane's normal scope, and never request tools unavailable to the parent" },
  model: { type: "string", description: "optional deliberate model override; omit to inherit the parent model" },
  mode: { type: "string", enum: ["attached", "detached"], description: "use the string attached to wait for the result, or detached to return immediately; omit for attached. there is no detached boolean field" }
} as const;

function parseDelegation(args: Record<string, unknown>, context: Parameters<ToolDefinition["run"]>[1], resumeSessionId?: string) {
  const prompt = asString(args.prompt, "prompt").trim();
  if (!prompt) throw new Error("prompt must be a non-empty string");
  const mode: "attached" | "detached" = args.mode === "detached" ? "detached" : "attached";
  const lane = maybeString(args.lane);
  const model = maybeString(args.model);
  const tools = Array.isArray(args.tools)
    ? [...new Set(args.tools.map((item) => asString(item, "tools[]").trim()).filter(Boolean))]
    : undefined;
  if (Array.isArray(args.tools) && !tools?.length) throw new Error("tools must contain at least one non-empty tool name");
  const title = normalizeSessionTitle(maybeString(args.title) ?? (resumeSessionId ? childTitle(context, resumeSessionId) : titleFromPrompt(prompt, lane ? `${lane} task` : "subagent task")));
  return { title, prompt, mode, lane, tools, model };
}

async function delegate(args: Record<string, unknown>, context: Parameters<ToolDefinition["run"]>[1], resumeSessionId?: string): Promise<ToolResult> {
  const input = parseDelegation(args, context, resumeSessionId);
  const result = await requireDelegation(context)({
    title: input.title,
    prompt: input.prompt,
    mode: input.mode,
    ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
    ...(input.lane ? { lane: input.lane } : {}),
    ...(input.tools?.length ? { tools: input.tools } : {}),
    ...(input.model ? { model: input.model } : {})
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
  description: "Start one child agent for a concrete bounded task. Pass prompt and optionally title, lane, tools, model, and mode. To run in the background pass mode: \"detached\"; never pass detached: true. Omitted mode means attached and waits for the child result. Detached work returns a child session id and job id for agent_list, agent_wait, agent_message, agent_interrupt, or agent_close.",
  inputSchema: { type: "object", required: ["prompt"], properties: spawnProperties, additionalProperties: false },
  mutates: true,
  timeoutMs: Number.POSITIVE_INFINITY,
  parallel: true,
  concurrencyScope: "session",
  renderHuman: agentResultRenderer,
  renderModel: agentResultRenderer,
  run: async (args, context) => { assertObject(args, "args"); return await delegate(args, context); }
};

export const agentListTool: ToolDefinition = {
  name: "agent_list",
  description: "List every child agent owned by the current session with its sessionId, title, mode, lane, and lifecycle state. Call with an empty object. Use returned sessionId values with agent_wait, agent_message, agent_followup, agent_interrupt, or agent_close; do not use a background job id where a session id is required.",
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
  description: "Wait until any selected child agent becomes idle or terminal, or until the bounded timeout expires, then return the state of all selected agents. Use this for synchronization; it neither sends instructions nor starts another child turn.",
  inputSchema: {
    type: "object",
    properties: {
      sessionIds: { type: "array", uniqueItems: true, items: { type: "string" }, description: "child session ids returned by agent_spawn or agent_list; omit to wait for any child owned by this parent" },
      timeoutSeconds: { type: "number", minimum: 0, maximum: 60, description: "bounded wait duration from 0 to 60 seconds; omit for 30 seconds" }
    },
    additionalProperties: false
  },
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
  description: "Send additional steering or constraints to a child agent during its active turn. This does not create a new turn and cannot resume an idle child; use agent_followup for a new task after the child becomes idle.",
  inputSchema: {
    type: "object",
    required: ["sessionId", "message"],
    properties: {
      sessionId: { type: "string", description: "active child session id returned by agent_spawn or agent_list" },
      message: { type: "string", description: "new constraint, correction, or useful context for the child's current turn; this does not start a new turn" }
    },
    additionalProperties: false
  },
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
    description: "Start a new bounded turn on an idle child agent while preserving its conversation, model, lane, and tool scope. Use agent_message for steering during an active turn and agent_spawn when a separate child context is needed.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "prompt"],
      properties: {
        sessionId: { type: "string", description: "idle child session id returned by agent_spawn or agent_list" },
        prompt: { type: "string", description: "next bounded task that benefits from the child's existing context" },
        mode: { type: "string", enum: ["attached", "detached"], description: "use attached to wait or detached to return immediately; omit for attached. there is no detached boolean field" }
      },
      additionalProperties: false
    },
    mutates: true,
    timeoutMs: Number.POSITIVE_INFINITY,
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
  description: "Cancel a child agent's currently active turn while preserving the child session for later follow-up. Use this when current work should stop but its context remains useful; use agent_close to terminate work and archive the child.",
  inputSchema: {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string", description: "active child session id returned by agent_spawn or agent_list" },
      reason: { type: "string", description: "optional concise reason delivered to lifecycle records" }
    },
    additionalProperties: false
  },
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
  description: "Stop any outstanding child-agent work and archive that child session. Use this when the child is no longer needed; use agent_interrupt when only the current turn should stop and future follow-up may still be useful.",
  inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string", description: "child session id returned by agent_spawn or agent_list" } }, additionalProperties: false },
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
