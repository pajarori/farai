import type { EvidenceLevel, TestAttempt, TestAttemptStatus, ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { assertCampaignEvidence, campaignIdFor, loadCampaign, requireCampaignStore } from "./shared";

const STATUSES: TestAttemptStatus[] = ["planned", "running", "passed", "failed", "inconclusive", "cancelled"];
const LEVELS: EvidenceLevel[] = ["signal", "differential_observed", "reproduced", "impact_demonstrated", "independently_verified"];

const TEST_ATTEMPT_PROPERTIES = {
  campaignId: { type: "string", description: "campaign id; omit when an active campaign is already attached to the session" },
  hypothesisId: { type: "string", description: "optional hypothesis id this experiment is testing" },
  attemptId: { type: "string", description: "existing attempt id to update; omit to create a new attempt" },
  title: { type: "string", description: "short, specific name of the experiment" },
  target: { type: "string", description: "exact asset, endpoint, request, or behavior being tested" },
  method: { type: "string", description: "reproducible steps or tool procedure, including relevant parameters" },
  baseline: { description: "control request or expected behavior before the mutation" },
  mutation: { description: "one changed input, state, or condition being tested" },
  oracle: { type: "string", description: "observable pass/fail condition that distinguishes the hypothesis" },
  observed: { description: "what actually happened; add this when updating the attempt" },
  status: { type: "string", enum: STATUSES, description: "planned before execution; running while active; passed or failed after a clear oracle; inconclusive when evidence is insufficient; cancelled when intentionally stopped" },
  evidenceLevel: { type: "string", enum: LEVELS, description: "signal is a lead; differential_observed shows a meaningful baseline difference; reproduced repeats the behavior; impact_demonstrated proves security impact in the same session; independently_verified confirms it from another session" },
  evidenceIds: { type: "array", items: { type: "string" }, uniqueItems: true, description: "ids returned by evidence-producing tools or evidence_save; every id must belong to this campaign" }
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export const campaignTestAttemptTool: ToolDefinition = {
  name: "campaign_test",
  description: "Create a reproducible campaign experiment, or update an existing attempt by attemptId, with target, method, baseline, mutation, success oracle, observation, status, evidence level, and evidence links. Use this to formalize verification before campaign_verify.",
  inputSchema: {
    type: "object",
    oneOf: [
      { required: ["title", "target", "method", "baseline", "mutation", "oracle"], properties: TEST_ATTEMPT_PROPERTIES, additionalProperties: false },
      { required: ["attemptId"], properties: TEST_ATTEMPT_PROPERTIES, additionalProperties: false }
    ]
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
    const target = asString(args.target, "target");

    const status = (typeof args.status === "string" ? args.status : "planned") as TestAttemptStatus;
    if (!STATUSES.includes(status)) throw new Error(`unsupported test attempt status: ${status}; use one of: ${STATUSES.join(", ")}`);
    const evidenceLevel = (typeof args.evidenceLevel === "string" ? args.evidenceLevel : "signal") as EvidenceLevel;
    if (!LEVELS.includes(evidenceLevel)) throw new Error(`unsupported evidence level: ${evidenceLevel}; use one of: ${LEVELS.join(", ")}`);
    const evidenceIds = stringArray(args.evidenceIds);
    assertCampaignEvidence(context, campaignId, evidenceIds);

    if (typeof args.attemptId === "string" && args.attemptId.trim()) {
      const load = requireCampaignStore(context, "loadTestAttempt");
      const update = requireCampaignStore(context, "updateTestAttempt");
      const existing = load(args.attemptId);
      if (existing.campaignId !== campaignId) throw new Error("test attempt belongs to another campaign");
      const attempt = update(existing.id, {
        status: typeof args.status === "string" ? status : existing.status,
        ...(Object.prototype.hasOwnProperty.call(args, "observed") ? { observed: args.observed } : {}),
        evidenceLevel: typeof args.evidenceLevel === "string" ? evidenceLevel : existing.evidenceLevel,
        ...(Object.prototype.hasOwnProperty.call(args, "evidenceIds") ? { evidenceIds } : {})
      });
      return { ok: true, summary: `test attempt updated: ${attempt.status}`, output: JSON.stringify(attempt, null, 2), metadata: { campaignId, attemptId: attempt.id } };
    }

    if (typeof args.hypothesisId === "string" && context.store.listHypotheses) {
      const hypothesis = context.store.listHypotheses(campaignId).find((item) => item.id === args.hypothesisId);
      if (!hypothesis) throw new Error("hypothesis does not belong to this campaign");
    }
    const create = requireCampaignStore(context, "createTestAttempt");
    const activeRun = context.campaignControl?.active();
    if (activeRun && activeRun.campaignId !== campaignId) throw new Error("test attempt campaign does not match the active campaign run");
    const attempt = create({
      campaignId,
      sessionId: context.session.id,
      ...(activeRun ? { runId: activeRun.id } : {}),
      ...(typeof args.hypothesisId === "string" ? { hypothesisId: args.hypothesisId } : {}),
      title: asString(args.title, "title"),
      target,
      method: asString(args.method, "method"),
      baseline: args.baseline,
      mutation: args.mutation,
      oracle: asString(args.oracle, "oracle"),
      ...(Object.prototype.hasOwnProperty.call(args, "observed") ? { observed: args.observed } : {}),
      status,
      evidenceLevel,
      evidenceIds
    });
    return { ok: true, summary: `test attempt created: ${attempt.id}`, output: JSON.stringify(attempt, null, 2), metadata: { campaignId, attemptId: attempt.id } };
  }
};
