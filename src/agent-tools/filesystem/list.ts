import type { ToolDefinition } from "../../types";
import { assertObject } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { containerListFilesRecursive } from "./container-fs";

export const fsListTool: ToolDefinition = {
  name: "fs_list",
  description: "List workspace files recursively with optional path and limit. Runs inside the Kali container.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, limit: { type: "number" } }
  },
  mutates: false,
  timeoutMs: 15_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const root = typeof args.path === "string" ? args.path : ".";
    const files = await containerListFilesRecursive(context, root, typeof args.limit === "number" ? args.limit : 200);
    return { ok: true, summary: `${files.length} file(s)`, output: files.join("\n") };
  }
};
