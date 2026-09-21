import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";

export const updatePlanTool: ToolDefinition = {
  name: "task_plan_internal",
  description: "Replace the current session plan with ordered steps and statuses.",
  inputSchema: { type: "object", required: ["plan"], properties: { plan: { type: "array", items: { type: "object", required: ["step", "status"], properties: { step: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } } } } } },
  mutates: true, timeoutMs: Number.POSITIVE_INFINITY, parallel: false, renderHuman: defaultHumanRenderer, renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    if (!Array.isArray(args.plan) || args.plan.length > 100) throw new Error("plan must contain at most 100 steps");
    const plan = args.plan.map((entry, i) => {
      assertObject(entry, `plan[${i}]`);
      const step = asString(entry.step, "step");
      const status = entry.status;
      if (status !== "pending" && status !== "in_progress" && status !== "completed") {
        throw new Error("invalid plan status");
      }
      return { step, status } as const;
    });
    if (plan.filter((entry) => entry.status === "in_progress").length > 1) {
      throw new Error("plan may have only one in_progress step");
    }
    if (!context.store.replacePlan) throw new Error("store does not support atomic plans");
    const result = context.store.replacePlan(context.session.id, plan);
    const marker = (status: string) => (status === "completed" ? "✔" : status === "in_progress" ? "▸" : "○");
    const output = result.map((entry) => `${marker(entry.status)} ${entry.step}`).join("\n");
    return { ok: true, summary: `plan updated: ${plan.length} step(s)`, output };
  }
};
