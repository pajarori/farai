import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { sessionManager, clampYieldMs } from "../shared/session-manager";
import { sessionPollResult } from "../shared/background-result";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { outputTokenLimit } from "../shared/process-output";
export const writeStdinTool: ToolDefinition = {
  name: "command_input", description: "Send input to an active command_run process and return new output.",
  inputSchema: { type: "object", required: ["session_id"], properties: { session_id: { type: "string" }, chars: { type: "string" }, yield_time_ms: { type: "number" }, max_output_tokens: { type: "number" } } },
  mutates: true, timeoutMs: Number.POSITIVE_INFINITY, parallel: true, renderHuman: defaultHumanRenderer, renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const id = asString(args.session_id, "session_id");
    const maxOutputTokens = outputTokenLimit(args.max_output_tokens);
    if (sessionManager.getKind(id) !== "shell") throw new Error("session_id is not an command_run shell session");
    const input = typeof args.chars === "string" ? args.chars : undefined;
    const result = await sessionManager.poll(id, input, clampYieldMs(args.yield_time_ms));
    return sessionPollResult(id, result, sessionManager.getKind(id), maxOutputTokens);
  }
};
