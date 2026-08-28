import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { priority } from "./shared";

export const todoAddTool: ToolDefinition = {
  name: "todo_add",
  description: "Add an actionable todo item for the current session or turn.",
  inputSchema: {
    type: "object",
    required: ["text"],
    properties: {
      text: { type: "string" },
      priority: { type: "string", enum: ["low", "medium", "high"] }
    }
  },
  mutates: true,
  timeoutMs: 5_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const todo = context.store.createTodo({
      sessionId: context.session.id,
      text: asString(args.text, "text"),
      status: "pending",
      priority: priority(args.priority)
    });
    return { ok: true, summary: `todo added: ${todo.text}`, output: JSON.stringify(todo, null, 2) };
  }
};
