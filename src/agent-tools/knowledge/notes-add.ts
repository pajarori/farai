import type { ToolDefinition } from "../../types";
import { assertObject, asString, id, nowIso } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";

export const notesAddTool: ToolDefinition = {
  name: "notes_add",
  description: "Attach a durable free-form note with optional tags to the current session. Use this for important context, decisions, credentials, or observations that should survive later turns but are not formal evidence, hypotheses, or failed attempts.",
  inputSchema: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string" }, tags: { type: "array", items: { type: "string" } } }
  },
  mutates: true,
  timeoutMs: 5_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const note = {
      id: id(),
      sessionId: context.session.id,
      text: asString(args.text, "text"),
      tags: Array.isArray(args.tags) ? args.tags.map(String) : ["agent"],
      createdAt: nowIso()
    };
    context.store.addNote(note);
    return { ok: true, summary: "note saved", output: JSON.stringify(note, null, 2) };
  }
};
