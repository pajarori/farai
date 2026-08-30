import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { campaignIdFor, loadCampaign, requireCampaignStore } from "./shared";

export const campaignObserveTool: ToolDefinition = {
  name: "campaign_observe",
  description: "Record a structured campaign observation from a tool result or manual investigation, optionally linking it to an asset and session evidence. Use this for factual signals and discovered state; use campaign_hypothesis for an explanatory vulnerability claim that still needs testing.",
  inputSchema: { type: "object", required: ["kind", "value"], properties: { campaignId: { type: "string" }, assetId: { type: "string" }, kind: { type: "string" }, value: {}, confidence: { type: "number" }, source: { type: "string" }, evidenceIds: { type: "array", items: { type: "string" } }, status: { type: "string" } } },
  mutates: true,
  timeoutMs: 5_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const campaignId = campaignIdFor(context, args);
    loadCampaign(context, campaignId);
    const evidenceIds = Array.isArray(args.evidenceIds) ? args.evidenceIds.map(String) : [];
    if (context.store.listEvidence && evidenceIds.length > 0) {
      const known = new Set(context.store.listEvidence(context.session.id).map((item) => item.id));
      const unknown = evidenceIds.filter((item) => !known.has(item));
      if (unknown.length > 0) throw new Error(`evidence not found in session: ${unknown.join(", ")}`);
    }
    const observation = requireCampaignStore(context, "addObservation")({
      campaignId,
      ...(typeof args.assetId === "string" ? { assetId: args.assetId } : {}),
      kind: asString(args.kind, "kind"),
      value: args.value,
      confidence: typeof args.confidence === "number" ? Math.max(0, Math.min(1, args.confidence)) : 0.5,
      source: typeof args.source === "string" ? args.source : "agent",
      evidenceIds,
      status: typeof args.status === "string" ? args.status as "active" : "active"
    });
    return { ok: true, summary: `observation recorded: ${observation.kind}`, output: JSON.stringify(observation, null, 2), metadata: { campaignId, observationId: observation.id } };
  }
};
