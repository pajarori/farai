import type { Finding, ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { cvssAssessment } from "./shared";

function assertFindingAccess(context: Parameters<ToolDefinition["run"]>[1], finding: Finding): void {
  if (finding.sessionId === context.session.id) return;
  if (finding.campaignId && finding.campaignId === context.session.campaignId) return;
  throw new Error("finding belongs to another session or campaign");
}

function assertEvidenceAccess(context: Parameters<ToolDefinition["run"]>[1], finding: Finding, evidenceIds: string[]): void {
  if (!evidenceIds.length || !context.store.loadEvidence || !context.store.loadSession) return;
  for (const evidenceId of evidenceIds) {
    const evidence = context.store.loadEvidence(evidenceId);
    const evidenceSession = context.store.loadSession(evidence.sessionId);
    if (evidenceSession.id !== finding.sessionId && (!finding.campaignId || evidenceSession.campaignId !== finding.campaignId)) {
      throw new Error(`evidence does not belong to the finding session or campaign: ${evidenceId}`);
    }
  }
}

export const reportUpdateFindingTool: ToolDefinition = {
  name: "report_update_finding",
  description: "Update one existing finding by findingId without creating a duplicate. Use this to correct a CVSS:3.1 vector, title, target, evidence links, impact, reproduction, or remediation after new evidence. A changed cvssVector is recalculated and severity is derived automatically; update one finding at a time and never change AV or other metrics by guesswork or by applying a batch-wide assumption. Use campaign_verify for finding lifecycle status transitions.",
  inputSchema: {
    type: "object",
    required: ["findingId"],
    properties: {
      findingId: { type: "string", description: "existing finding UUID returned by report_add_finding, campaign_search, or the Findings view" },
      title: { type: "string", description: "replacement concise finding title" },
      cvssVector: { type: "string", description: "replacement complete CVSS:3.1 base vector; use cvss_calculate first and change only metrics supported by new evidence" },
      target: { type: "string", description: "replacement affected URL, endpoint, host, service, file, or asset" },
      evidenceIds: { type: "array", uniqueItems: true, items: { type: "string" }, description: "complete replacement list of evidence UUIDs supporting the current finding; include evidence for a CVSS change" },
      impact: { type: "string", description: "updated demonstrated security impact. rendered as markdown in the findings tab and reports" },
      reproduction: { type: "string", description: "updated minimal reproducible steps and observed result. rendered as markdown, so write it well: use an ordered list for steps, fenced code blocks for requests, responses, payloads, and commands, and tables where they clarify" },
      remediation: { type: "string", description: "updated specific corrective action. rendered as markdown in the findings tab and reports" }
    },
    additionalProperties: false,
    minProperties: 2
  },
  mutates: true,
  timeoutMs: 5_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    if (!context.store.loadFinding || !context.store.updateFinding) throw new Error("finding update is unavailable");
    const findingId = asString(args.findingId, "findingId");
    const existing = context.store.loadFinding(findingId);
    assertFindingAccess(context, existing);
    const hasCvss = Object.prototype.hasOwnProperty.call(args, "cvssVector");
    const evidenceIds = Array.isArray(args.evidenceIds) ? args.evidenceIds.map((value) => asString(value, "evidenceIds[]")) : undefined;
    if (hasCvss && (!evidenceIds || evidenceIds.length === 0)) throw new Error("changing cvssVector requires evidenceIds that support the new metric assessment");
    assertEvidenceAccess(context, existing, evidenceIds ?? []);
    const patch = {
      ...(typeof args.title === "string" ? { title: args.title } : {}),
      ...(hasCvss ? { cvssVector: cvssAssessment(args.cvssVector).vector } : {}),
      ...(typeof args.target === "string" ? { target: args.target } : {}),
      ...(evidenceIds ? { evidenceIds } : {}),
      ...(typeof args.impact === "string" ? { impact: args.impact } : {}),
      ...(typeof args.reproduction === "string" ? { reproduction: args.reproduction } : {}),
      ...(typeof args.remediation === "string" ? { remediation: args.remediation } : {})
    };
    const finding = context.store.updateFinding(existing.id, patch);
    return {
      ok: true,
      summary: `finding updated: ${finding.title}${finding.cvssScore === undefined ? "" : ` · cvss ${finding.cvssScore.toFixed(1)} ${finding.severity}`}`,
      output: JSON.stringify(finding, null, 2)
    };
  }
};
