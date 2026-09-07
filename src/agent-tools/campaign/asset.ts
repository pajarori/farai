import type { ToolDefinition, CampaignAsset } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { assertCampaignAsset, campaignIdFor, loadCampaign, requireCampaignStore } from "./shared";

export const campaignAssetTool: ToolDefinition = {
  name: "campaign_asset",
  description: "Create or update one canonical asset in the attached campaign's attack-surface graph, including type, parent relationship, technologies, metadata, and confidence. Use stable canonical identifiers so repeated discoveries update the same asset instead of creating duplicates.",
  inputSchema: {
    type: "object",
    required: ["canonical", "kind"],
    properties: {
      campaignId: { type: "string", description: "campaign id; omit when an active campaign is attached" },
      canonical: { type: "string", description: "stable normalized identifier such as example.com, 10.0.0.4, or https://example.com/login" },
      kind: { type: "string", enum: ["domain", "subdomain", "ip", "url", "endpoint", "api", "repository", "mobile_app", "service", "other"] },
      parentId: { type: "string", description: "existing asset id when this asset is a child of another asset" },
      technologies: { type: "array", items: { type: "string" }, uniqueItems: true },
      metadata: { type: "object", description: "small factual metadata map; do not store secrets or full response bodies" },
      confidence: { type: "number", minimum: 0, maximum: 1, description: "confidence in the asset identity from 0 to 1" }
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 5_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const campaignId = campaignIdFor(context, args);
    loadCampaign(context, campaignId);
    const canonical = asString(args.canonical, "canonical");
    const parentId = typeof args.parentId === "string" && args.parentId.trim() ? args.parentId.trim() : undefined;
    assertCampaignAsset(context, campaignId, parentId);
    const allowedKinds = ["domain", "subdomain", "ip", "url", "endpoint", "api", "repository", "mobile_app", "service", "other"] as const;
    const kind = asString(args.kind, "kind");
    if (!allowedKinds.includes(kind as typeof allowedKinds[number])) throw new Error(`unsupported asset kind: ${kind}; use one of: ${allowedKinds.join(", ")}`);
    const asset = requireCampaignStore(context, "upsertAsset")({
      campaignId,
      canonical,
      kind: kind as CampaignAsset["kind"],
      ...(parentId ? { parentId } : {}),
      technologies: Array.isArray(args.technologies) ? args.technologies.map(String) : [],
      metadata: args.metadata && typeof args.metadata === "object" ? args.metadata as Record<string, unknown> : {},
      confidence: typeof args.confidence === "number" ? Math.max(0, Math.min(1, args.confidence)) : 0.5
    });
    return { ok: true, summary: `asset saved: ${asset.canonical}`, output: JSON.stringify(asset, null, 2), metadata: { campaignId, assetId: asset.id } };
  }
};
