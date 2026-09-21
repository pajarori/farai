import type { ToolDefinition } from "../../types";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { runHostProcess } from "../shared/run-host-process";

export const gitStatusTool: ToolDefinition = {
  name: "git_status",
  description: "Show the active workspace's concise Git status, including modified, staged, deleted, renamed, and untracked paths. Use this read-only check before and after edits; it does not display patch contents or alter the repository.",
  inputSchema: { type: "object", properties: {} },
  mutates: false,
  timeoutMs: Number.POSITIVE_INFINITY,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (_args, context) => {
    const result = await runHostProcess("git", ["status", "--short"], context.workspace, context);
    if (result.exitCode !== 0) {
      if (/not a git repository/i.test(result.stderr)) {
        return { ok: false, summary: "not a git repository", output: "this workspace is not a git repository; run `git init` (via command_run) before using git tools." };
      }
      return { ok: false, summary: "git status failed", output: result.stderr || "git status failed" };
    }
    return { ok: true, summary: result.stdout.trim() ? "git status" : "working tree clean", output: result.stdout || "clean" };
  }
};
