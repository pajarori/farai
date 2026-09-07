import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { assertCampaignEvidence } from "./shared";

export const campaignCheckpointTool: ToolDefinition = {
  name: "campaign_checkpoint",
  description: "Record the current campaign wave decision without ending the campaign by model convention. Use continue when another wave should start, waiting when an external event or user input is required, blocked when a concrete blocker cannot be resolved, and complete only when the objective is actually satisfied and durable evidence or findings are ready.",
  inputSchema: {
    type: "object",
    required: ["status", "summary"],
    properties: {
      status: { type: "string", enum: ["continue", "waiting", "blocked", "complete"] },
      summary: { type: "string" },
      blocker: { type: "string" },
      evidenceIds: { type: "array", items: { type: "string" } }
    }
  },
  mutates: true,
  timeoutMs: 5_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    if (!context.campaignControl) throw new Error("campaign lifecycle is unavailable");
    const status = asString(args.status, "status") as "continue" | "waiting" | "blocked" | "complete";
    const allowedStatuses = ["continue", "waiting", "blocked", "complete"] as const;
    if (!allowedStatuses.includes(status)) throw new Error(`unsupported campaign checkpoint status: ${status}; use one of: ${allowedStatuses.join(", ")}`);
    const summary = asString(args.summary, "summary").trim();
    if (!summary) throw new Error("summary must be non-empty");
    const evidenceIds = Array.isArray(args.evidenceIds) ? args.evidenceIds.map(String) : undefined;
    const activeRun = context.campaignControl.active();
    if (!activeRun) throw new Error("no active campaign run");
    assertCampaignEvidence(context, activeRun.campaignId, evidenceIds ?? []);
    const run = context.campaignControl.checkpoint({
      status,
      summary,
      ...(typeof args.blocker === "string" && args.blocker.trim() ? { blocker: args.blocker.trim() } : {}),
      ...(evidenceIds?.length ? { evidenceIds } : {})
    });
    return { ok: true, summary: `campaign checkpoint recorded: ${status}`, output: JSON.stringify({ runId: run.id, status, summary, ...(evidenceIds?.length ? { evidenceIds } : {}) }, null, 2), metadata: { runId: run.id, status } };
  }
};
