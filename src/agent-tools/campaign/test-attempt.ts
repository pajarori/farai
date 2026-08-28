import type { EvidenceLevel, TestAttempt, TestAttemptStatus, ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { campaignIdFor, requireCampaignStore } from "./shared";

const STATUSES: TestAttemptStatus[] = ["planned", "running", "passed", "failed", "inconclusive", "cancelled"];
const LEVELS: EvidenceLevel[] = ["signal", "differential_observed", "reproduced", "impact_demonstrated", "independently_verified"];

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export const campaignTestAttemptTool: ToolDefinition = {
  name: "campaign_test",
  description: "Create or update one reproducible campaign experiment with a baseline, mutation, oracle, and evidence.",
  inputSchema: {
    type: "object",
    required: ["title", "target", "method", "baseline", "mutation", "oracle"],
    properties: {
      campaignId: { type: "string" },
      hypothesisId: { type: "string" },
      attemptId: { type: "string" },
      title: { type: "string" },
      target: { type: "string" },
      method: { type: "string" },
      baseline: {},
      mutation: {},
      oracle: { type: "string" },
      observed: {},
      status: { type: "string" },
      evidenceLevel: { type: "string" },
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
    const target = asString(args.target, "target");

    const status = (typeof args.status === "string" ? args.status : "planned") as TestAttemptStatus;
    if (!STATUSES.includes(status)) throw new Error(`unsupported test attempt status: ${status}`);
    const evidenceLevel = (typeof args.evidenceLevel === "string" ? args.evidenceLevel : "signal") as EvidenceLevel;
    if (!LEVELS.includes(evidenceLevel)) throw new Error(`unsupported evidence level: ${evidenceLevel}`);
    const evidenceIds = stringArray(args.evidenceIds);
    if (context.store.listEvidence && evidenceIds.length > 0) {
      const known = new Set(context.store.listEvidence(context.session.id).map((item) => item.id));
      const unknown = evidenceIds.filter((item) => !known.has(item));
      if (unknown.length > 0) throw new Error(`evidence not found in session: ${unknown.join(", ")}`);
    }

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
    const attempt = create({
      campaignId,
      sessionId: context.session.id,
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
