import type { ToolDefinition } from "../../types";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { runHostProcess } from "../shared/run-host-process";

export const gitStatusTool: ToolDefinition = {
  name: "git_status",
  description: "Show the active workspace's concise Git status, including modified, staged, deleted, renamed, and untracked paths. Use this read-only check before and after edits; it does not display patch contents or alter the repository.",
  inputSchema: { type: "object", properties: {} },
  mutates: false,
  timeoutMs: 10_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (_args, context) => {
    const result = await runHostProcess("git", ["status", "--short"], context.workspace, context);
    return { ok: result.exitCode === 0, summary: "git status", output: result.stdout || result.stderr || "clean" };
  }
};
