import type { Campaign, CampaignRun, ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";

export const campaignCreateTool: ToolDefinition = {
  name: "campaign_create",
  description: "Create a persistent campaign for a multi-step authorized security objective, attach the current session, and start its durable execution run. Choose this when the objective needs multiple waves, shared evidence, hypotheses, verification, or a report; do not use it for a one-off action or ordinary conversation. The model decides when this boundary is appropriate.",
  inputSchema: {
    type: "object",
    required: ["name", "kind"],
    properties: {
      name: { type: "string" },
      kind: { type: "string", enum: ["pentest", "bug_bounty", "ctf", "lab"] },
      objective: { type: "string", description: "the complete durable objective to pursue across waves" }
    }
  },
  mutates: true,
  timeoutMs: 5_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const existingRun = context.store.listCampaignRuns?.(context.rootWorkspace ?? context.workspace).find((item) => (item.rootSessionId === context.session.id || item.id === context.session.campaignRunId) && !["completed", "cancelled", "failed"].includes(item.status));
    if (existingRun) throw new Error(`session already has a campaign run: ${existingRun.id}`);
    const kind = asString(args.kind, "kind") as Campaign["kind"];
    if (!["pentest", "bug_bounty", "ctf", "lab"].includes(kind)) throw new Error(`unsupported campaign kind: ${kind}`);
    const campaign = context.store.createCampaign?.({
      workspace: context.rootWorkspace ?? context.workspace,
      name: asString(args.name, "name"),
      kind,
      status: "active"
    });
    if (!campaign) throw new Error("campaign store is unavailable");
    const attachedCampaign = context.store.loadCampaign?.(campaign.id) ?? campaign;
    const objective = typeof args.objective === "string" && args.objective.trim() ? args.objective.trim() : attachedCampaign.name;
    let run: CampaignRun | undefined;
    try {
      run = context.campaignControl?.start(attachedCampaign.id, objective);
    } catch (error) {
      context.store.updateCampaign?.(attachedCampaign.id, { status: "archived" });
      throw error;
    }
    if (!run) context.store.updateSession?.(context.session.id, { campaignId: campaign.id, phase: "research" });
    return { ok: true, summary: `campaign created and attached: ${attachedCampaign.name}`, output: JSON.stringify({ campaign: attachedCampaign, ...(run ? { run } : {}) }, null, 2), metadata: { campaignId: attachedCampaign.id, ...(run ? { runId: run.id } : {}) } };
  }
};
