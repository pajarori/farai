import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { containerReadFile, containerRelativePath, containerStatMtime, containerWorkspace, containerWriteFile, resolveContainerPath } from "./container-fs";
import { occurrences, previewEdit } from "./shared";
import { appendDiagnosticReport } from "../../agent-lsp";

export const fsEditTool: ToolDefinition = {
  name: "fs_edit",
  description: "Replace an exact text block in one workspace file while preserving all other content. The match must be unique unless replaceAll=true; use patch_apply for multi-file or multi-hunk changes and fs_write only for deliberate full-file replacement.",
  inputSchema: {
    type: "object",
    required: ["path", "oldString", "newString"],
    properties: { path: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" }, replaceAll: { type: "boolean" } }
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
    const oldString = asString(args.oldString, "oldString");
    const newString = asString(args.newString, "newString");
    if (oldString === newString) throw new Error("oldString and newString must differ");
    const text = await containerReadFile(context, path);
    const count = occurrences(text, oldString);
    if (count === 0) throw new Error("Could not find oldString in file");
    if (count > 1 && args.replaceAll !== true) throw new Error("Found multiple matches; set replaceAll=true or provide more context");
    const next = args.replaceAll === true ? text.replaceAll(oldString, newString) : text.replace(oldString, newString);
    await containerWriteFile(context, path, next);
    if (context.fileState) {
      const mtime = await containerStatMtime(context, path);
      context.fileState.set(context.session.id, { path: resolveContainerPath(path, workspace), content: next, mtime: mtime ?? Date.now() });
    }
    const diagnostic = await context.lsp?.diagnose({ path, content: next }).catch(() => undefined);
    return {
      ok: true,
      summary: `edited ${containerRelativePath(path, workspace)} replacements=${args.replaceAll === true ? count : 1}`,
      output: appendDiagnosticReport(previewEdit(oldString, newString), diagnostic) ?? previewEdit(oldString, newString)
    };
  }
};
