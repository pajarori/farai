import type { ToolDefinition, CampaignHypothesis } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { assertCampaignAsset, assertCampaignEvidence, campaignIdFor, loadCampaign, requireCampaignStore } from "./shared";

export const campaignHypothesisTool: ToolDefinition = {
  name: "campaign_hypothesis",
  description: "Create or update a campaign vulnerability hypothesis with rationale, confidence, supporting evidence, and one concrete next verification test. Use this for testable candidate explanations; it does not create or verify a finding.",
  inputSchema: {
    type: "object",
    required: ["title", "category", "rationale", "nextTest"],
    properties: {
      campaignId: { type: "string" },
      assetId: { type: "string" },
      title: { type: "string", description: "testable vulnerability or behavior hypothesis" },
      category: { type: "string", description: "short testing lane, for example auth, access_control, injection, ssrf, or crypto" },
      rationale: { type: "string", description: "facts and evidence that make this hypothesis plausible" },
      nextTest: { type: "string", description: "smallest concrete test that can confirm or disprove the hypothesis" },
      status: { type: "string", enum: ["open", "testing", "verified", "disproven", "blocked", "archived"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      evidenceIds: { type: "array", items: { type: "string" }, uniqueItems: true }
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
    const allowedStatuses = ["open", "testing", "verified", "disproven", "blocked", "archived"] as const;
    const status = typeof args.status === "string" ? args.status : "open";
    if (!allowedStatuses.includes(status as typeof allowedStatuses[number])) throw new Error(`unsupported hypothesis status: ${status}; use one of: ${allowedStatuses.join(", ")}`);
    const hypothesis = requireCampaignStore(context, "upsertHypothesis")({
      campaignId,
      ...(assetId ? { assetId } : {}),
      title: asString(args.title, "title"),
      category: asString(args.category, "category"),
      status: status as CampaignHypothesis["status"],
      rationale: asString(args.rationale, "rationale"),
      nextTest: asString(args.nextTest, "nextTest"),
      confidence: typeof args.confidence === "number" ? Math.max(0, Math.min(1, args.confidence)) : 0.5,
      evidenceIds
    });
    return { ok: true, summary: `hypothesis ${hypothesis.status}: ${hypothesis.title}`, output: JSON.stringify(hypothesis, null, 2), metadata: { campaignId, hypothesisId: hypothesis.id } };
  }
};
