import type { ToolDefinition } from "../../types";
import { normalizeSessionTitle } from "../../session-title";
import { assertObject, asString } from "../../utils";
import { defaultModelRenderer } from "../shared/renderers";

export const sessionRenameTool: ToolDefinition = {
  name: "session_rename",
  description: "Set a concise human-facing title for the current session when its goal becomes clear or materially changes. This only changes how the session appears in history and resume lists; it does not alter task state or create a new session.",
  inputSchema: {
    type: "object",
    required: ["title"],
    properties: { title: { type: "string" } }
  },
  mutates: true,
  timeoutMs: 5_000,
  parallel: false,
  renderHuman: (result) => result.summary,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    if (!context.store.updateSession) throw new Error("session naming is unavailable in this runtime");
    const title = normalizeSessionTitle(asString(args.title, "title"));
    context.store.updateSession(context.session.id, { title });
    return {
      ok: true,
      summary: `session renamed to ${title}`,
      output: title,
      metadata: { kind: "session_name", title }
    };
  }
};
