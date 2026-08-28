import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";

export const knowledgeNeighborsTool: ToolDefinition = {
  name: "knowledge_neighbors",
  description: "Traverse authoritative cross-reference edges of a taxonomy node (CVE has_weakness CWE, CAPEC exploits_weakness CWE, CAPEC maps_to_technique ATT&CK, CWE child_of CWE, ATT&CK sub_technique_of / in_tactic). Deterministic and authoritative — prefer this over guessing relationships.",
  inputSchema: {
    type: "object",
    required: ["node_id"],
    properties: {
      node_id: { type: "string", description: "node id from knowledge_resolve (e.g. CWE-89, CVE-2021-44228, T1190)" },
      rel: { type: "string", description: "optional edge type filter: has_weakness, exploits_weakness, maps_to_technique, child_of, sub_technique_of, in_tactic" },
      direction: { type: "string", enum: ["out", "in"], description: "out = edges from the node, in = edges pointing to it" }
    }
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
    const nodeId = asString(args.node_id, "node_id");
    const options: { rel?: string; direction?: "out" | "in" } = {};
    if (typeof args.rel === "string") options.rel = args.rel;
    if (args.direction === "out" || args.direction === "in") options.direction = args.direction;
    const neighbors = context.knowledge.neighbors(nodeId, options);
    if (!neighbors.length) {
      return { ok: true, summary: `no edges from ${nodeId}`, output: "no authoritative edges; confirm the node id with knowledge_resolve" };
    }
    const output = neighbors
      .map((neighbor) => `${neighbor.direction === "out" ? "→" : "←"} ${neighbor.rel} ${neighbor.node.id} [${neighbor.node.kind}] ${neighbor.node.name}`)
      .join("\n");
    return { ok: true, summary: `${neighbors.length} edge(s) for ${nodeId}`, output };
  }
};
