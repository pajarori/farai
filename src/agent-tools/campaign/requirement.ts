import type { CampaignRequirementStatus, ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { assertCampaignEvidence, campaignIdFor, loadCampaign, requireCampaignStore } from "./shared";

const STATUSES: CampaignRequirementStatus[] = ["pending", "satisfied", "waived"];

export const campaignRequirementTool: ToolDefinition = {
  name: "campaign_requirement",
  description: "Record one model-chosen completion requirement for the active campaign run. Use stable keys, update it to satisfied only when the requirement is met and evidence is linked, or waive it with an explicit operator-relevant reason in the description.",
  inputSchema: {
    type: "object",
    required: ["key", "description"],
    properties: {
      campaignId: { type: "string" },
      key: { type: "string" },
      description: { type: "string" },
      status: { type: "string", enum: STATUSES },
      evidenceIds: { type: "array", items: { type: "string" } }
    }
  },
  mutates: true,
  timeoutMs: 5_000,
  parallel: false,
  visibility: "core",
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const campaignId = campaignIdFor(context, args);
    loadCampaign(context, campaignId);
    const run = context.campaignControl?.active();
    if (!run || run.campaignId !== campaignId) throw new Error("campaign requirement requires the active campaign run");
    const key = asString(args.key, "key").trim();
    const description = asString(args.description, "description").trim();
    if (!key || !description) throw new Error("requirement key and description must be non-empty");
    const status = (typeof args.status === "string" ? args.status : "pending") as CampaignRequirementStatus;
    if (!STATUSES.includes(status)) throw new Error(`unsupported requirement status: ${status}`);
    const evidenceIds = Array.isArray(args.evidenceIds) ? args.evidenceIds.map(String).filter(Boolean) : [];
    assertCampaignEvidence(context, campaignId, evidenceIds);
    if (status === "satisfied" && evidenceIds.length === 0) throw new Error("satisfied requirements require evidenceIds");
    const upsert = requireCampaignStore(context, "upsertCampaignRequirement");
    const requirement = upsert({ runId: run.id, key, description, status, evidenceIds });
    return { ok: true, summary: `requirement ${requirement.status}: ${requirement.key}`, output: JSON.stringify(requirement, null, 2), metadata: { campaignId, runId: run.id, requirementId: requirement.id } };
  }
};
