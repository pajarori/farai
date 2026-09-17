import type { ToolDefinition } from "../types";
import { getTool } from "../agent-tools/registry";
import { canonicalToolName } from "../tool-names";
import { truncateTerminal } from "./terminal-text";

export const TOOL_PAYLOAD_KEYS = new Set([
  "body",
  "content",
  "newString",
  "oldString",
  "patch",
  "prompt",
  "raw",
  "script"
]);

const SEMANTIC_KEYS = [
  "command",
  "cmd",
  "path",
  "file",
  "filename",
  "name",
  "url",
  "target",
  "host",
  "query",
  "term",
  "text",
  "title",
  "key",
  "processId",
  "id",
  "port"
];

const TOOL_NAMESPACES = [
  "callback", "campaign", "evidence", "exploit", "memory", "session",
  "report", "notes", "shell", "skill", "patch", "code", "todo",
  "tool", "port", "nmap", "http", "dir", "git", "mcp", "fs",
  "browser", "proxy", "web", "dns", "tls", "url", "vulnerability", "image", "notebook", "worktree", "agent", "email",
  "file", "command", "network", "service", "asset"
] as const;

const PAST_ACTIONS: Record<string, string> = {
  add: "added",
  apply: "applied",
  diff: "checked",
  edit: "edited",
  enum: "enumerated",
  exec: "ran",
  grep: "searched",
  list: "listed",
  listen: "started",
  poll: "polled",
  query: "queried",
  read: "read",
  request: "requested",
  save: "saved",
  scan: "scanned",
  search: "searched",
  start: "started",
  status: "checked",
  stop: "stopped",
  update: "updated",
  write: "wrote"
};

const ACTIVE_ACTIONS: Record<string, string> = {
  add: "adding",
  apply: "applying",
  diff: "checking",
  edit: "editing",
  enum: "enumerating",
  exec: "running",
  grep: "searching",
  list: "listing",
  listen: "starting",
  poll: "polling",
  query: "querying",
  read: "reading",
  request: "requesting",
  save: "saving",
  scan: "scanning",
  search: "searching",
  start: "starting",
  status: "checking",
  stop: "stopping",
  update: "updating",
  write: "writing"
};

const TOOL_ACTIONS: Record<string, readonly [past: string, active: string]> = {
  agent_manage: ["managed agents", "managing agents"],
  browser_manage: ["managed browser", "managing browser"],
  callback_manage: ["managed callbacks", "managing callbacks"],
  campaign_manage: ["managed campaign", "managing campaign"],
  finding_manage: ["managed finding", "managing finding"],
  knowledge_manage: ["managed knowledge", "managing knowledge"],
  mail_manage: ["managed mail", "managing mail"],
  mobile_manage: ["managed mobile", "managing mobile"],
  proxy_manage: ["managed proxy", "managing proxy"],
  task_manage: ["managed tasks", "managing tasks"],
  agent_task: ["delegated", "delegating"],
  agent_spawn: ["spawned agent", "spawning agent"],
  agent_list: ["listed agents", "listing agents"],
  agent_wait: ["waited for agents", "waiting for agents"],
  agent_message: ["messaged agent", "messaging agent"],
  agent_followup: ["continued agent", "continuing agent"],
  agent_interrupt: ["interrupted agent", "interrupting agent"],
  agent_close: ["closed agent", "closing agent"],
  skill_load: ["loaded skill", "loading skill"],
  callback_host_info: ["inspected host network", "inspecting host network"],
  callback_listen: ["started callback listener", "starting callback listener"],
  callback_oast: ["started oast session", "starting oast session"],
  callback_stop: ["stopped callback listener", "stopping callback listener"],
  session_manage: ["renamed session", "renaming session"],
  user_input: ["asked user", "asking user"],
  web_search: ["searched the web", "searching the web"],
  web_fetch: ["fetched page", "fetching page"],
  image_read: ["viewed image", "viewing image"],
  notebook_cell: ["edited notebook", "editing notebook"],
  mcp_resource: ["managed MCP resource", "managing MCP resource"],
  proxy_scope: ["updated proxy scope", "updating proxy scope"],
  proxy_policy: ["updated proxy policy", "updating proxy policy"],
  proxy_flows: ["listed proxy flows", "listing proxy flows"],
  proxy_flow_get: ["inspected proxy flow", "inspecting proxy flow"],
  proxy_sitemap: ["built proxy sitemap", "building proxy sitemap"],
  proxy_replay: ["replayed proxy flow", "replaying proxy flow"],
  proxy_intercept: ["managed interception", "managing interception"],
  proxy_clear: ["cleared proxy traffic", "clearing proxy traffic"],
  worktree_manage: ["managed worktree", "managing worktree"],
  command_poll: ["checked background work", "checking background work"],
  command_stop: ["stopped background work", "stopping background work"],
  browser_context: ["managed", "managing"],
  browser_navigate: ["opened", "opening"],
  browser_snapshot: ["captured", "capturing"],
  browser_find: ["searched", "searching"],
  browser_click: ["clicked", "clicking"],
  browser_fill_form: ["filled", "filling"],
  browser_type: ["typed", "typing"],
  browser_press_key: ["pressed", "pressing"],
  browser_wait_for: ["waited for", "waiting for"],
  browser_tabs: ["managed", "managing"],
  browser_network_requests: ["inspected", "inspecting"],
  browser_network_request: ["inspected", "inspecting"],
  email_list: ["listed emails", "listing emails"],
  email_create: ["created email", "creating email"],
  email_inbox: ["checked inbox", "checking inbox"],
  email_read: ["read email", "reading email"],
  email_wait: ["received email", "waiting for email"]
};

const TOOL_INPUT_KEYS: Record<string, readonly string[]> = {
  agent_task: ["title", "lane", "prompt"],
  agent_spawn: ["title", "lane", "prompt"],
  agent_list: [],
  agent_wait: ["sessionIds", "timeoutSeconds"],
  agent_message: ["sessionId", "message"],
  agent_followup: ["sessionId", "prompt"],
  agent_interrupt: ["sessionId", "reason"],
  agent_close: ["sessionId"],
  user_input: ["questions"],
  web_search: ["query"],
  web_fetch: ["url"],
  image_read: ["path"],
  notebook_cell: ["path", "operation", "index"],
  mcp_resource: ["operation", "server", "uri"],
  proxy_scope: ["allowedDomains"],
  proxy_policy: ["tls", "passThroughHosts"],
  proxy_flows: ["kind", "filter", "method"],
  proxy_flow_get: ["flowId"],
  proxy_sitemap: ["host"],
  proxy_replay: ["flowId", "method"],
  proxy_intercept: ["action", "flowId"],
  proxy_clear: ["confirm"],
  worktree_manage: ["operation", "name", "ref", "branch", "remove"],
  browser_context: ["action", "name", "browser"],
  browser_click: ["element", "target"],
  browser_type: ["element", "target", "text"],
  browser_find: ["text", "regex"],
  browser_press_key: ["key"],
  browser_wait_for: ["text", "textGone", "time"],
  browser_tabs: ["action", "index", "url"],
  browser_network_requests: ["filter", "filename"],
  browser_network_request: ["index", "part"],
  email_list: [],
  email_create: ["label"],
  email_inbox: ["emailId"],
  email_read: ["messageId"],
  email_wait: ["emailId", "from", "subject"],
  dns_resolve: ["names", "recordTypes"],
  service_probe: ["targets", "ports"],
  tls_inspect: ["targets", "ports"],
  url_discover: ["domains", "sources"],
  web_crawl: ["targets", "depth"],
  vulnerability_scan: ["targets", "severities", "tags", "templateIds"],
  vulnerability_lookup: ["ids", "query", "products", "vendors"]
};

export type ToolInputKind = "shell" | "edit" | "write" | "patch" | "json";

export function toolDefinition(toolName: unknown): ToolDefinition | undefined {
  const canonical = canonicalToolName(toolName);
  return canonical ? getTool(canonical) : undefined;
}

export function shortToolName(toolName: unknown): string {
  const canonical = canonicalToolName(toolName) || "tool";
  const namespace = TOOL_NAMESPACES.find((prefix) => canonical.startsWith(`${prefix}_`));
  return namespace ? canonical.slice(namespace.length + 1) : canonical;
}


export function toolActionKey(toolName: unknown): string {
  const suffix = shortToolName(toolName).split(/[._-]/).at(-1) ?? "tool";
  return suffix.toLowerCase();
}

export function toolActionLabel(toolName: unknown, active: boolean): string {
  const canonical = canonicalToolName(toolName);
  const exact = TOOL_ACTIONS[canonical];
  if (exact) return exact[active ? 1 : 0];
  const key = toolActionKey(toolName);
  const table = active ? ACTIVE_ACTIONS : PAST_ACTIONS;
  if (table[key]) return table[key];
  if (canonicalToolName(toolName).startsWith("mcp_")) return active ? "calling" : "called";
  if (typeof toolName === "string" && toolName.startsWith("hook.")) return active ? "running hook" : "ran hook";
  const definition = toolDefinition(toolName);
  if (definition?.mutates) return active ? "updating" : "updated";
  return active ? "calling" : "called";
}

export function toolTitle(toolName: unknown, args: unknown, status: string, max = 120): string {
  const active = isActiveToolStatus(status);
  const failed = status === "error";
  const canonical = canonicalToolName(toolName);
  const inputObject = presentationInput(canonical, args);
  const facadeTitle = inputObject ? facadeToolTitle(canonical, inputObject, active, failed) : undefined;
  if (facadeTitle) return truncateLine(facadeTitle, max);
  const browserTitle = inputObject ? browserToolTitle(canonical, inputObject, active) : undefined;
  if (browserTitle) return truncateLine(browserTitle, max);
  const nativeTitle = inputObject ? nativeToolTitle(canonical, inputObject, active, failed) : undefined;
  if (nativeTitle) return truncateLine(nativeTitle, max);
  if (canonical === "command_poll" || canonical === "command_stop") return truncateLine(toolActionLabel(canonical, active), max);
  if (status === "running_background") {
    const input = summarizeToolInput(toolName, args, max);
    return `started background ${input || shortToolName(toolName)}`;
  }
  const input = summarizeToolInput(toolName, args, max);
  return truncateLine(`${toolActionLabel(toolName, active)} ${input || shortToolName(toolName)}`, max);
}

export function summarizeToolInput(toolName: unknown, args: unknown, max = 80): string {
  const obj = presentationInput(canonicalToolName(toolName), args);
  if (!obj) return "";
  const primary = primaryToolInput(toolName, obj);
  if (!primary) return "";
  return truncateLine(formatInputValue(primary.key, primary.value), max);
}

export function primaryToolInput(toolName: unknown, input: Record<string, unknown>): { key: string; value: unknown } | undefined {
  const keys = orderedInputKeys(toolName, input);
  const nonPayload = keys.find((key) => !TOOL_PAYLOAD_KEYS.has(key) && hasDisplayValue(input[key]));
  if (nonPayload) return { key: nonPayload, value: input[nonPayload] };
  const payload = keys.find((key) => hasDisplayValue(input[key]));
  return payload ? { key: payload, value: input[payload] } : undefined;
}

export function toolInputObject(args: unknown): Record<string, unknown> | undefined {
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : undefined;
}

export function toolInputKind(_toolName: string, input: Record<string, unknown>): ToolInputKind {
  if (typeof input.command === "string" || typeof input.cmd === "string") return "shell";
  if (typeof input.oldString === "string" && typeof input.newString === "string") return "edit";
  if (typeof input.patch === "string") return "patch";
  if (typeof input.content === "string") return "write";
  return "json";
}

export function isWorkspaceExplorationTool(toolName: unknown): boolean {
  const definition = toolDefinition(toolName);
  if (!definition || definition.mutates) return false;
  const action = toolActionKey(toolName);
  if (action !== "read" && action !== "list" && action !== "grep" && action !== "search") return false;
  const props = schemaPropertyNames(definition);
  return props.has("path") || props.has("pattern") || props.has("include");
}

export function explorationVerb(toolName: unknown): "read" | "list" | "search" {
  const action = toolActionKey(toolName);
  if (action === "list") return "list";
  if (action === "grep" || action === "search") return "search";
  return "read";
}

export function isActiveToolStatus(status: string): boolean {
  return status === "running" || status === "pending";
}

function orderedInputKeys(toolName: unknown, input: Record<string, unknown>): string[] {
  const definition = toolDefinition(toolName);
  const required = schemaRequired(definition);
  const properties = schemaPropertyNames(definition);
  const schemaKeys = Array.from(properties);
  const semantic = SEMANTIC_KEYS.filter((key) => properties.has(key) || key in input);
  const preferred = TOOL_INPUT_KEYS[canonicalToolName(toolName)] ?? [];
  return unique([...preferred, ...required, ...semantic, ...schemaKeys, ...Object.keys(input)]);
}

function presentationInput(tool: string, args: unknown): Record<string, unknown> | undefined {
  const input = toolInputObject(args);
  if (!input) return undefined;
  const facade = new Set(["agent_manage", "browser_manage", "callback_manage", "campaign_manage", "finding_manage", "knowledge_manage", "mail_manage", "mobile_manage", "proxy_manage", "task_manage", "worktree_manage"]);
  if (!facade.has(tool) || !input.args || typeof input.args !== "object" || Array.isArray(input.args)) return input;
  return { ...(input.args as Record<string, unknown>), operation: input.operation };
}

function facadeToolTitle(tool: string, input: Record<string, unknown>, active: boolean, failed: boolean): string | undefined {
  if (!new Set(["agent_manage", "browser_manage", "callback_manage", "campaign_manage", "finding_manage", "knowledge_manage", "mail_manage", "mobile_manage", "proxy_manage", "task_manage", "worktree_manage"]).has(tool)) return undefined;
  const operation = typeof input.operation === "string" ? input.operation : "manage";
  const verbs: Record<string, readonly [string, string]> = {
    spawn: ["spawned agent", "spawning agent"],
    list: ["listed", "listing"],
    wait: ["waited for", "waiting for"],
    message: ["messaged", "messaging"],
    followup: ["continued", "continuing"],
    interrupt: ["interrupted", "interrupting"],
    close: ["closed", "closing"],
    add: ["added", "adding"],
    update: ["updated", "updating"],
    plan: ["updated", "updating"],
    enter: ["entered", "entering"],
    exit: ["left", "leaving"],
    scope: ["checked proxy scope", "checking proxy scope"],
    policy: ["checked proxy policy", "checking proxy policy"],
    flows: ["listed proxy flows", "listing proxy flows"],
    flow_get: ["read proxy flow", "reading proxy flow"],
    sitemap: ["listed proxy sitemap", "listing proxy sitemap"],
    replay: ["replayed proxy request", "replaying proxy request"],
    intercept: ["intercepted request", "intercepting request"],
    clear: ["cleared proxy traffic", "clearing proxy traffic"],
    asset: ["saved", "saving"],
    create: ["created email", "creating email"],
    inbox: ["checked inbox", "checking inbox"],
    read: ["read email", "reading email"]
  };
  const pair = verbs[operation];
  if (!pair) return undefined;
  const noun = tool === "task_manage" ? "task" : tool === "worktree_manage" ? "worktree" : tool === "agent_manage" ? "agent" : tool === "proxy_manage" ? "" : tool === "mail_manage" ? "" : operation;
  const verb = failed ? `failed to ${pair[1]}` : active ? pair[1] : pair[0];
  const subject = typeof input.title === "string" ? ` ${input.title}` : typeof input.name === "string" ? ` ${input.name}` : "";
  return `${verb}${noun ? ` ${noun}` : ""}${subject}`;
}

function schemaRequired(definition: ToolDefinition | undefined): string[] {
  const required = definition?.inputSchema.required;
  return Array.isArray(required) ? required.filter((value): value is string => typeof value === "string") : [];
}

function schemaPropertyNames(definition: ToolDefinition | undefined): Set<string> {
  const properties = definition?.inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return new Set();
  return new Set(Object.keys(properties));
}

function hasDisplayValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function formatInputValue(key: string, value: unknown): string {
  if (typeof value === "string") {
    if (!TOOL_PAYLOAD_KEYS.has(key)) return value.replace(/\s+/g, " ");
    const lines = value.split("\n").length;
    return `${key} ${lines} line${lines === 1 ? "" : "s"}`;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "no items";
    if (value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
      return value.slice(0, 3).map(String).join(", ") + (value.length > 3 ? ` · +${value.length - 3}` : "");
    }
    return `${value.length} items`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const scalar = entries.flatMap(([name, item]) => {
      return item === null || ["string", "number", "boolean"].includes(typeof item) ? [`${name}=${String(item)}`] : [];
    });
    if (scalar.length > 0) return scalar.slice(0, 3).join(" · ") + (scalar.length > 3 ? ` · +${scalar.length - 3}` : "");
    return `${entries.length} fields`;
  }
  return String(value);
}

function truncateLine(line: string, maxWidth: number): string {
  return truncateTerminal(line, Math.max(maxWidth, 1));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function browserToolTitle(tool: string, input: Record<string, unknown>, active: boolean): string | undefined {
  const action = toolActionLabel(tool, active);
  if (tool === "browser_context") {
    const contextAction = typeof input.action === "string" ? input.action : "list";
    const selector = typeof input.name === "string" ? input.name : typeof input.browser === "string" ? input.browser : "";
    if (contextAction === "create") return `${active ? "creating" : "created"} browser${selector ? ` ${selector}` : ""}`;
    if (contextAction === "close") return `${active ? "closing" : "closed"} browser${selector ? ` ${selector}` : ""}`;
    return active ? "listing browsers" : "listed browsers";
  }
  if (tool === "browser_fill_form") {
    const fields = Array.isArray(input.fields) ? input.fields : [];
    const names = fields.flatMap((field) => field && typeof field === "object" && !Array.isArray(field) && typeof (field as Record<string, unknown>).name === "string"
      ? [(field as Record<string, unknown>).name as string]
      : []);
    const target = names.length === 1 ? names[0]! : `${fields.length} fields`;
    return `${action} ${target}`;
  }
  if (tool === "browser_wait_for") {
    if (typeof input.textGone === "string" && input.textGone.trim()) return `${action} ${input.textGone.trim()} to disappear`;
    if (typeof input.text === "string" && input.text.trim()) return `${action} ${input.text.trim()}`;
    if (typeof input.time === "number") return `${active ? "waiting" : "waited"} ${formatSeconds(input.time)}`;
    return active ? "waiting" : "waited";
  }
  if (tool === "browser_tabs") {
    const tabAction = typeof input.action === "string" ? input.action : "list";
    const index = typeof input.index === "number" ? ` ${input.index}` : "";
    const url = typeof input.url === "string" && input.url.trim() ? ` ${input.url.trim()}` : "";
    if (tabAction === "new") return `${active ? "opening" : "opened"} new tab${url}`;
    if (tabAction === "close") return `${active ? "closing" : "closed"} tab${index}`;
    if (tabAction === "select") return `${active ? "selecting" : "selected"} tab${index}`;
    return active ? "listing tabs" : "listed tabs";
  }
  if (tool === "browser_network_requests") {
    const filter = typeof input.filter === "string" && input.filter.trim() ? ` for ${input.filter.trim()}` : "";
    return `${action} network requests${filter}`;
  }
  if (tool === "browser_network_request") {
    const index = typeof input.index === "number" ? input.index : "?";
    const part = typeof input.part === "string" && input.part ? `${input.part.replaceAll("-", " ")} for ` : "";
    return `${action} ${part}request ${index}`;
  }
  return undefined;
}

function nativeToolTitle(tool: string, input: Record<string, unknown>, active: boolean, failed = false): string | undefined {
  if (tool === "dns_resolve") return reconTitle(failed, active, "resolve dns", "resolving dns", "resolved dns", input.names);
  if (tool === "service_probe") return reconTitle(failed, active, "probe http services", "probing http services", "probed http services", input.targets);
  if (tool === "tls_inspect") return reconTitle(failed, active, "inspect tls", "inspecting tls", "inspected tls", input.targets);
  if (tool === "url_discover") return reconTitle(failed, active, "discover urls", "discovering urls", "discovered urls", input.domains);
  if (tool === "web_crawl") return reconTitle(failed, active, "crawl", "crawling", "crawled", input.targets);
  if (tool === "vulnerability_scan") return reconTitle(failed, active, "scan vulnerabilities", "scanning vulnerabilities", "scanned vulnerabilities", input.targets);
  if (tool === "vulnerability_lookup") return reconTitle(failed, active, "look up vulnerabilities", "looking up vulnerabilities", "looked up vulnerabilities", input.ids ?? input.query);
  if (tool === "email_list") return failed ? "failed to list emails" : active ? "listing emails" : "listed emails";
  if (tool === "email_create") {
    const label = typeof input.label === "string" && input.label.trim() ? ` ${input.label.trim()}` : "";
    return `${failed ? "failed to create" : active ? "creating" : "created"} email${label}`;
  }
  if (tool === "email_inbox") return `${failed ? "failed to check" : active ? "checking" : "checked"} inbox ${typeof input.emailId === "string" ? input.emailId : ""}`.trim();
  if (tool === "email_read") return `${failed ? "failed to read" : active ? "reading" : "read"} email ${typeof input.messageId === "string" ? input.messageId : ""}`.trim();
  if (tool === "email_wait") return `${failed ? "failed waiting for" : active ? "waiting for" : "received"} email${typeof input.subject === "string" && input.subject.trim() ? ` · ${input.subject.trim()}` : ""}`;
  if (tool === "callback_host_info") return active ? "inspecting host network" : "inspected host network";
  if (tool === "callback_oast") return active ? "starting oast session" : "started oast session";
  if (tool === "notebook_cell") {
    const operation = typeof input.operation === "string" ? input.operation : "edit";
    const path = typeof input.path === "string" ? ` in ${input.path}` : "";
    const index = typeof input.index === "number" ? ` ${input.index}` : "";
    const verbs: Record<string, readonly [string, string]> = {
      insert_cell: ["inserted notebook cell", "inserting notebook cell"],
      replace_cell: ["replaced notebook cell", "replacing notebook cell"],
      delete_cell: ["deleted notebook cell", "deleting notebook cell"]
    };
    const verb = verbs[operation]?.[active ? 1 : 0] ?? (active ? "editing notebook" : "edited notebook");
    return `${verb}${index}${path}`;
  }
  if (tool === "mcp_resource") {
    const server = typeof input.server === "string" && input.server.trim() ? ` from ${input.server.trim()}` : "";
    if (input.operation === "read") {
      const uri = typeof input.uri === "string" ? input.uri.trim() : "";
      return `${active ? "reading" : "read"} MCP resource${uri ? ` ${uri}` : ""}${server}`;
    }
    return `${active ? "listing" : "listed"} MCP resources${server}`;
  }
  if (tool === "proxy_scope") {
    return Array.isArray(input.allowedDomains)
      ? active ? "updating proxy scope" : "updated proxy scope"
      : active ? "checking proxy scope" : "checked proxy scope";
  }
  if (tool === "proxy_policy") {
    return input.tls !== undefined || input.passThroughHosts !== undefined
      ? active ? "updating proxy policy" : "updated proxy policy"
      : active ? "checking proxy policy" : "checked proxy policy";
  }
  if (tool === "proxy_intercept") {
    const action = typeof input.action === "string" ? input.action : "status";
    const flow = typeof input.flowId === "string" && input.flowId.trim() ? ` ${input.flowId.trim()}` : "";
    const labels: Record<string, readonly [string, string]> = {
      status: ["checked interception", "checking interception"],
      configure: ["configured interception", "configuring interception"],
      list: ["listed intercepted requests", "listing intercepted requests"],
      forward: [`forwarded intercepted request${flow}`, `forwarding intercepted request${flow}`],
      edit: [`edited intercepted request${flow}`, `editing intercepted request${flow}`],
      drop: [`dropped intercepted request${flow}`, `dropping intercepted request${flow}`]
    };
    return labels[action]?.[active ? 1 : 0];
  }
  if (tool === "proxy_clear") return active ? "clearing proxy traffic" : "cleared proxy traffic";
  if (tool === "worktree_manage") {
    const name = typeof input.name === "string" && input.name.trim() ? ` ${input.name.trim()}` : "";
    return input.operation === "exit" ? (active ? "leaving worktree" : "left worktree") : `${active ? "entering" : "entered"} worktree${name}`;
  }
  if (tool === "agent_list") return active ? "listing agents" : "listed agents";
  return undefined;
}

function reconTitle(failed: boolean, active: boolean, infinitive: string, present: string, past: string, value: unknown): string {
  const target = inputCollectionLabel(value);
  return `${failed ? `failed to ${infinitive}` : active ? present : past}${target ? ` · ${target}` : ""}`;
}

function inputCollectionLabel(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value) || !value.length) return "";
  const first = String(value[0] ?? "").trim();
  return `${first}${value.length > 1 ? ` · +${value.length - 1}` : ""}`;
}

function formatSeconds(value: number): string {
  return `${value}s`;
}
