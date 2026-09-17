import type { ToolDefinition } from "../../types";
import { assertObject } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { todoStatus } from "./shared";

export const todoListTool: ToolDefinition = {
  name: "task_list_internal",
  description: "List the current session's todos, optionally filtered by lifecycle status and bounded by limit. Use the returned todo ids for task_manage and consult this before adding items when duplication is possible.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pending", "in_progress", "done", "blocked", "cancelled"] },
      limit: { type: "number" }
    }
  },
  mutates: false,
  timeoutMs: 5_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const todos = context.store.listTodos(context.session.id, {
      ...(args.status !== undefined ? { status: todoStatus(args.status) } : {}),
      ...(typeof args.limit === "number" ? { limit: Math.max(1, Math.min(100, Math.floor(args.limit))) } : {})
    });
    return {
      ok: true,
      summary: `${todos.length} todo(s)`,
      output: JSON.stringify(todos, null, 2)
    };
  }
};
