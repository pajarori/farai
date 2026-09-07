import type { ToolDefinition } from "../../types";
import { assertObject, asString, id } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { cvssAssessment } from "./shared";

export const reportAddFindingTool: ToolDefinition = {
  name: "report_add_finding",
  description: "Create and persist a candidate security finding for the current session; persisted findings immediately appear in Farai's Findings tab and reports. For every new finding, provide cvssVector as a complete CVSS:3.1 base vector; Farai calculates cvssScore and derives severity from that score. The severity input is retained only for legacy records without CVSS data. This drafts a finding but does not verify it; campaign findings require campaign_verify and reproducible evidence before being treated as confirmed.",
  inputSchema: {
    type: "object",
    required: ["title", "cvssVector"],
    properties: {
      title: { type: "string" },
      cvssVector: { type: "string", description: "complete CVSS:3.1 base vector, for example CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" },
      severity: { type: "string", description: "deprecated legacy input; severity is always derived from cvssVector" },
      target: { type: "string" },
      evidenceIds: { type: "array", items: { type: "string" } },
      impact: { type: "string" },
      reproduction: { type: "string" },
      remediation: { type: "string" }
      ,campaignId: { type: "string" }
      ,hypothesisId: { type: "string" }
    }
  },
  mutates: true,
  timeoutMs: 5_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const target = typeof args.target === "string" ? args.target : "unknown";
    const assessment = cvssAssessment(args.cvssVector);
    const finding = {
      id: id(),
      sessionId: context.session.id,
      title: asString(args.title, "title"),
      severity: assessment.severity,
      cvssVector: assessment.vector,
      cvssScore: assessment.score,
      target,
      evidenceIds: Array.isArray(args.evidenceIds) ? args.evidenceIds.map(String) : [],
      impact: typeof args.impact === "string" ? args.impact : "",
      reproduction: typeof args.reproduction === "string" ? args.reproduction : "",
      remediation: typeof args.remediation === "string" ? args.remediation : "",
      status: "candidate" as const,
      ...(typeof args.campaignId === "string" ? { campaignId: args.campaignId } : context.session.campaignId ? { campaignId: context.session.campaignId } : {}),
      ...(typeof args.hypothesisId === "string" ? { hypothesisId: args.hypothesisId } : {})
    };
    context.store.saveFinding(finding);
    return {
      ok: true,
      summary: `finding saved: ${finding.title} · cvss ${assessment.score.toFixed(1)} ${assessment.severity}`,
      output: JSON.stringify(finding, null, 2)
    };
  }
};
