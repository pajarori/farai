import type { ToolDefinition } from "../../types";
import { assertObject, asString, id } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { cvssAssessment } from "./shared";

export const reportAddFindingTool: ToolDefinition = {
  name: "report_add_finding",
  description: "Create and persist a candidate security finding for the current session; persisted findings immediately appear in Farai's Findings tab and reports. Provide a complete CVSS:3.1 base vector; Farai calculates the score and derives severity. This drafts a finding but does not verify it; campaign findings require campaign_verify and reproducible evidence before being treated as confirmed.",
  inputSchema: {
    type: "object",
    required: ["title", "cvssVector"],
    properties: {
      title: { type: "string", description: "short, specific vulnerability title" },
      cvssVector: { type: "string", description: "complete CVSS:3.1 base vector. use only AV, AC, PR, UI, S, C, I, and A metrics; calculate it with cvss_calculate first when uncertain" },
      severity: { type: "string", description: "legacy compatibility only; ignored when cvssVector is present. never use this to guess severity" },
      target: { type: "string", description: "affected URL, endpoint, host, service, file, or asset" },
      evidenceIds: { type: "array", items: { type: "string" }, uniqueItems: true, description: "ids of saved evidence that directly support the finding" },
      impact: { type: "string", description: "security impact demonstrated by the evidence. rendered as markdown in the findings tab and reports" },
      reproduction: { type: "string", description: "minimal reproducible steps and observed result. rendered as markdown, so write it well: use an ordered list for steps, fenced code blocks for requests, responses, payloads, and commands, and tables where they clarify" },
      remediation: { type: "string", description: "specific corrective action. rendered as markdown in the findings tab and reports" },
      campaignId: { type: "string", description: "campaign to attach; normally inherited from the active campaign" },
      hypothesisId: { type: "string", description: "campaign hypothesis supported by this candidate" }
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
