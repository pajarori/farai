import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";

export const knowledgePrioritizeTool: ToolDefinition = {
  name: "knowledge_prioritize",
  description: "Return CISA KEV known-exploitation status and FIRST EPSS probability signals for one CVE. Use these values to prioritize investigation, not as proof that the target contains the vulnerable version or that exploitation will succeed.",
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
