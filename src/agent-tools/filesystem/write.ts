import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { containerPathKind, containerReadFile, containerRelativePath, containerStatMtime, containerWorkspace, containerWriteFile, resolveContainerPath } from "./container-fs";
import { previewWrite } from "./shared";
import { appendDiagnosticReport } from "../../agent-lsp";

export const fsWriteTool: ToolDefinition = {
  name: "file_write",
  description: "Create a workspace file or replace an existing file with the complete supplied content. Use this only when the full desired file is known; prefer file_replace for one exact replacement and file_patch for coordinated edits across one or more files.",
  inputSchema: {
    type: "object",
    required: ["path", "content"],
    properties: { path: { type: "string" }, content: { type: "string" } },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: Number.POSITIVE_INFINITY,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const path = asString(args.path, "path");
    const workspace = containerWorkspace(context);
    const existed = (await containerPathKind(context, path)) === "file";
    const content = asString(args.content, "content");
    const previous = existed ? await containerReadFile(context, path).catch(() => "") : "";
    await containerWriteFile(context, path, content);
    if (context.fileState) {
      const mtime = await containerStatMtime(context, path);
      context.fileState.set(context.session.id, { path: resolveContainerPath(path, workspace), content, mtime: mtime ?? Date.now() });
    }
    const diagnostic = await context.lsp?.diagnose({ path, content }).catch(() => undefined);
    const preview = previewWrite(previous, content, !existed);
    return {
      ok: true,
      summary: `${existed ? "wrote" : "created"} ${containerRelativePath(path, workspace)}`,
      output: appendDiagnosticReport(preview, diagnostic) ?? preview
    };
  }
};
