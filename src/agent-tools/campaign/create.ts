import type { ToolDefinition, Campaign } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";

export const campaignCreateTool: ToolDefinition = {
  name: "campaign_create",
  description: "Create and attach a pentest or bug bounty campaign.",
  inputSchema: {
    type: "object",
    required: ["name", "kind"],
    properties: {
      name: { type: "string" },
      kind: { type: "string", enum: ["pentest", "bug_bounty", "ctf", "lab"] }
    }
  },
  mutates: true,
  timeoutMs: 5_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const kind = asString(args.kind, "kind") as Campaign["kind"];
    if (!["pentest", "bug_bounty", "ctf", "lab"].includes(kind)) throw new Error(`unsupported campaign kind: ${kind}`);
    const campaign = context.store.createCampaign?.({
      workspace: context.rootWorkspace ?? context.workspace,
      name: asString(args.name, "name"),
      kind,
      status: "active"
    });
    if (!campaign) throw new Error("campaign store is unavailable");
    context.store.updateSession?.(context.session.id, { campaignId: campaign.id, phase: "research" });
    const attachedCampaign = context.store.loadCampaign?.(campaign.id) ?? campaign;
    return { ok: true, summary: `campaign created and attached: ${attachedCampaign.name}`, output: JSON.stringify(attachedCampaign, null, 2), metadata: { campaignId: attachedCampaign.id } };
  }
};
