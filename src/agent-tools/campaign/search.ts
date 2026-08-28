import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { campaignIdFor, compactDossier, loadCampaign, requireCampaignStore } from "./shared";

export const campaignSearchTool: ToolDefinition = {
  name: "campaign_search",
  description: "Search campaign memory or return a bounded target dossier for the next pentest action.",
  inputSchema: { type: "object", required: [], properties: { campaignId: { type: "string" }, query: { type: "string" }, limit: { type: "number" }, dossier: { type: "boolean" } } },
  mutates: false,
  timeoutMs: 5_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const campaignId = campaignIdFor(context, args);
    loadCampaign(context, campaignId);
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 20;
    if (args.dossier === true || !query) {
      if (context.store.campaignDossier) {
        const dossier = context.store.campaignDossier(campaignId, "", limit);
        return { ok: true, summary: `campaign dossier: ${dossier.assets.length} assets, ${dossier.hypotheses.length} hypotheses`, output: compactDossier(dossier) };
      }
      if (!context.store.listAssets || !context.store.listObservations || !context.store.listHypotheses) throw new Error("campaign store is unavailable");
      const dossier = {
        campaign: loadCampaign(context, campaignId),
        assets: context.store.listAssets(campaignId),
        observations: context.store.listObservations(campaignId),
        hypotheses: context.store.listHypotheses(campaignId),
        findings: [],
        recentEvidence: [],
        searchMatches: []
      };
      return { ok: true, summary: `campaign dossier: ${dossier.assets.length} assets, ${dossier.hypotheses.length} hypotheses`, output: compactDossier(dossier) };
    }
    const matches = requireCampaignStore(context, "searchCampaign")(campaignId, query, limit);
    return { ok: true, summary: `${matches.length} campaign matches for ${query}`, output: JSON.stringify(matches, null, 2) };
  }
};
