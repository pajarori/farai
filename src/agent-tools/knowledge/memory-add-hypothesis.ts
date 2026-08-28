import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";

export const memoryAddHypothesisTool: ToolDefinition = {
  name: "memory_add_hypothesis",
  description: "Store a working hypothesis for the current target/session.",
  inputSchema: {
    type: "object",
    required: ["key", "text"],
    properties: { key: { type: "string" }, text: { type: "string" }, confidence: { type: "string" } }
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
      kind: "hypothesis",
      key: asString(args.key, "key"),
      value: {
        text: asString(args.text, "text"),
        confidence: typeof args.confidence === "string" ? args.confidence : "unknown"
      }
    });
    return { ok: true, summary: `hypothesis saved: ${item.key}`, output: JSON.stringify(item, null, 2) };
  }
};
