import type { ToolDefinition } from "../../types";
import { assertObject, asString, id, nowIso } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";

export const evidenceSaveTool: ToolDefinition = {
  name: "evidence_save",
  description: "Save manually supplied text as durable session evidence with a descriptive title and return its evidence id. Use this for concrete outputs or observations that support a finding; use notes_add for context that is not evidentiary.",
  inputSchema: {
    type: "object",
    required: ["title", "content"],
    properties: { title: { type: "string" }, content: { type: "string" } }
  },
  mutates: true,
  timeoutMs: 5_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const title = asString(args.title, "title");
    const content = asString(args.content, "content");
    const evidence = context.store.saveEvidence(
      {
        id: id(),
        sessionId: context.session.id,
        source: "manual",
        title,
        summary: content.slice(0, 500),
        createdAt: nowIso()
      },
      content
    );
    return { ok: true, summary: `evidence saved: ${evidence.id}`, output: JSON.stringify(evidence, null, 2), evidence: [evidence] };
  }
};
