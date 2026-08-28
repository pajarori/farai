import type { ToolDefinition, CampaignAsset } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { campaignIdFor, requireCampaignStore } from "./shared";

export const campaignAssetTool: ToolDefinition = {
  name: "campaign_asset",
  description: "Upsert an asset in the campaign attack-surface graph.",
  inputSchema: { type: "object", required: ["canonical", "kind"], properties: { campaignId: { type: "string" }, canonical: { type: "string" }, kind: { type: "string" }, parentId: { type: "string" }, technologies: { type: "array", items: { type: "string" } }, metadata: { type: "object" }, confidence: { type: "number" } } },
  mutates: true,
  timeoutMs: 5_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const campaignId = campaignIdFor(context, args);
    const canonical = asString(args.canonical, "canonical");
    const asset = requireCampaignStore(context, "upsertAsset")({
      campaignId,
      canonical,
      kind: asString(args.kind, "kind") as CampaignAsset["kind"],
      ...(typeof args.parentId === "string" ? { parentId: args.parentId } : {}),
      technologies: Array.isArray(args.technologies) ? args.technologies.map(String) : [],
      metadata: args.metadata && typeof args.metadata === "object" ? args.metadata as Record<string, unknown> : {},
      confidence: typeof args.confidence === "number" ? Math.max(0, Math.min(1, args.confidence)) : 0.5
    });
    return { ok: true, summary: `asset saved: ${asset.canonical}`, output: JSON.stringify(asset, null, 2), metadata: { campaignId, assetId: asset.id } };
  }
};
