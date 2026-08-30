import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { containerPathKind, containerRelativePath, containerStatMtime, containerWorkspace, containerWriteFile, resolveContainerPath } from "./container-fs";
import { appendDiagnosticReport } from "../../agent-lsp";

export const fsWriteTool: ToolDefinition = {
  name: "fs_write",
  description: "Create a workspace file or replace an existing file with the complete supplied content. Use this only when the full desired file is known; prefer fs_edit for one exact replacement and patch_apply for coordinated edits across one or more files.",
  inputSchema: {
    type: "object",
    required: ["path", "content"],
    properties: { path: { type: "string" }, content: { type: "string" } }
  },
  mutates: true,
  timeoutMs: 10_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const path = asString(args.path, "path");
    const workspace = containerWorkspace(context);
    const existed = (await containerPathKind(context, path)) === "file";
    const content = asString(args.content, "content");
    await containerWriteFile(context, path, content);
    if (context.fileState) {
      const mtime = await containerStatMtime(context, path);
      context.fileState.set(context.session.id, { path: resolveContainerPath(path, workspace), content, mtime: mtime ?? Date.now() });
    }
    const diagnostic = await context.lsp?.diagnose({ path, content }).catch(() => undefined);
    return {
      ok: true,
      summary: `${existed ? "wrote" : "created"} ${containerRelativePath(path, workspace)}`,
      output: appendDiagnosticReport(containerRelativePath(path, workspace), diagnostic) ?? containerRelativePath(path, workspace)
    };
  }
};
