import type { ToolDefinition, FindingStatus } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { campaignIdFor, loadCampaign, requireCampaignStore } from "./shared";

export const campaignVerifyTool: ToolDefinition = {
  name: "campaign_verify",
  description: "Change a campaign finding's verification state using explicit evidence and a reproducible test attempt. Verified status requires a passed attempt with demonstrated impact or independent cross-session verification; use this only after report_add_finding has created the candidate.",
  inputSchema: { type: "object", required: ["findingId", "status"], properties: { campaignId: { type: "string" }, findingId: { type: "string" }, status: { type: "string" }, testAttemptId: { type: "string" }, evidenceIds: { type: "array", items: { type: "string" } }, duplicateOf: { type: "string" }, reproduction: { type: "string" }, impact: { type: "string" }, remediation: { type: "string" } } },
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
    if (!["needs_verification", "verified", "duplicate", "not_applicable", "reported", "accepted", "rejected"].includes(status)) throw new Error(`unsupported finding status: ${status}`);
    if (status === "verified" && (!Array.isArray(args.evidenceIds) || args.evidenceIds.length === 0)) throw new Error("verified findings require evidenceIds");
    if (status === "verified" && (typeof args.testAttemptId !== "string" || !args.testAttemptId.trim())) throw new Error("verified findings require a passed testAttemptId");
    if (!context.store.updateFinding || !context.store.loadFinding) throw new Error("finding update is unavailable");
    const existing = context.store.loadFinding(asString(args.findingId, "findingId"));
    if (existing.campaignId && existing.campaignId !== campaignId) throw new Error("finding belongs to another campaign");
    if (status === "verified" && context.store.loadEvidence && context.store.loadSession) {
      const evidenceIds = (args.evidenceIds as unknown[]).map(String);
      for (const evidenceId of evidenceIds) {
        const evidence = context.store.loadEvidence(evidenceId);
        const evidenceSession = context.store.loadSession(evidence.sessionId);
        if (evidenceSession.campaignId !== campaignId) throw new Error(`evidence belongs to another campaign: ${evidenceId}`);
      }
    }
    if (status === "verified") {
      const attempt = requireCampaignStore(context, "loadTestAttempt")(asString(args.testAttemptId, "testAttemptId"));
      if (attempt.campaignId !== campaignId) throw new Error("test attempt belongs to another campaign");
      if (attempt.status !== "passed") throw new Error("verified findings require a passed test attempt");
      if (!["impact_demonstrated", "independently_verified"].includes(attempt.evidenceLevel)) throw new Error("test attempt has not demonstrated impact");
      if (attempt.evidenceLevel === "impact_demonstrated" && attempt.sessionId !== existing.sessionId) throw new Error("impact-demonstration attempts must belong to the finding session");
      if (attempt.evidenceLevel === "independently_verified" && attempt.sessionId === existing.sessionId) throw new Error("independent verification must come from a different session");
      const attemptEvidence = new Set(attempt.evidenceIds);
      const missingAttemptEvidence = (args.evidenceIds as unknown[]).map(String).filter((evidenceId) => !attemptEvidence.has(evidenceId));
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
