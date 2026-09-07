import type { ToolDefinition, FindingStatus } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { assertCampaignEvidence, campaignIdFor, loadCampaign, requireCampaignStore } from "./shared";

export const campaignVerifyTool: ToolDefinition = {
  name: "campaign_verify",
  description: "Change a campaign finding's lifecycle state using explicit evidence and a reproducible test attempt. Use only after report_add_finding created the candidate. Use verified only with a passed campaign_test at impact_demonstrated or independently_verified; use duplicate only when duplicateOf points to the canonical finding.",
  inputSchema: {
    type: "object",
    required: ["findingId", "status"],
    properties: {
      campaignId: { type: "string", description: "campaign id; omit when the active campaign owns the finding" },
      findingId: { type: "string", description: "finding id returned by report_add_finding or campaign search" },
      status: { type: "string", enum: ["candidate", "needs_verification", "verified", "duplicate", "not_applicable", "reported", "accepted", "rejected"], description: "lifecycle state; verified has strict evidence requirements" },
      testAttemptId: { type: "string", description: "required for verified; must reference a passed campaign_test" },
      evidenceIds: { type: "array", items: { type: "string" }, uniqueItems: true, description: "evidence supporting the state; required and linked to the test for verified" },
      duplicateOf: { type: "string", description: "canonical finding id when status is duplicate" },
      reproduction: { type: "string", description: "concise reproducible steps to preserve on the finding" },
      impact: { type: "string", description: "observed security impact, not an unverified possibility" },
      remediation: { type: "string", description: "specific remediation supported by the observed issue" }
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
    const status = asString(args.status, "status") as FindingStatus;
    const allowedStatuses = ["candidate", "needs_verification", "verified", "duplicate", "not_applicable", "reported", "accepted", "rejected"] as const;
    if (!allowedStatuses.includes(status)) throw new Error(`unsupported finding status: ${status}; use one of: ${allowedStatuses.join(", ")}`);
    if (status === "verified" && (!Array.isArray(args.evidenceIds) || args.evidenceIds.length === 0)) throw new Error("verified findings require evidenceIds");
    if (status === "verified" && (typeof args.testAttemptId !== "string" || !args.testAttemptId.trim())) throw new Error("verified findings require a passed testAttemptId");
    if (!context.store.updateFinding || !context.store.loadFinding) throw new Error("finding update is unavailable");
    const existing = context.store.loadFinding(asString(args.findingId, "findingId"));
    if (existing.campaignId && existing.campaignId !== campaignId) throw new Error("finding belongs to another campaign");
    const evidenceIds = Array.isArray(args.evidenceIds) ? args.evidenceIds.map(String) : [];
    assertCampaignEvidence(context, campaignId, evidenceIds);
    if (status === "verified") {
      const attempt = requireCampaignStore(context, "loadTestAttempt")(asString(args.testAttemptId, "testAttemptId"));
      if (attempt.campaignId !== campaignId) throw new Error("test attempt belongs to another campaign");
      if (attempt.status !== "passed") throw new Error("verified findings require a passed test attempt");
      if (!["impact_demonstrated", "independently_verified"].includes(attempt.evidenceLevel)) throw new Error("test attempt has not demonstrated impact");
      if (attempt.evidenceLevel === "impact_demonstrated" && attempt.sessionId !== existing.sessionId) throw new Error("impact-demonstration attempts must belong to the finding session");
      if (attempt.evidenceLevel === "independently_verified" && attempt.sessionId === existing.sessionId) throw new Error("independent verification must come from a different session");
      const attemptEvidence = new Set(attempt.evidenceIds);
      const missingAttemptEvidence = evidenceIds.filter((evidenceId) => !attemptEvidence.has(evidenceId));
      if (missingAttemptEvidence.length > 0) throw new Error(`finding evidence is not linked to test attempt: ${missingAttemptEvidence.join(", ")}`);
    }
    const finding = context.store.updateFinding(existing.id, {
      status,
      ...(Array.isArray(args.evidenceIds) ? { evidenceIds: args.evidenceIds.map(String) } : {}),
      ...(typeof args.duplicateOf === "string" ? { duplicateOf: args.duplicateOf } : {}),
      ...(typeof args.reproduction === "string" ? { reproduction: args.reproduction } : {}),
      ...(typeof args.impact === "string" ? { impact: args.impact } : {}),
      ...(typeof args.remediation === "string" ? { remediation: args.remediation } : {})
    });
    if (finding.campaignId && finding.campaignId !== campaignId) throw new Error("finding belongs to another campaign");
    return {
      ok: true,
      summary: `finding ${status}: ${finding.title}`,
      output: JSON.stringify(finding, null, 2),
      ...(status === "verified" && typeof args.testAttemptId === "string"
        ? { metadata: {
            producerSessionId: existing.sessionId,
            verifierSessionId: requireCampaignStore(context, "loadTestAttempt")(args.testAttemptId).sessionId
          } }
        : {})
    };
  }
};
