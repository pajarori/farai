import type { ToolDefinition } from "../../types";
import { normalizeSessionTitle, titleFromPrompt } from "../../session-title";
import { assertObject, asString, maybeString } from "../../utils";

export const agentTaskTool: ToolDefinition = {
  name: "agent_task",
  description: "delegate one bounded task to a fresh or resumed leaf subagent. children inherit the parent model. explore is read-only without shell; recon, web, code, and verify include shell, while only code includes workspace writes. use attached mode when its result is required now, or detached mode when the parent can continue independently.",
  inputSchema: {
    type: "object",
    required: ["prompt"],
    properties: {
      title: { type: "string" },
      prompt: { type: "string" },
      lane: { type: "string", description: "built-in explore, recon, web, code, or verify lane, or a configured specialist lane" },
      tools: { type: "array", minItems: 1, items: { type: "string" }, description: "optional restriction that cannot exceed the parent scope" },
      mode: { type: "string", enum: ["attached", "detached"] },
      sessionId: { type: "string", description: "existing child session to resume; omit lane, tools, and model when resuming" }
    }
  },
  mutates: true,
  timeoutMs: 900_000,
  parallel: true,
  concurrencyScope: "session",
  renderHuman: (result) => result.summary,
  renderModel: (result) => {
    const metadata = result.metadata ?? {};
    return [
      result.summary,
      typeof metadata.childSessionId === "string" ? `child_session_id: ${metadata.childSessionId}` : undefined,
      result.output?.slice(0, 4_000)
    ].filter(Boolean).join("\n");
  },
  run: async (args, context) => {
    assertObject(args, "args");
    if (!context.delegateSession) throw new Error("subagent delegation is unavailable in this runtime");
    const prompt = asString(args.prompt, "prompt").trim();
    if (!prompt) throw new Error("prompt must be a non-empty string");
    const mode = args.mode === "detached" ? "detached" : "attached";
    const sessionId = maybeString(args.sessionId);
    const lane = maybeString(args.lane);
    const tools = Array.isArray(args.tools)
      ? [...new Set(args.tools.map((item) => asString(item, "tools[]").trim()).filter(Boolean))]
      : undefined;
    if (Array.isArray(args.tools) && tools?.length === 0) throw new Error("tools must contain at least one non-empty tool name");
    if (mode === "detached" && !sessionId && !lane && !tools?.length) throw new Error("detached subagents require an explicit lane or tool scope");
    if (sessionId && (lane || tools)) throw new Error("resumed subagents preserve their original lane and tool scope");
    const resumedTitle = sessionId ? context.store.loadSession?.(sessionId)?.title : undefined;
    const title = normalizeSessionTitle(
      maybeString(args.title)
        ?? resumedTitle
        ?? titleFromPrompt(prompt, lane ? `${lane} task` : "subagent task")
    );
    const result = await context.delegateSession({
      title,
      prompt,
      mode,
      ...(sessionId ? { sessionId } : {}),
      ...(lane ? { lane } : {}),
      ...(tools?.length ? { tools } : {})
    });
    return {
      ok: true,
      summary: mode === "detached"
        ? `${title} is running in the background`
        : `${title} returned a result`,
      ...(result.response ? { output: result.response } : {}),
      ...(result.jobId ? { jobId: result.jobId } : {}),
      ...(mode === "detached" ? { status: "running_background" as const } : {}),
      metadata: {
        kind: "agent_task",
        status: mode === "detached" ? "running" : "returned",
        mode,
        title,
        childSessionId: result.sessionId,
        ...(lane ? { lane } : {})
      }
    };
  }
};
