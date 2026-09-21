import type { ToolResult } from "../types";
import { canonicalToolName } from "../tool-names";
import { compactToolTarget, compactToolText, compactToolUrl, toolDefinition } from "./tool-presentation";

export type ToolLifecycleFamily =
  | "command"
  | "workspace"
  | "browser"
  | "http"
  | "proxy"
  | "recon"
  | "knowledge"
  | "campaign"
  | "agent"
  | "mcp"
  | "media"
  | "email"
  | "generic";

export type ToolLifecycleDetail = "summary" | "preview" | "full";

export type ToolLifecyclePolicy = {
  tool: string;
  args: Record<string, unknown>;
  family: ToolLifecycleFamily;
  noun: string;
  groupKey?: string;
  groupPast?: string;
  groupActive?: string;
  groupMutations?: boolean;
  groupItem?: string;
  groupNoun?: string;
  groupMaxItems?: number;
  detail: ToolLifecycleDetail;
  showOutcome: boolean;
  standalone: boolean;
};

export type ToolLifecycleInput = {
  tool: string;
  args: unknown;
  status: string;
  metadata: Record<string, unknown>;
  result?: ToolResult;
  warning: boolean;
  definitionMutates?: boolean;
};

type ToolRule = {
  groupKey: string;
  groupPast: string;
  groupActive: string;
  groupMutations?: boolean;
  groupNoun?: string;
  groupMaxItems?: number;
  detail?: ToolLifecycleDetail;
  showOutcome?: boolean;
  groupItem?: (args: Record<string, unknown>, metadata: Record<string, unknown>) => string | undefined;
};

const TOOL_RULES: Record<string, ToolRule> = {
  skill_load: {
    groupKey: "skills",
    groupPast: "loaded skills",
    groupActive: "loading skills",
    groupNoun: "skill",
    groupMaxItems: 8,
    detail: "summary",
    showOutcome: false,
    groupItem: (args, metadata) => compactValue(stringValue(metadata.skillName) ?? stringValue(args.name) ?? stringValue(args.skill))
  },
  campaign_asset: {
    groupKey: "campaign:assets",
    groupPast: "saved assets",
    groupActive: "saving assets",
    groupMutations: true,
    groupNoun: "asset",
    groupMaxItems: 8,
    detail: "summary",
    showOutcome: false,
    groupItem: (args) => compactTarget(stringValue(args.canonical))
  },
  command_poll: {
    groupKey: "background:poll",
    groupPast: "checked background work",
    groupActive: "checking background work",
    groupNoun: "check",
    groupMaxItems: 20,
    detail: "summary",
    showOutcome: false
  }
};

const BROWSER_TOOLS = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_find",
  "browser_click",
  "browser_fill_form",
  "browser_type",
  "browser_press_key",
  "browser_wait_for",
  "browser_tabs",
  "browser_network_requests",
  "browser_network_request"
]);

const WORKSPACE_TOOLS = new Set(["file_read", "file_list", "file_search", "file_write", "file_replace", "file_patch", "notebook_cell", "git_status", "git_diff", "code_diagnostics", "output_read", "script_write"]);
const RECON_TOOLS = new Set(["network_scan", "asset_subdomains", "dns_resolve", "service_probe", "tls_inspect", "url_discover", "web_crawl", "vulnerability_scan", "vulnerability_lookup", "web_directory", "kali_search", "callback_manage", "mobile_manage"]);
const RECON_BATCH_TOOLS = new Set(["network_scan", "asset_subdomains", "dns_resolve", "service_probe", "tls_inspect", "url_discover", "web_crawl", "vulnerability_scan", "vulnerability_lookup", "web_directory"]);
const HTTP_TOOLS = new Set(["http_request", "web_search", "web_fetch"]);

export function resolveToolLifecycle(input: ToolLifecycleInput): ToolLifecyclePolicy {
  const normalized = normalizeToolLifecycleInput(input.tool, input.args);
  const family = toolLifecycleFamily(normalized.tool);
  const base: ToolLifecyclePolicy = {
    tool: normalized.tool,
    args: normalized.args,
    family,
    noun: familyNoun(family),
    detail: "full",
    showOutcome: true,
    standalone: false
  };
  const policy = applyGroupingPolicy(base, input.metadata, input.definitionMutates);
  const ruleMutates = TOOL_RULES[normalized.tool]?.groupMutations === true;
  const standaloneInput: ToolLifecycleInput = TOOL_RULES[normalized.tool]
    ? { ...input, definitionMutates: ruleMutates }
    : input;
  return { ...policy, standalone: shouldRenderStandalone(policy, standaloneInput) };
}

export function normalizeToolLifecycleInput(toolName: string, rawArgs: unknown): { tool: string; args: Record<string, unknown> } {
  const tool = canonicalToolName(toolName) || "tool";
  const args = inputObject(rawArgs);
  if (!args || typeof args.operation !== "string") return { tool, args: args ?? {} };
  const delegate = toolDefinition(tool)?.facadeOperations?.[args.operation];
  if (!delegate) return { tool, args };
  const { operation: _operation, args: nested, ...flat } = args;
  const delegateArgs = nested && typeof nested === "object" && !Array.isArray(nested)
    ? { ...flat, ...(nested as Record<string, unknown>) }
    : flat;
  return { tool: delegate, args: delegateArgs };
}

export function backgroundIdentifier(args: Record<string, unknown>, metadata: Record<string, unknown>): string | undefined {
  return stringValue(metadata.processId) ?? stringValue(metadata.jobId) ?? stringValue(args.processId) ?? stringValue(args.jobId);
}

function applyGroupingPolicy(
  base: ToolLifecyclePolicy,
  metadata: Record<string, unknown>,
  definitionMutates: boolean | undefined
): ToolLifecyclePolicy {
  const rule = TOOL_RULES[base.tool];
  if (rule) {
    const groupItem = compactValue(rule.groupItem?.(base.args, metadata));
    return {
      ...base,
      groupKey: rule.groupKey,
      groupPast: rule.groupPast,
      groupActive: rule.groupActive,
      ...(rule.groupMutations !== undefined ? { groupMutations: rule.groupMutations } : {}),
      ...(rule.groupNoun ? { groupNoun: rule.groupNoun } : {}),
      ...(rule.groupMaxItems ? { groupMaxItems: rule.groupMaxItems } : {}),
      ...(groupItem ? { groupItem } : {}),
      detail: rule.detail ?? base.detail,
      showOutcome: rule.showOutcome ?? base.showOutcome
    };
  }
  if (base.tool === "command_run") return { ...base, groupKey: "command", groupPast: "ran", groupActive: "running" };
  if (base.tool === "command_poll") {
    const identifier = backgroundIdentifier(base.args, metadata);
    return identifier ? { ...base, groupKey: `background:${identifier}`, groupPast: "checked background work", groupActive: "checking background work" } : base;
  }
  if (base.family === "workspace") return { ...base, groupKey: "workspace", groupPast: "inspected", groupActive: "inspecting" };
  if (base.family === "browser" && base.tool !== "browser_context") {
    const context = stringValue(metadata.browserContextName) ?? stringValue(base.args.browser) ?? "default";
    const label = compactToolText(context);
    return { ...base, groupKey: `browser:${context}`, groupPast: `browsed · ${label}`, groupActive: `browsing · ${label}` };
  }
  if (base.tool === "http_request") {
    const origin = urlOrigin(stringValue(base.args.url));
    const label = origin ? compactToolUrl(origin) : undefined;
    return { ...base, groupKey: `http:${origin ?? "requests"}`, groupPast: label ? `probed · ${label}` : "probed endpoints", groupActive: label ? `probing · ${label}` : "probing endpoints" };
  }
  if (RECON_BATCH_TOOLS.has(base.tool)) {
    return {
      ...base,
      groupKey: "recon",
      groupPast: "recon",
      groupActive: "recon",
      groupNoun: "step",
      groupMaxItems: 12
    };
  }
  if (base.family === "proxy" && definitionMutates !== true) {
    const host = stringValue(metadata.host) ?? stringValue(base.args.host) ?? stringValue(base.args.filter) ?? "traffic";
    const label = compactToolText(host);
    return { ...base, groupKey: `proxy:${host}`, groupPast: `inspected proxy · ${label}`, groupActive: `inspecting proxy · ${label}` };
  }
  if (base.family === "knowledge" && definitionMutates !== true) return { ...base, groupKey: "knowledge", groupPast: "queried knowledge", groupActive: "querying knowledge" };
  if (base.family === "mcp" && definitionMutates !== true) {
    const server = stringValue(base.args.server) ?? "mcp";
    const label = compactToolText(server);
    return { ...base, groupKey: `mcp:${server}`, groupPast: `queried ${label}`, groupActive: `querying ${label}` };
  }
  if (base.family === "email" && base.tool !== "email_create") {
    const emailId = stringValue(base.args.emailId) ?? stringValue(metadata.emailId) ?? "email";
    return { ...base, groupKey: `email:${emailId}`, groupPast: "checked email", groupActive: "checking email" };
  }
  return base;
}

function shouldRenderStandalone(policy: ToolLifecyclePolicy, input: ToolLifecycleInput): boolean {
  if (input.status === "error" || input.result?.ok === false) return true;
  if (input.warning) return true;
  if (policy.groupKey === "recon") return false;
  if (input.status === "running_background" && !(policy.tool === "command_poll" && backgroundIdentifier(policy.args, input.metadata))) return true;
  if (input.result?.attachments?.length || input.result?.evidence?.length || input.result?.outputArtifactId) return true;
  if (policy.groupMutations === true) return false;
  if (policy.family === "recon" || policy.family === "campaign" || policy.family === "agent" || policy.family === "media" || policy.family === "email") return true;
  if (policy.tool === "browser_context" || policy.tool === "web_search" || policy.tool === "web_fetch") return true;
  if (policy.family === "browser") return false;
  return input.definitionMutates === true && policy.tool !== "command_run";
}

export function toolLifecycleFamily(tool: string): ToolLifecycleFamily {
  if (tool === "command_run" || tool === "command_input" || tool === "command_poll" || tool === "command_stop") return "command";
  if (WORKSPACE_TOOLS.has(tool)) return "workspace";
  if (tool === "browser_manage" || tool === "browser_context" || BROWSER_TOOLS.has(tool)) return "browser";
  if (HTTP_TOOLS.has(tool)) return "http";
  if (tool === "proxy_manage" || tool.startsWith("proxy_")) return "proxy";
  if (tool === "skill_load" || tool === "knowledge_manage" || tool.startsWith("knowledge_") || tool.startsWith("memory_") || tool.startsWith("notes_") || tool.startsWith("evidence_")) return "knowledge";
  if (tool === "campaign_manage" || tool === "finding_manage" || tool === "cvss_calculate" || tool.startsWith("campaign_") || tool.startsWith("report_")) return "campaign";
  if (tool === "agent_manage" || tool.startsWith("agent_")) return "agent";
  if (tool.startsWith("mcp_")) return "mcp";
  if (tool === "image_read") return "media";
  if (tool === "mail_manage" || tool.startsWith("email_")) return "email";
  if (RECON_TOOLS.has(tool) || tool.startsWith("android_") || tool.startsWith("callback_")) return "recon";
  return "generic";
}

function familyNoun(family: ToolLifecycleFamily): string {
  if (family === "command") return "command";
  if (family === "workspace") return "workspace item";
  if (family === "browser") return "browser action";
  if (family === "http") return "endpoint";
  if (family === "proxy") return "proxy action";
  if (family === "knowledge") return "knowledge source";
  if (family === "mcp") return "mcp call";
  return "operation";
}

function inputObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function urlOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return new URL(value).origin; } catch { return undefined; }
}

function compactValue(value: string | undefined): string | undefined {
  return value ? compactToolText(value) : undefined;
}

function compactTarget(value: string | undefined): string | undefined {
  return value ? compactToolTarget(value) : undefined;
}
