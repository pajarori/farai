import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { calculateCvss31 } from "../../security/cvss31";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";

export const cvssCalculateTool: ToolDefinition = {
  name: "cvss_calculate",
  description: "Calculate a CVSS 3.1 base score and severity from a complete base vector. Use this before report_add_finding whenever impact, exploitability, or severity needs to be assessed; never guess a severity label when the vector can be described.",
  inputSchema: {
    type: "object",
    required: ["vector"],
    properties: {
      vector: { type: "string", description: "complete CVSS:3.1 base vector in this order or any order: CVSS:3.1/AV:<N|A|L|P>/AC:<L|H>/PR:<N|L|H>/UI:<N|R>/S:<U|C>/C:<N|L|H>/I:<N|L|H>/A:<N|L|H>" }
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 5_000,
  parallel: true,
  visibility: "verification",
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args) => {
    assertObject(args, "args");
    const assessment = calculateCvss31(asString(args.vector, "vector"));
    return {
      ok: true,
      summary: `cvss 3.1 · ${assessment.score.toFixed(1)} · ${assessment.severity}`,
      output: JSON.stringify(assessment, null, 2)
    };
  }
};
