import type { CampaignNextAction, ToolDefinition } from "../../types";
import { assertObject } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { campaignIdFor, requireCampaignStore } from "./shared";

function laneForCategory(category: string): CampaignNextAction["lane"] {
  const normalized = category.toLowerCase();
  if (/(auth|access|idor|permission)/.test(normalized)) return "authz";
  if (/(inject|xss|sqli|ssrf|command|template)/.test(normalized)) return "injection";
  if (/(logic|workflow|race|business)/.test(normalized)) return "business_logic";
  if (/(client|javascript|dom|mobile)/.test(normalized)) return "client_side";
  if (/(cloud|config|secret|storage)/.test(normalized)) return "cloud_config";
  if (/(verify|reproduce)/.test(normalized)) return "verification";
  return "web_api";
}

export const campaignNextActionTool: ToolDefinition = {
  name: "campaign_next_action",
  description: "Choose the next pentest lane using campaign novelty, evidence gaps, confidence, and estimated cost.",
  inputSchema: { type: "object", required: [], properties: { campaignId: { type: "string" } } },
  mutates: false,
  timeoutMs: 5_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const campaignId = campaignIdFor(context, args);
    const listAssets = requireCampaignStore(context, "listAssets");
    const listHypotheses = requireCampaignStore(context, "listHypotheses");
    const assets = listAssets(campaignId);
    const hypotheses = listHypotheses(campaignId).filter((item) => item.status === "open" || item.status === "testing" || item.status === "blocked");
    const listAttempts = context.store.listTestAttempts?.bind(context.store);
    let action: CampaignNextAction;
    if (hypotheses.length > 0) {
      const selected = hypotheses
        .map((hypothesis) => {
          const attempts = listAttempts?.(campaignId, hypothesis.id) ?? [];
          const failedAttempts = attempts.filter((attempt) => attempt.status === "failed" || attempt.status === "inconclusive").length;
          const evidenceGap = hypothesis.evidenceIds.length === 0 ? 1 : 0.35;
          const statusWeight = hypothesis.status === "testing" ? 1 : hypothesis.status === "blocked" ? 0.55 : 0.75;
          const priority = Math.max(0, Math.min(1, (hypothesis.confidence * 0.35) + (evidenceGap * 0.3) + (statusWeight * 0.2) + (attempts.length === 0 ? 0.15 : 0.05) - (failedAttempts * 0.05)));
          return { hypothesis, priority, attempts, failedAttempts };
        })
        .sort((a, b) => b.priority - a.priority)[0]!;
      const lane = laneForCategory(selected.hypothesis.category);
      action = {
        lane,
        title: `Test hypothesis: ${selected.hypothesis.title}`,
        rationale: `The hypothesis is ${selected.hypothesis.status}, has confidence ${selected.hypothesis.confidence.toFixed(2)}, ${selected.attempts.length} attempt(s), and ${selected.failedAttempts} failed or inconclusive attempt(s). Prioritize the next smallest test that closes its evidence gap.`,
        priority: selected.priority,
        ...(selected.hypothesis.assetId ? { assetId: selected.hypothesis.assetId } : {}),
        hypothesisId: selected.hypothesis.id,
        prompt: `Work only on hypothesis ${selected.hypothesis.id}. Run the smallest test that can confirm or disprove it. Save observations and evidence; do not mark a finding verified without reproducible evidence.`
      };
    } else if (assets.length === 0) {
      action = { lane: "discovery", title: "Discover the initial attack surface", rationale: "The campaign has no assets yet, so discovery has the highest information gain.", priority: 1, prompt: "Discover initial assets for this campaign. Record each asset and supporting observation." };
    } else {
      const selected = assets[0]!;
      action = { lane: "mapping", title: `Map ${selected.canonical}`, rationale: "No open hypothesis is ready; expand the most relevant asset before testing deeper classes.", priority: 0.7 + selected.confidence * 0.3, assetId: selected.id, prompt: `Map the exposed services, routes, technologies, and trust boundaries for asset ${selected.canonical}. Save structured observations and create hypotheses only when evidence supports them.` };
    }
    return { ok: true, summary: `${action.lane}: ${action.title}`, output: JSON.stringify(action, null, 2), metadata: { campaignId, lane: action.lane } };
  }
};
