import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { containerPathKind, containerRelativePath, containerStatMtime, containerWriteFile, resolveContainerPath } from "./container-fs";
import { appendDiagnosticReport } from "../../agent-lsp";

export const fsWriteTool: ToolDefinition = {
  name: "fs_write",
  description: "Create or overwrite a workspace file. Runs inside the Kali container.",
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
    const existed = (await containerPathKind(context, path)) === "file";
    const content = asString(args.content, "content");
    await containerWriteFile(context, path, content);
    if (context.fileState) {
      const mtime = await containerStatMtime(context, path);
      context.fileState.set(context.session.id, { path: resolveContainerPath(path), content, mtime: mtime ?? Date.now() });
    }
    const diagnostic = await context.lsp?.diagnose({ path, content }).catch(() => undefined);
    return {
      ok: true,
      summary: `${existed ? "wrote" : "created"} ${containerRelativePath(path)}`,
      output: appendDiagnosticReport(containerRelativePath(path), diagnostic) ?? containerRelativePath(path)
    };
  }
};
