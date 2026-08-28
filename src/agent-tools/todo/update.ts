import type { TodoPriority, TodoStatus, ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { priority, todoStatus } from "./shared";

export const todoUpdateTool: ToolDefinition = {
  name: "todo_update",
  description: "Update an existing todo item status, priority, or text. Use the exact todo id returned by todo_add or todo_list, never a tool call id or an UNTRUSTED boundary token.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      text: { type: "string" },
      status: { type: "string", enum: ["pending", "in_progress", "done", "blocked", "cancelled"] },
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
    const patch: Partial<{ text: string; status: TodoStatus; priority: TodoPriority }> = {};
    if (typeof args.text === "string") patch.text = args.text;
    if (args.status !== undefined) patch.status = todoStatus(args.status);
    if (args.priority !== undefined) patch.priority = priority(args.priority);
    const todo = context.store.updateTodo(asString(args.id, "id"), patch);
    return { ok: true, summary: `todo updated: ${todo.id} ${todo.status}`, output: JSON.stringify(todo, null, 2) };
  }
};
