import type { Session, ToolDefinition } from "../types";
import { assertCanonicalToolName, canonicalToolName } from "../tool-names";
import { shellTools } from "./shell";
import { reconTools } from "./recon";
import { filesystemTools } from "./filesystem";
import { gitTools } from "./git";
import { knowledgeTools } from "./knowledge";
import { todoTools } from "./todo";
import { reportTools } from "./report";
import { codegenTools } from "./codegen";
import { callbackTools } from "./callback";
import { campaignTools } from "./campaign";
import { outputTools } from "./output/read";
import { deferredTools } from "./deferred";
import { lspTools } from "./lsp";
import { browserTools } from "./browser";
import { kaliTools } from "./kali";
import { agentTools } from "./agent";
import { webTools } from "./web";
import { mediaTools } from "./media";
import { interactionTools } from "./interaction";
import { mcpResourceTools } from "./mcp-resources";
import { worktreeTools } from "./worktree";
import { proxyTools } from "./proxy";
import { getMcpTool, listMcpTools } from "./mcp-manager";

export const baseTools: ToolDefinition[] = [
  ...shellTools,
  ...reconTools,
  ...filesystemTools,
  ...gitTools,
  ...knowledgeTools,
  ...todoTools,
  ...reportTools,
  ...codegenTools,
  ...callbackTools,
  ...campaignTools,
  ...outputTools,
  ...lspTools,
  ...browserTools,
  ...kaliTools,
  ...agentTools,
  ...webTools,
  ...mediaTools,
  ...interactionTools,
  ...mcpResourceTools,
  ...worktreeTools,
  ...proxyTools,
  ...deferredTools
];

export function registerTool(tool: ToolDefinition): void {
  assertCanonicalToolName(tool.name);
  if (listTools().some((existing) => existing.name === tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
  baseTools.push(tool);
}

export function unregisterTool(tool: ToolDefinition): void {
  const index = baseTools.indexOf(tool);
  if (index !== -1) baseTools.splice(index, 1);
}

export function listTools(): ToolDefinition[] {
  const tools = [...baseTools, ...listMcpTools()];
  assertUniqueTools(tools);
  return tools;
}

export function listToolsForSession(session: Session): ToolDefinition[] {
  const tools = [...baseTools, ...listMcpTools(session)];
  assertUniqueTools(tools);
  const scoped = session.toolScope?.length ? new Set(session.toolScope.map(canonicalToolName)) : undefined;
  return tools.filter((tool) => !scoped || scoped.has(tool.name) || tool.name === "tool_search" || tool.name === "tool_invoke");
}

function assertUniqueTools(tools: ToolDefinition[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    assertCanonicalToolName(tool.name);
    if (seen.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
  }
}

export function getTool(name: string, session?: Session): ToolDefinition | undefined {
  const canonical = canonicalToolName(name);
  return baseTools.find((tool) => tool.name === canonical) ?? getMcpTool(canonical, session);
}

export { processOutput } from "./shared/process-output";
export { refreshMcpTools } from "./mcp-manager";
