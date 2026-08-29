import type { ToolDefinition } from "../../types";
import { normalizeSessionTitle, titleFromPrompt } from "../../session-title";
import { assertObject, asString, maybeString } from "../../utils";

export const agentTaskTool: ToolDefinition = {
  name: "agent_task",
  description: "Legacy subagent delegation compatibility tool.",
  inputSchema: {
    type: "object",
    required: ["prompt"],
    properties: {
      title: { type: "string" },
      prompt: { type: "string" },
      lane: { type: "string" },
      tools: { type: "array", minItems: 1, items: { type: "string" } },
      mode: { type: "string", enum: ["attached", "detached"] },
      model: { type: "string" },
      sessionId: { type: "string" }
    }
  },
  mutates: true,
  timeoutMs: Number.POSITIVE_INFINITY,
  parallel: true,
  concurrencyScope: "session",
  renderHuman: (result) => result.summary,
  renderModel: (result) => [result.summary, result.output?.slice(0, 4_000)].filter(Boolean).join("\n"),
  run: async (args, context) => {
    assertObject(args, "args");
    if (!context.delegateSession) throw new Error("subagent delegation is unavailable in this runtime");
    const prompt = asString(args.prompt, "prompt").trim();
    if (!prompt) throw new Error("prompt must be a non-empty string");
    const mode = args.mode === "detached" ? "detached" : "attached";
    const sessionId = maybeString(args.sessionId);
    const lane = maybeString(args.lane);
    const model = maybeString(args.model);
    const tools = Array.isArray(args.tools) ? [...new Set(args.tools.map((item) => asString(item, "tools[]").trim()).filter(Boolean))] : undefined;
    if (Array.isArray(args.tools) && !tools?.length) throw new Error("tools must contain at least one non-empty tool name");
    const resumedTitle = sessionId ? context.store.loadSession?.(sessionId)?.title : undefined;
    const title = normalizeSessionTitle(maybeString(args.title) ?? resumedTitle ?? titleFromPrompt(prompt, lane ? `${lane} task` : "subagent task"));
    const result = await context.delegateSession({ title, prompt, mode, ...(sessionId ? { sessionId } : {}), ...(lane ? { lane } : {}), ...(tools?.length ? { tools } : {}), ...(model ? { model } : {}) });
    return {
      ok: true,
      summary: mode === "detached" ? `${title} is running in the background` : `${title} returned a result`,
      ...(result.response ? { output: result.response } : {}),
      ...(result.jobId ? { jobId: result.jobId } : {}),
      ...(mode === "detached" ? { status: "running_background" as const } : {}),
      metadata: { kind: "agent_task", status: mode === "detached" ? "running" : "returned", mode, title, childSessionId: result.sessionId, ...(lane ? { lane } : {}) }
    };
  }
};
