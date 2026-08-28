import type { ToolDefinition } from "../../types";
import { assertObject } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { runHostProcess } from "../shared/run-host-process";
import { safeWorkspacePath } from "../filesystem/shared";

export const gitDiffTool: ToolDefinition = {
  name: "git_diff",
  description: "Show git diff for the workspace.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, staged: { type: "boolean" } }
  },
  mutates: false,
  timeoutMs: 10_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const commandArgs = ["diff"];
    if (args.staged === true) commandArgs.push("--cached");
    if (typeof args.path === "string") {
      safeWorkspacePath(context.workspace, args.path, "read");
      commandArgs.push("--", args.path);
    }
    const result = await runHostProcess("git", commandArgs, context.workspace, context);
    return { ok: result.exitCode === 0, summary: "git diff", output: result.stdout || result.stderr || "no diff" };
  }
};
