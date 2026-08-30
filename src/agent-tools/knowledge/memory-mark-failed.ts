import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";

export const memoryMarkFailedTool: ToolDefinition = {
  name: "memory_mark_failed",
  description: "Record a keyed failed attempt with its reason and optional command so future turns do not repeat the same ineffective path. Use this after a meaningful negative result, not for a transient transport error that should simply be retried differently.",
  inputSchema: {
    type: "object",
    required: ["key", "reason"],
    properties: { key: { type: "string" }, reason: { type: "string" }, command: { type: "string" } }
  },
  mutates: true,
  timeoutMs: 5_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const item = context.store.upsertMemory({
      sessionId: context.session.id,
      kind: "failed_attempt",
      key: asString(args.key, "key"),
      value: {
        reason: asString(args.reason, "reason"),
        command: typeof args.command === "string" ? args.command : undefined
      }
    });
    return { ok: true, summary: `failed attempt recorded: ${item.key}`, output: JSON.stringify(item, null, 2) };
  }
};
