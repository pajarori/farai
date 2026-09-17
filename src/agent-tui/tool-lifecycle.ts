import type { ToolResult } from "../types";
import { canonicalToolName } from "../tool-names";

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

const FACADE_OPERATIONS: Record<string, Record<string, string>> = {
  mail_manage: { list: "email_list", create: "email_create", inbox: "email_inbox", read: "email_read", wait: "email_wait" },
  browser_manage: { context: "browser_context", navigate: "browser_navigate", snapshot: "browser_snapshot", click: "browser_click", fill_form: "browser_fill_form", wait_for: "browser_wait_for", tabs: "browser_tabs", network_requests: "browser_network_requests", network_request: "browser_network_request" },
  proxy_manage: { scope: "proxy_scope", policy: "proxy_policy", flows: "proxy_flows", flow_get: "proxy_flow_get", sitemap: "proxy_sitemap", replay: "proxy_replay", intercept: "proxy_intercept", clear: "proxy_clear" },
  knowledge_manage: { skill_load: "skill_load" },
  campaign_manage: { asset: "campaign_asset" }
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
    groupItem: (args, metadata) => stringValue(metadata.skillName) ?? stringValue(args.name) ?? stringValue(args.skill)
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
    groupItem: (args) => stringValue(args.canonical)
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
  if (!args || typeof args.operation !== "string" || !args.args || typeof args.args !== "object" || Array.isArray(args.args)) return { tool, args: args ?? {} };
  return { tool: FACADE_OPERATIONS[tool]?.[args.operation] ?? tool, args: args.args as Record<string, unknown> };
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
    const groupItem = rule.groupItem?.(base.args, metadata);
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
    return { ...base, groupKey: `browser:${context}`, groupPast: `browsed · ${context}`, groupActive: `browsing · ${context}` };
  }
  if (base.tool === "http_request") {
    const origin = urlOrigin(stringValue(base.args.url));
    return { ...base, groupKey: `http:${origin ?? "requests"}`, groupPast: origin ? `probed · ${origin}` : "probed endpoints", groupActive: origin ? `probing · ${origin}` : "probing endpoints" };
  }
  if (base.family === "proxy" && definitionMutates !== true) {
    const host = stringValue(metadata.host) ?? stringValue(base.args.host) ?? stringValue(base.args.filter) ?? "traffic";
    return { ...base, groupKey: `proxy:${host}`, groupPast: `inspected proxy · ${host}`, groupActive: `inspecting proxy · ${host}` };
  }
  if (base.family === "knowledge" && definitionMutates !== true) return { ...base, groupKey: "knowledge", groupPast: "queried knowledge", groupActive: "querying knowledge" };
  if (base.family === "mcp" && definitionMutates !== true) {
    const server = stringValue(base.args.server) ?? "mcp";
    return { ...base, groupKey: `mcp:${server}`, groupPast: `queried ${server}`, groupActive: `querying ${server}` };
  }
  if (base.family === "email" && base.tool !== "email_create") {
    const emailId = stringValue(base.args.emailId) ?? stringValue(metadata.emailId) ?? "email";
    return { ...base, groupKey: `email:${emailId}`, groupPast: "checked email", groupActive: "checking email" };
  }
  return base;
}

function shouldRenderStandalone(policy: ToolLifecyclePolicy, input: ToolLifecycleInput): boolean {
  if (input.status === "error" || input.result?.ok === false) return true;
  if (input.status === "running_background" && !(policy.tool === "command_poll" && backgroundIdentifier(policy.args, input.metadata))) return true;
  if (input.result?.attachments?.length || input.result?.evidence?.length || input.result?.outputArtifactId) return true;
  if (input.warning) return true;
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
  if (tool === "campaign_manage" || tool === "finding_manage" || tool.startsWith("campaign_") || tool.startsWith("report_")) return "campaign";
  if (tool === "agent_manage" || tool.startsWith("agent_")) return "agent";
  if (tool.startsWith("mcp_")) return "mcp";
  if (tool === "image_read") return "media";
  if (tool === "mail_manage" || tool.startsWith("email_")) return "email";
  if (RECON_TOOLS.has(tool)) return "recon";
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
