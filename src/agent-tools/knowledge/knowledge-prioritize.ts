import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";

export const knowledgePrioritizeTool: ToolDefinition = {
  name: "knowledge_prioritize",
  description: "Return exploitation-prioritization signals for a CVE from CISA KEV (known exploited) and FIRST EPSS (exploit prediction). These are prioritization signals, not proof that the target is exploitable — always verify against the actual target.",
  inputSchema: {
    type: "object",
    required: ["cve"],
    properties: { cve: { type: "string", description: "CVE identifier, e.g. CVE-2021-44228" } }
  },
  mutates: false,
  timeoutMs: 5_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    if (!context.knowledge) {
      return { ok: false, summary: "knowledge base not available", output: "knowledge.db not built yet - run: farai setup --no-docker" };
    }
    const cve = asString(args.cve, "cve");
    const signal = context.knowledge.prioritize(cve);
    if (!signal) {
      return { ok: true, summary: `no prioritization signal for ${cve}`, output: "no kev/epss record; the cve may be new, disputed, or enrichment is not loaded" };
    }
    const lines = [
      `${signal.cve}`,
      `kev_listed: ${signal.kevListed}${signal.kevDate ? ` (added ${signal.kevDate})` : ""}`,
      ...(signal.ransomware ? [`known_ransomware_use: ${signal.ransomware}`] : []),
      ...(signal.epss !== undefined ? [`epss: ${signal.epss} (percentile ${signal.epssPercentile ?? "?"})`] : []),
      ...(signal.asOf ? [`as_of: ${signal.asOf}`] : []),
      "signal only — verify exploitability against the actual target."
    ];
    return { ok: true, summary: `prioritization for ${signal.cve}`, output: lines.join("\n") };
  }
};
