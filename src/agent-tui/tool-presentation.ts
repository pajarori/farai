import type { ToolDefinition, ToolLifecycleState, ToolResult } from "../types";
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

export const TOOL_TITLE_MAX_WIDTH = 88;
const TOOL_SUBJECT_MAX_WIDTH = 44;

const FACADE_TOOLS = new Set([
  "agent_manage", "browser_manage", "callback_manage", "campaign_manage", "finding_manage", "knowledge_manage",
  "mail_manage", "mobile_manage", "proxy_manage", "session_manage", "task_manage", "worktree_manage"
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

const TOOL_ACTIONS: Record<string, readonly [past: string, active: string, infinitive?: string]> = {
  command_run: ["ran", "running", "run command"],
  command_input: ["sent input", "sending input", "send input"],
  agent_manage: ["managed agents", "managing agents", "manage agents"],
  browser_manage: ["managed browser", "managing browser", "manage browser"],
  callback_manage: ["managed callbacks", "managing callbacks", "manage callbacks"],
  campaign_manage: ["managed campaign", "managing campaign", "manage campaign"],
  finding_manage: ["managed finding", "managing finding", "manage finding"],
  knowledge_manage: ["managed knowledge", "managing knowledge", "manage knowledge"],
  mail_manage: ["managed mail", "managing mail", "manage mail"],
  mobile_manage: ["managed mobile", "managing mobile", "manage mobile"],
  proxy_manage: ["managed proxy", "managing proxy", "manage proxy"],
  task_manage: ["managed tasks", "managing tasks", "manage tasks"],
  agent_task: ["delegated", "delegating", "delegate task"],
  agent_spawn: ["spawned agent", "spawning agent", "spawn agent"],
  agent_list: ["listed agents", "listing agents", "list agents"],
  agent_wait: ["waited for agents", "waiting for agents", "wait for agents"],
  agent_message: ["messaged agent", "messaging agent", "message agent"],
  agent_followup: ["continued agent", "continuing agent", "continue agent"],
  agent_interrupt: ["interrupted agent", "interrupting agent", "interrupt agent"],
  agent_close: ["closed agent", "closing agent", "close agent"],
  agent_report: ["reported to parent", "reporting to parent", "report to parent"],
  skill_load: ["loaded skill", "loading skill", "load skill"],
  notes_add: ["added note", "adding note", "add note"],
  evidence_save: ["saved evidence", "saving evidence", "save evidence"],
  memory_add_hypothesis: ["added hypothesis", "adding hypothesis", "add hypothesis"],
  memory_mark_failed: ["marked attempt failed", "marking attempt failed", "mark attempt failed"],
  knowledge_search: ["searched knowledge", "searching knowledge", "search knowledge"],
  knowledge_read: ["read knowledge", "reading knowledge", "read knowledge"],
  knowledge_resolve: ["resolved knowledge", "resolving knowledge", "resolve knowledge"],
  knowledge_neighbors: ["explored related knowledge", "exploring related knowledge", "explore related knowledge"],
  knowledge_prioritize: ["prioritized knowledge", "prioritizing knowledge", "prioritize knowledge"],
  task_add_internal: ["added task", "adding task", "add task"],
  task_update_internal: ["updated task", "updating task", "update task"],
  task_list_internal: ["listed tasks", "listing tasks", "list tasks"],
  task_plan_internal: ["updated plan", "updating plan", "update plan"],
  cvss_calculate: ["calculated cvss", "calculating cvss", "calculate cvss"],
  report_add_finding: ["added finding", "adding finding", "add finding"],
  report_update_finding: ["updated finding", "updating finding", "update finding"],
  callback_host_info: ["inspected host network", "inspecting host network", "inspect host network"],
  callback_listen: ["started callback listener", "starting callback listener", "start callback listener"],
  callback_oast: ["started oast session", "starting oast session", "start oast session"],
  callback_stop: ["stopped callback listener", "stopping callback listener", "stop callback listener"],
  campaign_create: ["created campaign", "creating campaign", "create campaign"],
  campaign_asset: ["saved asset", "saving asset", "save asset"],
  campaign_observe: ["recorded observation", "recording observation", "record observation"],
  campaign_hypothesis: ["updated hypothesis", "updating hypothesis", "update hypothesis"],
  campaign_search: ["searched campaign", "searching campaign", "search campaign"],
  campaign_verify: ["verified campaign", "verifying campaign", "verify campaign"],
  campaign_next_action: ["selected next action", "selecting next action", "select next action"],
  campaign_dispatch: ["dispatched campaign work", "dispatching campaign work", "dispatch campaign work"],
  campaign_test: ["recorded test attempt", "recording test attempt", "record test attempt"],
  campaign_requirement: ["updated requirement", "updating requirement", "update requirement"],
  campaign_checkpoint: ["recorded checkpoint", "recording checkpoint", "record checkpoint"],
  session_rename_internal: ["renamed session", "renaming session", "rename session"],
  user_input: ["asked user", "asking user", "ask user"],
  web_search: ["searched the web", "searching the web", "search the web"],
  web_fetch: ["fetched page", "fetching page", "fetch page"],
  image_read: ["viewed image", "viewing image", "view image"],
  notebook_cell: ["edited notebook", "editing notebook", "edit notebook"],
  mcp_resource: ["managed mcp resource", "managing mcp resource", "manage mcp resource"],
  proxy_scope: ["updated proxy scope", "updating proxy scope", "update proxy scope"],
  proxy_policy: ["updated proxy policy", "updating proxy policy", "update proxy policy"],
  proxy_flows: ["listed proxy flows", "listing proxy flows", "list proxy flows"],
  proxy_flow_get: ["inspected proxy flow", "inspecting proxy flow", "inspect proxy flow"],
  proxy_sitemap: ["built proxy sitemap", "building proxy sitemap", "build proxy sitemap"],
  proxy_replay: ["replayed proxy flow", "replaying proxy flow", "replay proxy flow"],
  proxy_intercept: ["managed interception", "managing interception", "manage interception"],
  proxy_clear: ["cleared proxy traffic", "clearing proxy traffic", "clear proxy traffic"],
  worktree_enter_internal: ["entered worktree", "entering worktree", "enter worktree"],
  worktree_exit_internal: ["left worktree", "leaving worktree", "leave worktree"],
  command_poll: ["checked background work", "checking background work", "check background work"],
  command_stop: ["stopped background work", "stopping background work", "stop background work"],
  browser_context: ["managed browser", "managing browser", "manage browser"],
  browser_navigate: ["opened", "opening", "open page"],
  browser_snapshot: ["captured snapshot", "capturing snapshot", "capture snapshot"],
  browser_find: ["searched page", "searching page", "search page"],
  browser_click: ["clicked", "clicking", "click element"],
  browser_fill_form: ["filled", "filling", "fill form"],
  browser_type: ["typed", "typing", "type text"],
  browser_press_key: ["pressed key", "pressing key", "press key"],
  browser_wait_for: ["waited for", "waiting for", "wait for"],
  browser_tabs: ["managed tabs", "managing tabs", "manage tabs"],
  browser_network_requests: ["inspected", "inspecting", "inspect network requests"],
  browser_network_request: ["inspected", "inspecting", "inspect network request"],
  browser_eval: ["evaluated browser script", "evaluating browser script", "evaluate browser script"],
  email_list: ["listed emails", "listing emails", "list emails"],
  email_create: ["created email", "creating email", "create email"],
  email_inbox: ["checked inbox", "checking inbox", "check inbox"],
  email_read: ["read email", "reading email", "read email"],
  email_wait: ["received email", "waiting for email", "wait for email"],
  android_connect: ["connected android device", "connecting android device", "connect android device"],
  android_devices: ["listed android devices", "listing android devices", "list android devices"],
  android_shell: ["ran android shell", "running android shell", "run android shell"],
  android_packages: ["listed android packages", "listing android packages", "list android packages"],
  android_device_info: ["inspected android device", "inspecting android device", "inspect android device"],
  android_logcat: ["read android logs", "reading android logs", "read android logs"],
  android_apk_pull: ["pulled apk", "pulling apk", "pull apk"],
  android_install: ["installed app", "installing app", "install app"],
  android_app_start: ["started app", "starting app", "start app"],
  android_app_stop: ["stopped app", "stopping app", "stop app"],
  android_deeplink: ["opened deep link", "opening deep link", "open deep link"],
  android_pull_file: ["pulled device file", "pulling device file", "pull device file"],
  android_decompile: ["decompiled apk", "decompiling apk", "decompile apk"],
  android_manifest: ["inspected manifest", "inspecting manifest", "inspect manifest"],
  android_permissions: ["inspected permissions", "inspecting permissions", "inspect permissions"],
  android_exported_components: ["inspected exported components", "inspecting exported components", "inspect exported components"],
  android_scan_secrets: ["scanned apk secrets", "scanning apk secrets", "scan apk secrets"],
  android_grep_apk: ["searched apk", "searching apk", "search apk"],
  android_ui_dump: ["captured ui dump", "capturing ui dump", "capture ui dump"],
  android_ui_hierarchy: ["inspected ui hierarchy", "inspecting ui hierarchy", "inspect ui hierarchy"],
  android_screenshot: ["captured screenshot", "capturing screenshot", "capture screenshot"],
  android_ui_tap: ["tapped screen", "tapping screen", "tap screen"],
  android_ui_tap_element: ["tapped ui element", "tapping ui element", "tap ui element"],
  android_ui_type: ["typed on device", "typing on device", "type on device"],
  android_ui_swipe: ["swiped screen", "swiping screen", "swipe screen"],
  android_ui_key: ["sent device key", "sending device key", "send device key"],
  android_ui_window_size: ["inspected screen size", "inspecting screen size", "inspect screen size"],
  android_ui_wait_for: ["waited for ui element", "waiting for ui element", "wait for ui element"],
  android_frida_install: ["installed frida", "installing frida", "install frida"],
  android_frida_status: ["checked frida status", "checking frida status", "check frida status"],
  android_frida_setup: ["set up frida", "setting up frida", "set up frida"],
  android_frida_ps: ["listed frida processes", "listing frida processes", "list frida processes"],
  android_frida_run: ["ran frida script", "running frida script", "run frida script"],
  android_frida_bypass: ["ran frida bypass", "running frida bypass", "run frida bypass"]
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

function toolFailureLabel(toolName: unknown): string {
  const canonical = canonicalToolName(toolName);
  const exact = TOOL_ACTIONS[canonical];
  if (exact?.[2]) return `failed to ${exact[2]}`;
  return `failed to run ${shortToolName(toolName).replaceAll("_", " ")}`;
}

export function toolTitle(toolName: unknown, args: unknown, status: string, max = TOOL_TITLE_MAX_WIDTH): string {
  const active = isActiveToolStatus(status);
  const failed = status === "error";
  const canonical = canonicalToolName(toolName);
  const inputObject = presentationInput(canonical, args);
  const facadeTitle = inputObject ? facadeToolTitle(canonical, inputObject, active, failed) : undefined;
  if (facadeTitle) return truncateLine(facadeTitle, max);
  const browserTitle = inputObject ? browserToolTitle(canonical, inputObject, active, failed) : undefined;
  if (browserTitle) return truncateLine(browserTitle, max);
  const nativeTitle = inputObject ? nativeToolTitle(canonical, inputObject, active, failed) : undefined;
  if (nativeTitle) return truncateLine(nativeTitle, max);
  if (canonical === "command_poll" || canonical === "command_stop") return truncateLine(toolActionLabel(canonical, active), max);
  if (status === "running_background") {
    const input = summarizeToolInput(toolName, args, max);
    return truncateLine(`started background${input ? ` ${input}` : ""}`, max);
  }
  const input = summarizeToolInput(toolName, args, max);
  const action = failed ? toolFailureLabel(toolName) : toolActionLabel(toolName, active);
  const fallback = TOOL_ACTIONS[canonical] ? "" : shortToolName(toolName).replaceAll("_", " ");
  return truncateLine(`${action}${input || fallback ? ` ${input || fallback}` : ""}`, max);
}

export function summarizeToolInput(toolName: unknown, args: unknown, max = 80): string {
  const obj = presentationInput(canonicalToolName(toolName), args);
  if (!obj) return "";
  const primary = primaryToolInput(toolName, obj);
  if (!primary) return "";
  return truncateLine(formatToolInputValue(primary.key, primary.value), max);
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
  const state = canonicalToolLifecycleState(status);
  return state === "pending" || state === "running" || state === "background";
}

export function canonicalToolLifecycleState(status: string, result?: ToolResult): ToolLifecycleState {
  if (result?.errorCategory === "cancelled" || result?.metadata?.cancelled === true) return "cancelled";
  if (status === "pending") return "pending";
  if (status === "running") return "running";
  if (status === "running_background" || result?.status === "running_background") return "background";
  if (status === "done" && result?.ok !== false) return "succeeded";
  return "failed";
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
  if (!FACADE_TOOLS.has(tool)) return input;
  const { operation, args: nested, ...flat } = input;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return input;
  return { ...flat, ...(nested as Record<string, unknown>), operation };
}

function facadeToolTitle(tool: string, input: Record<string, unknown>, active: boolean, failed: boolean): string | undefined {
  if (!FACADE_TOOLS.has(tool)) return undefined;
  const operation = typeof input.operation === "string" ? input.operation : "manage";
  const verbs: Record<string, readonly [string, string]> = {
    spawn: ["spawned agent", "spawning agent"],
    list: ["listed", "listing"],
    wait: ["waited for", "waiting for"],
    message: ["messaged", "messaging"],
    followup: ["continued", "continuing"],
    interrupt: ["interrupted", "interrupting"],
    close: ["closed", "closing"],
    rename: ["renamed", "renaming"],
    add: ["added", "adding"],
    save: ["saved", "saving"],
    search: ["searched", "searching"],
    resolve: ["resolved", "resolving"],
    prioritize: ["prioritized", "prioritizing"],
    calculate: ["calculated", "calculating"],
    add_finding: ["added", "adding"],
    update_finding: ["updated", "updating"],
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
    create: ["created", "creating"],
    inbox: ["checked", "checking"],
    read: ["read", "reading"]
  };
  const pair = verbs[operation];
  if (!pair) {
    const noun = facadeNoun(tool, operation);
    const detail = operation === "manage" ? "" : ` · ${compactToolText(operation.replaceAll("_", " "))}`;
    const verb = failed ? "failed to manage" : active ? "managing" : "managed";
    return `${verb}${noun ? ` ${noun}` : ""}${detail}`;
  }
  const noun = facadeNoun(tool, operation);
  const verb = failed ? `failed to ${pair[1]}` : active ? pair[1] : pair[0];
  const subjectValue = typeof input.title === "string" ? input.title : typeof input.name === "string" ? input.name : "";
  const subject = subjectValue ? ` · ${compactToolText(subjectValue)}` : "";
  return `${verb}${noun ? ` ${noun}` : ""}${subject}`;
}

function facadeNoun(tool: string, operation: string): string {
  if (tool === "task_manage") return "task";
  if (tool === "worktree_manage") return "worktree";
  if (tool === "agent_manage") return "agent";
  if (tool === "session_manage") return "session";
  if (tool === "campaign_manage" && operation === "create") return "campaign";
  if (tool === "campaign_manage" && operation === "asset") return "asset";
  if (tool === "campaign_manage") return "campaign";
  if (tool === "knowledge_manage") return "knowledge";
  if (tool === "finding_manage" && operation === "calculate") return "cvss";
  if (tool === "finding_manage") return "finding";
  if (tool === "callback_manage") return "callbacks";
  if (tool === "mobile_manage") return "mobile";
  if (tool === "browser_manage") return "browser";
  if (tool === "mail_manage" && operation === "list") return "emails";
  if (tool === "mail_manage" && operation === "inbox") return "inbox";
  if (tool === "mail_manage") return "email";
  if (tool === "proxy_manage") return operation === "manage" ? "proxy" : "";
  return operation.replaceAll("_", " ");
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

export function formatToolInputValue(key: string, value: unknown): string {
  if (typeof value === "string") {
    if (!TOOL_PAYLOAD_KEYS.has(key)) return formatStringValue(key, value);
    const lines = value.split("\n").length;
    return `${key} ${lines} line${lines === 1 ? "" : "s"}`;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "no items";
    if (value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
      return collectionLabel(key, value);
    }
    return `${value.length} items`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `${entries.length} fields`;
  }
  return String(value);
}

export function compactToolText(value: string, max = TOOL_SUBJECT_MAX_WIDTH): string {
  return truncateLine(value.replace(/\s+/g, " ").trim(), max);
}

export function compactToolUrl(value: string, max = TOOL_SUBJECT_MAX_WIDTH): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  try {
    const url = new URL(normalized);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    const protocol = url.protocol === "http:" || url.protocol === "https:" ? "" : `${url.protocol}//`;
    return truncateLine(`${protocol}${url.host}${path}`, max);
  } catch {
    const sanitized = normalized.replace(/^([a-z][a-z\d+.-]*:\/\/)?[^/@\s]+@/i, "$1").replace(/[?#].*$/, "");
    return compactToolText(sanitized, max);
  }
}

export function compactToolPath(value: string, max = TOOL_SUBJECT_MAX_WIDTH): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  const workspace = process.cwd().replaceAll("\\", "/").replace(/\/+$/, "");
  const relative = normalized.startsWith(`${workspace}/`) ? normalized.slice(workspace.length + 1) : normalized;
  const parts = relative.split("/").filter(Boolean);
  const tail = parts.length > 2 ? parts.slice(-2).join("/") : relative || value;
  return truncateLine(tail, max);
}

export function compactToolCommand(value: string, max = TOOL_SUBJECT_MAX_WIDTH): string {
  const normalized = value.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(normalized) && /(?:\n|&&|\|\||;)/.test(normalized)) return "shell";
  const tokens = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  let index = 0;
  while (index < tokens.length) {
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1;
    const wrapper = stripQuotes(tokens[index] ?? "");
    if (wrapper === "sudo") {
      index += 1;
      index = skipCommandOptions(tokens, index, new Set([
        "-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h", "--host", "-p", "--prompt",
        "-R", "--chroot", "-r", "--role", "-T", "--command-timeout", "-t", "--type", "-U", "--other-user", "-u", "--user"
      ]));
      continue;
    }
    if (wrapper === "env") {
      index = skipCommandOptions(tokens, index + 1, new Set(["-C", "--chdir", "-S", "--split-string", "-u", "--unset"]));
      continue;
    }
    if (wrapper === "timeout") {
      index = skipCommandOptions(tokens, index + 1, new Set(["-k", "--kill-after", "-s", "--signal"]));
      index += 1;
      continue;
    }
    if (wrapper === "command" || wrapper === "time") {
      index = skipCommandOptions(tokens, index + 1, new Set());
      continue;
    }
    break;
  }
  const executable = stripQuotes(tokens[index] ?? "command").replaceAll("\\", "/").split("/").at(-1) ?? "command";
  return truncateLine(executable, max);
}

export function compactToolId(value: string, max = 18): string {
  const normalized = value.trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(4, max - 7))}…${normalized.slice(-6)}`;
}

export function compactToolTarget(value: string, max = TOOL_SUBJECT_MAX_WIDTH): string {
  const normalized = value.trim();
  return /^[a-z][a-z\d+.-]*:\/\//i.test(normalized)
    ? compactToolUrl(normalized, max)
    : compactToolText(normalized, max);
}

function formatStringValue(key: string, value: string): string {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === "command" || normalizedKey === "cmd") return compactToolCommand(value);
  if (["path", "file", "filename", "wordlist"].includes(normalizedKey)) return compactToolPath(value);
  if (normalizedKey === "url" || normalizedKey.endsWith("url") || normalizedKey === "uri") return compactToolUrl(value);
  if (normalizedKey === "target" || normalizedKey === "host" || normalizedKey === "domain" || normalizedKey === "canonical") return compactToolTarget(value);
  if (normalizedKey === "id" || normalizedKey.endsWith("id")) return compactToolId(value);
  return compactToolText(value);
}

function collectionLabel(key: string, values: unknown[]): string {
  if (values.length === 1) return formatStringValue(key, String(values[0] ?? ""));
  const noun = collectionNoun(key);
  return `${values.length} ${noun}`;
}

function collectionNoun(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized.includes("domain")) return "domains";
  if (normalized.includes("name")) return "names";
  if (normalized.includes("id")) return "identifiers";
  if (normalized.includes("url")) return "urls";
  if (normalized.includes("port")) return "ports";
  if (normalized.includes("target") || normalized.includes("host")) return "targets";
  return "items";
}

function stripQuotes(value: string): string {
  return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
}

function skipCommandOptions(tokens: string[], start: number, valueOptions: Set<string>): number {
  let index = start;
  while (index < tokens.length) {
    const option = stripQuotes(tokens[index] ?? "");
    if (!option.startsWith("-") || option === "-") break;
    index += 1;
    if (!option.includes("=") && valueOptions.has(option)) index += 1;
  }
  return index;
}

function truncateLine(line: string, maxWidth: number): string {
  return truncateTerminal(line, Math.max(maxWidth, 1));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function browserToolTitle(tool: string, input: Record<string, unknown>, active: boolean, failed: boolean): string | undefined {
  if (failed && (tool === "browser_context" || tool.startsWith("browser_"))) return toolFailureLabel(tool);
  const action = toolActionLabel(tool, active);
  if (tool === "browser_context") {
    const contextAction = typeof input.action === "string" ? input.action : "list";
    const selector = typeof input.name === "string" ? compactToolText(input.name) : typeof input.browser === "string" ? compactToolText(input.browser) : "";
    if (contextAction === "create") return `${active ? "creating" : "created"} browser${selector ? ` ${selector}` : ""}`;
    if (contextAction === "close") return `${active ? "closing" : "closed"} browser${selector ? ` ${selector}` : ""}`;
    return active ? "listing browsers" : "listed browsers";
  }
  if (tool === "browser_fill_form") {
    const fields = Array.isArray(input.fields) ? input.fields : [];
    const names = fields.flatMap((field) => field && typeof field === "object" && !Array.isArray(field) && typeof (field as Record<string, unknown>).name === "string"
      ? [(field as Record<string, unknown>).name as string]
      : []);
    const target = names.length === 1 ? compactToolText(names[0]!) : `${fields.length} fields`;
    return `${action} ${target}`;
  }
  if (tool === "browser_wait_for") {
    if (typeof input.textGone === "string" && input.textGone.trim()) return `${action} ${compactToolText(input.textGone)} to disappear`;
    if (typeof input.text === "string" && input.text.trim()) return `${action} ${compactToolText(input.text)}`;
    if (typeof input.time === "number") return `${active ? "waiting" : "waited"} ${formatSeconds(input.time)}`;
    return active ? "waiting" : "waited";
  }
  if (tool === "browser_tabs") {
    const tabAction = typeof input.action === "string" ? input.action : "list";
    const index = typeof input.index === "number" ? ` ${input.index}` : "";
    const url = typeof input.url === "string" && input.url.trim() ? ` ${compactToolUrl(input.url)}` : "";
    if (tabAction === "new") return `${active ? "opening" : "opened"} new tab${url}`;
    if (tabAction === "close") return `${active ? "closing" : "closed"} tab${index}`;
    if (tabAction === "select") return `${active ? "selecting" : "selected"} tab${index}`;
    return active ? "listing tabs" : "listed tabs";
  }
  if (tool === "browser_network_requests") {
    const filter = typeof input.filter === "string" && input.filter.trim() ? ` for ${compactToolText(input.filter)}` : "";
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
  if (tool === "command_run") {
    const command = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : "";
    return `${failed ? "failed to run" : active ? "running" : "ran"} ${command ? compactToolCommand(command) : "command"}`;
  }
  if (tool === "command_input") return failed ? "failed to send input" : active ? "sending input" : "sent input";
  if (tool === "file_read") return fileTitle(failed, active, "read", "reading", "read", input.path, "file");
  if (tool === "file_list") return fileTitle(failed, active, "list files", "listing files", "listed files", input.path);
  if (tool === "file_search") {
    const pattern = typeof input.pattern === "string" ? compactToolText(input.pattern, 36) : "pattern";
    return `${failed ? "failed to search files" : active ? "searching files" : "searched files"} · "${pattern}"`;
  }
  if (tool === "file_write") return fileTitle(failed, active, "write", "writing", "wrote", input.path, "file");
  if (tool === "file_replace") return fileTitle(failed, active, "edit", "editing", "edited", input.path, "file");
  if (tool === "file_patch") return failed ? "failed to apply patch" : active ? "applying patch" : "applied patch";
  if (tool === "git_status") return failed ? "failed to check git status" : active ? "checking git status" : "checked git status";
  if (tool === "git_diff") return failed ? "failed to check git diff" : active ? "checking git diff" : "checked git diff";
  if (tool === "script_write") return fileTitle(failed, active, "write script", "writing script", "wrote script", input.filename);
  if (tool === "output_read") {
    return failed ? "failed to read saved output" : active ? "reading saved output" : "read saved output";
  }
  if (tool === "context_expand") {
    return failed ? "failed to expand context" : active ? "expanding context" : "expanded context";
  }
  if (tool === "code_diagnostics") {
    const path = typeof input.path === "string" ? ` · ${compactToolPath(input.path)}` : "";
    return `${failed ? "failed to inspect diagnostics" : active ? "inspecting diagnostics" : "inspected diagnostics"}${path}`;
  }
  if (tool === "image_read") return fileTitle(failed, active, "view image", "viewing image", "viewed image", input.path);
  if (tool === "user_input") {
    const count = Array.isArray(input.questions) ? input.questions.length : 0;
    const subject = count ? ` · ${count} question${count === 1 ? "" : "s"}` : "";
    return `${failed ? "failed to ask user" : active ? "asking user" : "asked user"}${subject}`;
  }
  if (tool === "browser_snapshot") return failed ? "failed to capture snapshot" : active ? "capturing snapshot" : "captured snapshot";
  if (tool === "campaign_asset") {
    const target = typeof input.canonical === "string" ? compactToolTarget(input.canonical) : "asset";
    return `${failed ? "failed to save asset" : active ? "saving asset" : "saved asset"} · ${target}`;
  }
  if (tool === "asset_subdomains") return reconTitle(failed, active, "enumerate subdomains", "enumerating subdomains", "enumerated subdomains", input.domain, "domains");
  if (tool === "network_scan") {
    if (input.mode === "nmap" || input.mode === "deep") return `${failed ? "failed to run" : active ? "running" : "ran"} nmap`;
    return reconTitle(failed, active, "scan ports", "scanning ports", "scanned ports", input.target, "targets");
  }
  if (tool === "dns_resolve") return reconTitle(failed, active, "resolve dns", "resolving dns", "resolved dns", input.names, "names");
  if (tool === "service_probe") return reconTitle(failed, active, "probe http services", "probing http services", "probed http services", input.targets, "targets");
  if (tool === "tls_inspect") return reconTitle(failed, active, "inspect tls", "inspecting tls", "inspected tls", input.targets, "targets");
  if (tool === "url_discover") return reconTitle(failed, active, "discover urls", "discovering urls", "discovered urls", input.domains, "domains");
  if (tool === "web_crawl") return reconTitle(failed, active, "crawl", "crawling", "crawled", input.targets, "targets");
  if (tool === "vulnerability_scan") return reconTitle(failed, active, "scan vulnerabilities", "scanning vulnerabilities", "scanned vulnerabilities", input.targets, "targets");
  if (tool === "vulnerability_lookup") return reconTitle(failed, active, "look up vulnerabilities", "looking up vulnerabilities", "looked up vulnerabilities", input.ids ?? input.query, "identifiers");
  if (tool === "http_request") {
    const method = typeof input.method === "string" ? input.method.toLowerCase() : "get";
    const target = typeof input.url === "string" ? compactToolUrl(input.url) : "request";
    return `${failed ? "failed to request" : active ? "requesting" : "requested"} ${method} · ${target}`;
  }
  if (tool === "web_directory") {
    const target = typeof input.url === "string" ? compactToolUrl(input.url) : "target";
    return `${failed ? "failed to enumerate paths" : active ? "enumerating paths" : "enumerated paths"} · ${target}`;
  }
  if (tool === "web_search") {
    const query = typeof input.query === "string" ? compactToolText(input.query, 36) : "query";
    return `${failed ? "failed to search the web" : active ? "searching the web" : "searched the web"} · "${query}"`;
  }
  if (tool === "web_fetch") {
    const target = typeof input.url === "string" ? compactToolUrl(input.url) : "page";
    return `${failed ? "failed to fetch page" : active ? "fetching page" : "fetched page"} · ${target}`;
  }
  if (tool === "kali_search") {
    const query = typeof input.query === "string" ? compactToolText(input.query, 36) : "tools";
    return `${failed ? "failed to search kali tools" : active ? "searching kali tools" : "searched kali tools"} · ${query}`;
  }
  if (tool === "email_list") return failed ? "failed to list emails" : active ? "listing emails" : "listed emails";
  if (tool === "email_create") {
    const label = typeof input.label === "string" && input.label.trim() ? ` ${compactToolText(input.label)}` : "";
    return `${failed ? "failed to create" : active ? "creating" : "created"} email${label}`;
  }
  if (tool === "email_inbox") return failed ? "failed to check inbox" : active ? "checking inbox" : "checked inbox";
  if (tool === "email_read") return failed ? "failed to read email" : active ? "reading email" : "read email";
  if (tool === "email_wait") return `${failed ? "failed waiting for" : active ? "waiting for" : "received"} email${typeof input.subject === "string" && input.subject.trim() ? ` · ${compactToolText(input.subject)}` : ""}`;
  if (tool === "callback_host_info") return failed ? "failed to inspect host network" : active ? "inspecting host network" : "inspected host network";
  if (tool === "callback_oast") return failed ? "failed to start oast session" : active ? "starting oast session" : "started oast session";
  if (tool === "notebook_cell") {
    const operation = typeof input.operation === "string" ? input.operation : "edit";
    const path = typeof input.path === "string" ? ` in ${compactToolPath(input.path)}` : "";
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
    const server = typeof input.server === "string" && input.server.trim() ? ` from ${compactToolText(input.server)}` : "";
    if (input.operation === "read") {
      const uri = typeof input.uri === "string" ? compactToolUrl(input.uri) : "";
      return `${active ? "reading" : "read"} mcp resource${uri ? ` ${uri}` : ""}${server}`;
    }
    return `${active ? "listing" : "listed"} mcp resources${server}`;
  }
  if (tool === "proxy_scope") {
    if (failed) return "failed to update proxy scope";
    return Array.isArray(input.allowedDomains)
      ? active ? "updating proxy scope" : "updated proxy scope"
      : active ? "checking proxy scope" : "checked proxy scope";
  }
  if (tool === "proxy_policy") {
    if (failed) return "failed to update proxy policy";
    return input.tls !== undefined || input.passThroughHosts !== undefined
      ? active ? "updating proxy policy" : "updated proxy policy"
      : active ? "checking proxy policy" : "checked proxy policy";
  }
  if (tool === "proxy_intercept") {
    if (failed) return "failed to manage interception";
    const action = typeof input.action === "string" ? input.action : "status";
    const labels: Record<string, readonly [string, string]> = {
      status: ["checked interception", "checking interception"],
      configure: ["configured interception", "configuring interception"],
      list: ["listed intercepted requests", "listing intercepted requests"],
      forward: ["forwarded intercepted request", "forwarding intercepted request"],
      edit: ["edited intercepted request", "editing intercepted request"],
      drop: ["dropped intercepted request", "dropping intercepted request"]
    };
    return labels[action]?.[active ? 1 : 0];
  }
  if (tool === "proxy_clear") return failed ? "failed to clear proxy traffic" : active ? "clearing proxy traffic" : "cleared proxy traffic";
  if (tool === "worktree_manage") {
    const name = typeof input.name === "string" && input.name.trim() ? ` ${compactToolText(input.name)}` : "";
    return input.operation === "exit" ? (active ? "leaving worktree" : "left worktree") : `${active ? "entering" : "entered"} worktree${name}`;
  }
  if (tool === "agent_list") return failed ? "failed to list agents" : active ? "listing agents" : "listed agents";
  return undefined;
}

function reconTitle(failed: boolean, active: boolean, infinitive: string, present: string, past: string, value: unknown, pluralNoun: string): string {
  const target = inputCollectionLabel(value, pluralNoun);
  return `${failed ? `failed to ${infinitive}` : active ? present : past}${target ? ` · ${target}` : ""}`;
}

function fileTitle(failed: boolean, active: boolean, infinitive: string, present: string, past: string, value: unknown, fallback = ""): string {
  const path = typeof value === "string" && value.trim() ? compactToolPath(value) : fallback;
  return `${failed ? `failed to ${infinitive}` : active ? present : past}${path ? ` ${path}` : ""}`;
}

function inputCollectionLabel(value: unknown, pluralNoun: string): string {
  if (typeof value === "string") return compactToolTarget(value);
  if (!Array.isArray(value) || !value.length) return "";
  if (value.length > 1) return `${value.length} ${pluralNoun}`;
  return compactToolTarget(String(value[0] ?? ""));
}

function formatSeconds(value: number): string {
  return `${value}s`;
}
