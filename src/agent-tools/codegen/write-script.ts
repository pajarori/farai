import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { safePathInside } from "../filesystem/shared";
import { containerRelativePath, containerWriteFile } from "../filesystem/container-fs";

export const writeScriptTool: ToolDefinition = {
  name: "code_write_script",
  description: "Write a helper script inside the workspace helpers directory. Runs inside the Kali container.",
  inputSchema: {
    type: "object",
    required: ["filename", "content"],
    properties: { filename: { type: "string" }, content: { type: "string" } }
  },
  mutates: true,
  timeoutMs: 10_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const filename = asString(args.filename, "filename");
    const content = asString(args.content, "content");
    const relativePath = safePathInside("helpers", filename);
    await containerWriteFile(context, relativePath, content);
    return { ok: true, summary: `helper script written: ${containerRelativePath(relativePath)}`, output: containerRelativePath(relativePath) };
  }
};
