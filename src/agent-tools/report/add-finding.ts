import type { ToolDefinition } from "../../types";
import { assertObject, asString, id } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { severity } from "./shared";

export const reportAddFindingTool: ToolDefinition = {
  name: "report_add_finding",
  description: "Create a structured finding draft.",
  inputSchema: {
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string" },
      severity: { type: "string" },
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
    const finding = {
      id: id(),
      sessionId: context.session.id,
      title: asString(args.title, "title"),
      severity: severity(args.severity),
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
      summary: `finding saved: ${finding.title}`,
      output: JSON.stringify(finding, null, 2)
    };
  }
};
