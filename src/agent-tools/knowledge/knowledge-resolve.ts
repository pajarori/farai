import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";

export const knowledgeResolveTool: ToolDefinition = {
  name: "knowledge_resolve",
  description: "Resolve a CVE, CWE, CAPEC, ATT&CK identifier, alias, or name fragment into matching authoritative taxonomy nodes. Use this to obtain exact node ids before knowledge_neighbors; it does not search narrative knowledge records or the public internet.",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string", description: "identifier (CVE-2021-44228, CWE-89, T1190) or name fragment (log4shell, sql injection)" } }
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
    const name = asString(args.name, "name");
    const nodes = context.knowledge.resolve(name);
    if (!nodes.length) {
      return { ok: true, summary: `no node for ${name}`, output: "no authoritative node found; try knowledge_search for prose entries" };
    }
    const output = nodes.map((node) => `${node.id} [${node.kind}] ${node.name}${node.summary ? `\n  ${node.summary}` : ""}`).join("\n");
    return { ok: true, summary: `${nodes.length} node(s) for ${name}`, output };
  }
};
