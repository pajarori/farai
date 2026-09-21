import type { Session, ToolDefinition } from "../types";
import { assertCanonicalToolName, canonicalToolName } from "../tool-names";
import { shellTools } from "./shell";
import { reconTools } from "./recon";
import { filesystemTools } from "./filesystem";
import { gitTools } from "./git";
import { knowledgeTools } from "./knowledge";
import { reportTools } from "./report";
import { codegenTools } from "./codegen";
import { callbackTools } from "./callback";
import { campaignTools } from "./campaign";
import { outputTools } from "./output/read";
import { contextTools } from "./context/expand";
import { browserTools } from "./browser";
import { kaliTools } from "./kali";
import { webTools } from "./web";
import { mediaTools } from "./media";
import { interactionTools } from "./interaction";
import { proxyTools } from "./proxy";
import { emailTools } from "./email";
import { androidTools } from "./android";
import { getMcpTool, listMcpTools } from "./mcp-manager";
import { facadeDelegates, facadeTool } from "./facades";
import { agentLifecycleTools } from "./agent/lifecycle";
import { sessionRenameTool } from "./agent/rename";
import { todoAddTool } from "./todo/add";
import { todoUpdateTool } from "./todo/update";
import { todoListTool } from "./todo/list";
import { updatePlanTool } from "./todo/update-plan";
import { worktreeEnterTool, worktreeExitTool } from "./worktree";
import { mcpResourceTool } from "./mcp-resources";
import { lspInspectTool } from "./lsp/inspect";
import { skillLoadTool } from "./knowledge/skill-load";
import { ToolRegistry, toolDefinition, toolRegistration } from "./tool-registry";
export { ToolRegistry, ToolRouter, ToolRuntime, toolDefinition, toolRegistration, toolSpec } from "./tool-registry";
export type { ToolName, ToolPlan, ToolRegistration, ToolSearchQuery as RegistryToolSearchQuery, ToolSpec } from "./tool-registry";

const browserManageTool = facadeTool("browser_manage", "Manage browser contexts and perform browser navigation, inspection, and interaction operations.", facadeDelegates(browserTools, /^browser_/), { visibility: "external" });
const agentManageTool = facadeTool("agent_manage", "Manage bounded child agents with operation=spawn, list, wait, message, followup, interrupt, close, or report and that operation's fields passed directly alongside operation. As a subagent, use operation=report to send an interim finding to your parent.", facadeDelegates(agentLifecycleTools, /^agent_/), { visibility: "core" });
const sessionManageTool = facadeTool("session_manage", "Rename the current session with operation=rename and a title field set to a concise non-empty title.", { rename: sessionRenameTool }, { visibility: "core" });
const mailManageTool = facadeTool("mail_manage", "List, create, inspect, and wait for email resources.", facadeDelegates(emailTools, /^email_/), { visibility: "external" });
const taskManageTool = facadeTool("task_manage", "Manage durable todos with operation=add, update, list, or plan and that operation's fields passed directly alongside operation.", { add: todoAddTool, update: todoUpdateTool, list: todoListTool, plan: updatePlanTool }, { visibility: "core" });
const worktreeManageTool = facadeTool("worktree_manage", "Manage isolated Git worktrees with operation=enter or exit and that operation's fields passed directly alongside operation.", { enter: worktreeEnterTool, exit: worktreeExitTool }, { visibility: "workspace" });
const codeDiagnosticsTool = { ...lspInspectTool, name: "code_diagnostics", description: "Inspect code through the configured language server." };
const proxyManageTool = facadeTool("proxy_manage", "Manage proxy scope, policy, captured flows, replay, interception, and cleanup.", facadeDelegates(proxyTools, /^proxy_/), { visibility: "external" });
const callbackManageTool = facadeTool("callback_manage", "Inspect callback interfaces and manage listeners or OAST sessions.", facadeDelegates(callbackTools, /^callback_/), { visibility: "callback" });
const campaignManageTool = facadeTool("campaign_manage", "Create, coordinate, checkpoint, verify, and report durable security campaigns.", facadeDelegates(campaignTools, /^campaign_/), { visibility: "verification" });
const skillLoadDelegate: ToolDefinition = {
  ...skillLoadTool,
  inputSchema: {
    oneOf: [
      skillLoadTool.inputSchema,
      {
        type: "object",
        required: ["skill"],
        properties: {
          skill: { type: "string" },
          resource: { type: "string" }
        },
        additionalProperties: false
      }
    ]
  },
  run: (args, context) => {
    if (!args || typeof args !== "object" || Array.isArray(args)) return skillLoadTool.run(args, context);
    const input = args as Record<string, unknown>;
    return skillLoadTool.run({ ...input, ...(input.name === undefined && typeof input.skill === "string" ? { name: input.skill } : {}) }, context);
  }
};
const knowledgeDelegates = { ...facadeDelegates(knowledgeTools, /^(?:knowledge_|memory_|notes_|evidence_)/), skill_load: skillLoadDelegate };
const knowledgeManageTool = facadeTool("knowledge_manage", "Search, resolve, traverse, prioritize, and persist security knowledge. Load a skill with operation=skill_load and a name or skill field.", knowledgeDelegates, { visibility: "workspace" });
const mobileManageTool = facadeTool("mobile_manage", "Manage Android devices, applications, static analysis, UI automation, and Frida workflows.", facadeDelegates(androidTools, /^android_/), { visibility: "recon" });
const findingManageTool = facadeTool("finding_manage", "Calculate CVSS and create or update security findings.", {
  calculate: reportTools.find((tool) => tool.name === "cvss_calculate")!,
  add_finding: reportTools.find((tool) => tool.name === "report_add_finding")!,
  update_finding: reportTools.find((tool) => tool.name === "report_update_finding")!
}, { visibility: "verification" });
const kaliSearchTool = { ...kaliTools.find((tool) => tool.name === "kali_search")!, name: "kali_search" };

export const baseTools: ToolDefinition[] = [
  ...shellTools,
  ...reconTools,
  ...filesystemTools,
  ...gitTools,
  knowledgeManageTool,
  taskManageTool,
  findingManageTool,
  ...codegenTools,
  callbackManageTool,
  campaignManageTool,
  ...outputTools,
  ...contextTools,
  codeDiagnosticsTool,
  browserManageTool,
  kaliSearchTool,
  agentManageTool,
  sessionManageTool,
  ...webTools,
  ...mediaTools,
  ...interactionTools,
  mcpResourceTool,
  worktreeManageTool,
  proxyManageTool,
  mailManageTool,
  mobileManageTool
];

let builtinRegistry = new ToolRegistry(baseTools.map(toolRegistration));

export function getToolRegistry(): ToolRegistry {
  return builtinRegistry;
}

export function registerTool(tool: ToolDefinition): void {
  assertCanonicalToolName(tool.name);
  builtinRegistry = builtinRegistry.register(toolRegistration(tool));
  baseTools.push(tool);
}

export function unregisterTool(tool: ToolDefinition): void {
  const index = baseTools.indexOf(tool);
  if (index !== -1) {
    baseTools.splice(index, 1);
    builtinRegistry = builtinRegistry.unregister(tool.name);
  }
}

export function listTools(): ToolDefinition[] {
  const tools = [...builtinRegistry.list().map(toolDefinition), ...listMcpTools()];
  assertUniqueTools(tools);
  return tools;
}

export function listToolsForSession(session: Session): ToolDefinition[] {
  const tools = [...builtinRegistry.list().map(toolDefinition), ...listMcpTools(session)];
  assertUniqueTools(tools);
  const scoped = session.toolScope?.length ? new Set(session.toolScope.map(canonicalToolName)) : undefined;
  return tools.filter((tool) => !scoped || scoped.has(tool.name));
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
  return (builtinRegistry.get(canonical) ? toolDefinition(builtinRegistry.get(canonical)!) : undefined) ?? getMcpTool(canonical, session);
}

export { processOutput } from "./shared/process-output";
export { refreshMcpTools } from "./mcp-manager";
export { ToolCatalog, toolCatalog } from "./catalog";
export type { ToolCatalogEntry, ToolSearchQuery } from "./catalog";
