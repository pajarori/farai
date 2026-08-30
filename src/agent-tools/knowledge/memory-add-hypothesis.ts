import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";

export const memoryAddHypothesisTool: ToolDefinition = {
  name: "memory_add_hypothesis",
  description: "Store a keyed working hypothesis and confidence level in the current session memory. Use this for a testable explanation that should guide later investigation; use campaign_hypothesis when operating inside a persistent campaign workflow.",
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
