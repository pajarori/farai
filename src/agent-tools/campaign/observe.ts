import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { assertCampaignAsset, assertCampaignEvidence, campaignIdFor, loadCampaign, requireCampaignStore } from "./shared";

export const campaignObserveTool: ToolDefinition = {
  name: "campaign_observe",
  description: "Record a structured campaign observation from a tool result or manual investigation, optionally linking it to an asset and session evidence. Use this for factual signals and discovered state; use campaign_hypothesis for an explanatory vulnerability claim that still needs testing.",
  inputSchema: {
    type: "object",
    required: ["kind", "value"],
    properties: {
      campaignId: { type: "string" },
      assetId: { type: "string", description: "asset id this factual observation belongs to" },
      kind: { type: "string", description: "stable observation type such as http_service, technology, route, dns_record, or behavior" },
      value: { description: "factual observed value; keep it structured when useful" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      source: { type: "string", description: "tool name, URL, file, or other provenance" },
      evidenceIds: { type: "array", items: { type: "string" }, uniqueItems: true },
      status: { type: "string", enum: ["active", "stale", "disproven", "archived"] }
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
    const assetId = typeof args.assetId === "string" && args.assetId.trim() ? args.assetId.trim() : undefined;
    assertCampaignAsset(context, campaignId, assetId);
    const evidenceIds = Array.isArray(args.evidenceIds) ? args.evidenceIds.map(String) : [];
    assertCampaignEvidence(context, campaignId, evidenceIds);
    const allowedStatuses = ["active", "stale", "disproven", "archived"] as const;
    const status = typeof args.status === "string" ? args.status : "active";
    if (!allowedStatuses.includes(status as typeof allowedStatuses[number])) throw new Error(`unsupported observation status: ${status}; use one of: ${allowedStatuses.join(", ")}`);
    const observation = requireCampaignStore(context, "addObservation")({
      campaignId,
      ...(assetId ? { assetId } : {}),
      kind: asString(args.kind, "kind"),
      value: args.value,
      confidence: typeof args.confidence === "number" ? Math.max(0, Math.min(1, args.confidence)) : 0.5,
      source: typeof args.source === "string" ? args.source : "agent",
      evidenceIds,
      status: status as "active" | "stale" | "disproven" | "archived"
    });
    return { ok: true, summary: `observation recorded: ${observation.kind}`, output: JSON.stringify(observation, null, 2), metadata: { campaignId, observationId: observation.id } };
  }
};
