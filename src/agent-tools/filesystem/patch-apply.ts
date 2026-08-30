import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { containerApplySimplePatch, containerReadFile, containerWorkspace, resolveContainerPath } from "./container-fs";
import { appendDiagnosticReports } from "../../agent-lsp";

export const patchApplyTool: ToolDefinition = {
  name: "patch_apply",
  description: "Apply a Farai patch containing one or more file additions, contextual updates, or deletions inside the workspace. Use this for coordinated code edits and reviewable multi-hunk changes; use fs_edit for a single exact replacement.",
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
    const workspace = containerWorkspace(context);
    const applied = await containerApplySimplePatch(context, asString(args.patch, "patch"));
    if (context.fileState) {
      for (const entry of applied) {
        const rel = entry.slice(2).trim();
        if (rel) context.fileState.invalidate(context.session.id, resolveContainerPath(rel, workspace));
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
