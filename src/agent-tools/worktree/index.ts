import type { ToolDefinition, ToolResult } from "../../types";
import { assertObject, asString, maybeString } from "../../utils";

const render = (result: ToolResult): string => result.output ?? result.summary;

export const worktreeEnterTool: ToolDefinition = {
  name: "worktree_enter",
  description: "Create or re-enter an isolated Git worktree beneath .farai/worktrees and switch the current session's active workspace to it. Use this to isolate risky or parallel code changes; workspace-bound services are reset during the switch, and branch is optional for detached operation.",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string" },
      ref: { type: "string", description: "Git ref to base the worktree on; defaults to HEAD" },
      branch: { type: "string", description: "optional new branch name; omit for a detached worktree" }
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 30_000,
  parallel: false,
  concurrencyScope: "session",
  renderHuman: render,
  renderModel: render,
  run: async (args, context) => {
    assertObject(args, "args");
    if (!context.worktreeControl) throw new Error("worktree lifecycle is unavailable in this runtime");
    const result = await context.worktreeControl.enter({ name: asString(args.name, "name"), ...(maybeString(args.ref) ? { ref: maybeString(args.ref)! } : {}), ...(maybeString(args.branch) ? { branch: maybeString(args.branch)! } : {}) });
    return {
      ok: true,
      summary: `${result.created ? "created and entered" : "re-entered"} isolated worktree ${result.path}`,
      output: [`path: ${result.path}`, `ref: ${result.ref}`, ...(result.branch ? [`branch: ${result.branch}`] : ["mode: detached HEAD"])].join("\n"),
      metadata: result
    };
  }
};

export const worktreeExitTool: ToolDefinition = {
  name: "worktree_exit",
  description: "Switch the current session from its isolated worktree back to the main workspace, preserving the worktree by default. Set remove=true only when the worktree is clean and no workspace-bound services remain; uncommitted or active work prevents removal.",
  inputSchema: {
    type: "object",
    properties: {
      remove: { type: "boolean", description: "remove the clean worktree after leaving it; defaults to false" }
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 30_000,
  parallel: false,
  concurrencyScope: "session",
  renderHuman: render,
  renderModel: render,
  run: async (args, context) => {
    assertObject(args, "args");
    if (!context.worktreeControl) throw new Error("worktree lifecycle is unavailable in this runtime");
    const result = await context.worktreeControl.exit({ remove: args.remove === true });
    return {
      ok: true,
      summary: `${result.removed ? "removed" : "preserved"} isolated worktree ${result.path}`,
      output: [`active workspace: ${result.root}`, `worktree: ${result.removed ? "removed" : `preserved at ${result.path}`}`].join("\n"),
      metadata: result
    };
  }
};

export const worktreeTools: ToolDefinition[] = [worktreeEnterTool, worktreeExitTool];
