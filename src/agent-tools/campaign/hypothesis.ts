import type { ToolDefinition, CampaignHypothesis } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { campaignIdFor, loadCampaign, requireCampaignStore } from "./shared";

export const campaignHypothesisTool: ToolDefinition = {
  name: "campaign_hypothesis",
  description: "Create or update a campaign vulnerability hypothesis with rationale, confidence, supporting evidence, and one concrete next verification test. Use this for testable candidate explanations; it does not create or verify a finding.",
  inputSchema: { type: "object", required: ["title", "category", "rationale", "nextTest"], properties: { campaignId: { type: "string" }, assetId: { type: "string" }, title: { type: "string" }, category: { type: "string" }, rationale: { type: "string" }, nextTest: { type: "string" }, status: { type: "string" }, confidence: { type: "number" }, evidenceIds: { type: "array", items: { type: "string" } } } },
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
    const hypothesis = requireCampaignStore(context, "upsertHypothesis")({
      campaignId,
      ...(typeof args.assetId === "string" ? { assetId: args.assetId } : {}),
      title: asString(args.title, "title"),
      category: asString(args.category, "category"),
      status: typeof args.status === "string" ? args.status as CampaignHypothesis["status"] : "open",
      rationale: asString(args.rationale, "rationale"),
      nextTest: asString(args.nextTest, "nextTest"),
      confidence: typeof args.confidence === "number" ? Math.max(0, Math.min(1, args.confidence)) : 0.5,
      evidenceIds
    });
    return { ok: true, summary: `hypothesis ${hypothesis.status}: ${hypothesis.title}`, output: JSON.stringify(hypothesis, null, 2), metadata: { campaignId, hypothesisId: hypothesis.id } };
  }
};
