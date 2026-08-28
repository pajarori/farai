import type { ToolDefinition } from "../types";
import { getTool } from "../agent-tools/registry";
import { canonicalToolName } from "../tool-names";

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
  "browser"
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
  agent_task: ["delegated", "delegating"],
  session_poll: ["checked background work", "checking background work"],
  session_stop: ["stopped background work", "stopping background work"],
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
  browser_network_request: ["inspected", "inspecting"]
};

const TOOL_INPUT_KEYS: Record<string, readonly string[]> = {
  agent_task: ["title", "lane", "prompt"],
  browser_click: ["element", "target"],
  browser_type: ["element", "target", "text"],
  browser_find: ["text", "regex"],
  browser_press_key: ["key"],
  browser_wait_for: ["text", "textGone", "time"],
  browser_tabs: ["action", "index", "url"],
  browser_network_requests: ["filter", "filename"],
  browser_network_request: ["index", "part"]
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
  const canonical = canonicalToolName(toolName);
  const inputObject = toolInputObject(args);
  const browserTitle = inputObject ? browserToolTitle(canonical, inputObject, active) : undefined;
  if (browserTitle) return truncateLine(browserTitle, max);
  if (canonical === "session_poll" || canonical === "session_stop") return truncateLine(toolActionLabel(canonical, active), max);
  if (status === "running_background") {
    const input = summarizeToolInput(toolName, args, max);
    return `started background ${input || shortToolName(toolName)}`;
  }
  const input = summarizeToolInput(toolName, args, max);
  return truncateLine(`${toolActionLabel(toolName, active)} ${input || shortToolName(toolName)}`, max);
}

export function summarizeToolInput(toolName: unknown, args: unknown, max = 80): string {
  const obj = toolInputObject(args);
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
  const safe = Math.max(maxWidth, 1);
  if (line.length <= safe) return line;
  return safe > 1 ? line.slice(0, safe - 1) + "…" : line.slice(0, safe);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function browserToolTitle(tool: string, input: Record<string, unknown>, active: boolean): string | undefined {
  const action = toolActionLabel(tool, active);
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

function formatSeconds(value: number): string {
  return `${value}s`;
}
