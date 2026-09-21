import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { containerGrep } from "./container-fs";

export const fsGrepTool: ToolDefinition = {
  name: "file_search",
  description: "Search text content across workspace files with a regular expression and return bounded file, line, and matching-text results. Use include to narrow filenames; use file_list for path discovery and command_run with rg only when advanced search flags are required.",
  inputSchema: {
    type: "object",
    required: ["pattern"],
    properties: { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" }, limit: { type: "number" } }
  },
  mutates: false,
  timeoutMs: Number.POSITIVE_INFINITY,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const pattern = asString(args.pattern, "pattern");
    new RegExp(pattern);
    const root = typeof args.path === "string" ? args.path : ".";
    const include = typeof args.include === "string" ? args.include : undefined;
    const limit = typeof args.limit === "number" ? Math.max(1, Math.floor(args.limit)) : 100;
    const matches = await containerGrep(context, root, pattern, include, limit);
    return { ok: true, summary: `${matches.length} match(es)`, output: matches.join("\n") || "No matches" };
  }
};
