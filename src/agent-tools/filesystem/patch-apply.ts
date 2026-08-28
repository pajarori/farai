import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { containerApplySimplePatch, containerReadFile, resolveContainerPath } from "./container-fs";
import { appendDiagnosticReports } from "../../agent-lsp";

export const patchApplyTool: ToolDefinition = {
  name: "patch_apply",
  description: "Apply a simple Farai-style add/update/delete patch inside the workspace. Runs inside the Kali container.",
  inputSchema: {
    type: "object",
    required: ["patch"],
    properties: { patch: { type: "string" } }
  },
  mutates: true,
  timeoutMs: 15_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const applied = await containerApplySimplePatch(context, asString(args.patch, "patch"));
    if (context.fileState) {
      for (const entry of applied) {
        const rel = entry.slice(2).trim();
        if (rel) context.fileState.invalidate(context.session.id, resolveContainerPath(rel));
      }
    }
    const edited = applied.filter((entry) => entry.startsWith("A ") || entry.startsWith("M ")).slice(0, 8);
    const diagnostics = context.lsp
      ? await Promise.all(edited.map(async (entry) => {
          const path = entry.slice(2).trim();
          try {
            const content = await containerReadFile(context, path);
            return await context.lsp!.diagnose({ path, content });
          } catch {
            return undefined;
          }
        }))
      : [];
    return {
      ok: true,
      summary: `applied ${applied.length} patch operation(s)`,
      output: appendDiagnosticReports(applied.join("\n"), diagnostics) ?? applied.join("\n")
    };
  }
};
