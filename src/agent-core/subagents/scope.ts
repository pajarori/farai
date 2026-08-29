import type { Session, ToolDefinition } from "../../types";
import { canonicalToolName } from "../../tool-names";

const SHARED_WORKSPACE_EDIT_TOOLS = new Set(["fs_write", "fs_edit", "patch_apply", "code_write_script"]);
const TOOL_SCOPE_ALIASES = new Map([
  ["shell", "shell_exec"]
]);

function scopedToolName(name: string): string {
  const canonical = canonicalToolName(name);
  return TOOL_SCOPE_ALIASES.get(canonical) ?? canonical;
}

export function resolveSubagentToolScope(input: {
  parent: Session;
  availableTools: ToolDefinition[];
  requestedTools?: string[];
}): string[] | undefined {
  const available = new Set(input.availableTools.map((tool) => canonicalToolName(tool.name)));
  const requested = input.requestedTools?.map(scopedToolName);
  if (requested) {
    const unique = [...new Set(requested)];
    if (unique.length === 0) throw new Error("subagent tool scope must contain at least one tool");
    const unavailable = unique.filter((name) => !available.has(name));
    if (unavailable.length) throw new Error(`subagent tool scope exceeds the parent session: ${unavailable.join(", ")}`);
    return unique;
  }
  if (!input.parent.toolScope?.length) return undefined;
  const inherited = [...new Set(input.parent.toolScope.map(canonicalToolName))].filter((name) => available.has(name));
  if (inherited.length === 0) throw new Error("parent session has no delegable tools");
  return inherited;
}

export function hasSharedWorkspaceEdits(tools: string[] | undefined): boolean {
  if (!tools) return true;
  return tools.map(canonicalToolName).some((tool) => SHARED_WORKSPACE_EDIT_TOOLS.has(tool));
}

export function buildSubagentTaskPrompt(input: {
  title: string;
  task: string;
  lane?: string;
  lanePrompt?: string;
  parentSessionId: string;
  tools?: string[];
}): string {
  return [
    "you are a subagent working for a parent farai session.",
    `parent session: ${input.parentSessionId}`,
    `task: ${input.title}`,
    ...(input.lane ? [`lane: ${input.lane}`] : []),
    ...(input.tools?.length ? [`tool scope: ${input.tools.join(", ")}`] : []),
    "work autonomously on the delegated task. you may delegate concrete independent subtasks when useful. avoid repeating parent work or broadening the task without evidence.",
    "preserve exact evidence and return one concise result with status, summary, claims, artifacts, changes, coverage, uncertainty, next actions, and metrics. distinguish proven, candidate, disproven, and inconclusive claims. the parent owns synthesis and the final answer.",
    ...(input.lanePrompt ? [input.lanePrompt] : []),
    input.task
  ].join("\n\n");
}
