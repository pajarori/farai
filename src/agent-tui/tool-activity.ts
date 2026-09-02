import type { ToolResult } from "../types";
import { canonicalToolName } from "../tool-names";
import { parseDirectoryResults, parseNmap, splitHttpResponse } from "./tool-renderers";
import { truncateTerminal } from "./terminal-text";
import { isActiveToolStatus, toolDefinition, toolTitle } from "./tool-presentation";

export type ToolActivityFamily =
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

export type ToolActivityPresentation = {
  family: ToolActivityFamily;
  title: string;
  compact: string;
  outcome?: string;
  preview: string[];
  groupKey?: string;
  groupPast?: string;
  groupActive?: string;
  standalone: boolean;
  warning: boolean;
};

export type ToolActivityInput = {
  tool: string;
  args: unknown;
  status: string;
  result?: string;
  fullResult?: string;
  liveOutput?: string;
  toolResult?: ToolResult;
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

const WORKSPACE_TOOLS = new Set(["fs_read", "fs_list", "fs_grep", "fs_write", "fs_edit", "patch_apply", "notebook_edit", "git_status", "git_diff", "lsp_inspect", "tool_output_read", "code_write_script"]);
const RECON_TOOLS = new Set(["port_scan", "nmap_scan", "subdomain_enum", "dns_probe", "http_probe", "tls_probe", "url_discover", "web_crawl", "vulnerability_scan", "vulnerability_lookup", "dir_enum", "exploit_search", "kali_tool_search"]);
const HTTP_TOOLS = new Set(["http_request", "internet_search", "internet_fetch"]);

export function presentToolActivity(input: ToolActivityInput): ToolActivityPresentation {
  const tool = canonicalToolName(input.tool) || "tool";
  const args = inputObject(input.args);
  const active = isActiveToolStatus(input.status);
  const text = active ? input.liveOutput ?? input.result ?? "" : input.result ?? input.fullResult ?? "";
  const metadata = input.toolResult?.metadata ?? {};
  const family = toolFamily(tool);
  const title = tool === "email_wait" && !active && metadata.timedOut === true
    ? emailWaitTimeoutTitle(args)
    : toolTitle(tool, args, input.status, 240);
  const warning = hasWarning(input.toolResult, text);
  const preview = toolPreview(tool, args, text, metadata, active);
  const outcome = toolOutcome(tool, args, text, metadata, input.toolResult, active);
  const grouping = activityGrouping(tool, family, args, metadata);
  const standalone = toolStandalone(tool, input, warning, family);
  return {
    family,
    title,
    compact: compactActivityLabel(tool, args, title),
    ...(outcome ? { outcome } : {}),
    preview,
    ...(grouping ? grouping : {}),
    standalone,
    warning
  };
}

export function activityStatus(items: readonly ToolActivityInput[]): "running" | "error" | "done" {
  if (items.some((item) => isActiveToolStatus(item.status))) return "running";
  if (items.some((item) => item.status === "error" || item.toolResult?.ok === false)) return "error";
  return "done";
}

export function activityDuration(items: readonly { durationMs?: number }[]): number | undefined {
  const values = items.flatMap((item) => typeof item.durationMs === "number" && Number.isFinite(item.durationMs) ? [item.durationMs] : []);
  return values.length === items.length && values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
}

export function formatActivityDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 60_000) {
    const seconds = durationMs / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const seconds = Math.round(durationMs / 1_000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function toolFamily(tool: string): ToolActivityFamily {
  if (tool === "shell_exec" || tool === "session_poll" || tool === "session_stop") return "command";
  if (WORKSPACE_TOOLS.has(tool)) return "workspace";
  if (tool === "browser_context" || BROWSER_TOOLS.has(tool)) return "browser";
  if (HTTP_TOOLS.has(tool)) return "http";
  if (tool.startsWith("proxy_")) return "proxy";
  if (RECON_TOOLS.has(tool)) return "recon";
  if (tool.startsWith("knowledge_") || tool.startsWith("memory_") || tool.startsWith("notes_") || tool.startsWith("evidence_")) return "knowledge";
  if (tool.startsWith("campaign_") || tool.startsWith("report_")) return "campaign";
  if (tool.startsWith("agent_")) return "agent";
  if (tool.startsWith("mcp_")) return "mcp";
  if (tool === "image_view") return "media";
  if (tool.startsWith("email_")) return "email";
  return "generic";
}

function activityGrouping(
  tool: string,
  family: ToolActivityFamily,
  args: Record<string, unknown>,
  metadata: Record<string, unknown>
): Pick<ToolActivityPresentation, "groupKey" | "groupPast" | "groupActive"> | undefined {
  if (tool === "shell_exec") return { groupKey: "command", groupPast: "ran", groupActive: "running" };
  if (family === "workspace") return { groupKey: "workspace", groupPast: "inspected", groupActive: "inspecting" };
  if (family === "browser" && tool !== "browser_context") {
    const context = stringValue(metadata.browserContextName) ?? stringValue(args.browser) ?? "default";
    return { groupKey: `browser:${context}`, groupPast: `browsed · ${context}`, groupActive: `browsing · ${context}` };
  }
  if (tool === "http_request") {
    const origin = urlOrigin(stringValue(args.url));
    return { groupKey: `http:${origin ?? "requests"}`, groupPast: origin ? `probed · ${origin}` : "probed endpoints", groupActive: origin ? `probing · ${origin}` : "probing endpoints" };
  }
  if (family === "proxy" && !toolDefinition(tool)?.mutates) {
    const host = stringValue(metadata.host) ?? stringValue(args.host) ?? stringValue(args.filter) ?? "traffic";
    return { groupKey: `proxy:${host}`, groupPast: `inspected proxy · ${host}`, groupActive: `inspecting proxy · ${host}` };
  }
  if (family === "knowledge" && !toolDefinition(tool)?.mutates) return { groupKey: "knowledge", groupPast: "queried knowledge", groupActive: "querying knowledge" };
  if (family === "mcp" && !toolDefinition(tool)?.mutates) {
    const server = stringValue(args.server) ?? "mcp";
    return { groupKey: `mcp:${server}`, groupPast: `queried ${server}`, groupActive: `querying ${server}` };
  }
  if (family === "email" && tool !== "email_create") {
    const emailId = stringValue(args.emailId) ?? stringValue(metadata.emailId) ?? "email";
    return { groupKey: `email:${emailId}`, groupPast: "checked email", groupActive: "checking email" };
  }
  return undefined;
}

function toolStandalone(tool: string, input: ToolActivityInput, warning: boolean, family: ToolActivityFamily): boolean {
  if (input.status === "error" || input.toolResult?.ok === false || input.status === "running_background") return true;
  if (input.toolResult?.attachments?.length || input.toolResult?.evidence?.length || input.toolResult?.outputArtifactId) return true;
  if (warning) return true;
  if (family === "recon" || family === "campaign" || family === "agent" || family === "media" || family === "email") return true;
  if (tool === "browser_context" || tool === "internet_search" || tool === "internet_fetch") return true;
  if (family === "browser") return false;
  const definition = toolDefinition(tool);
  return definition?.mutates === true && tool !== "shell_exec";
}

function compactActivityLabel(tool: string, args: Record<string, unknown>, title: string): string {
  if (tool === "shell_exec") return (stringValue(args.command) ?? title).replace(/\s+/g, " ").trim();
  if (tool === "http_request") {
    const method = (stringValue(args.method) ?? "get").toLowerCase();
    return `${method} ${stringValue(args.url) ?? "request"}`;
  }
  if (tool === "browser_navigate") return `opened ${stringValue(args.url) ?? "page"}`;
  if (tool === "proxy_flow_get") return `flow ${stringValue(args.flowId) ?? "request"}`;
  return title;
}

function emailWaitTimeoutTitle(args: Record<string, unknown>): string {
  const filter = stringValue(args.subject) ?? stringValue(args.from);
  return truncateTerminal(`no matching email${filter ? ` · ${filter}` : ""}`, 240);
}

function toolOutcome(
  tool: string,
  args: Record<string, unknown>,
  text: string,
  metadata: Record<string, unknown>,
  result: ToolResult | undefined,
  active: boolean
): string | undefined {
  if (active) return liveOutcome(text);
  if (result?.ok === false) return firstMeaningfulLine(text) ?? result.summary;
  if (tool === "port_scan" || tool === "nmap_scan" || (tool === "shell_exec" && /^\s*(?:sudo\s+)?nmap\b/i.test(stringValue(args.command) ?? ""))) {
    const ports = parseNmap(text);
    if (ports.length > 0) return ports.slice(0, 6).map((row) => `${row.port}/${row.service}`).join(", ") + (ports.length > 6 ? ` · +${ports.length - 6}` : "");
    const discovered = numberValue(metadata.recordCount) ?? arrayValue(metadata.discoveredPorts).length;
    if (discovered > 0) return `${discovered} open port${discovered === 1 ? "" : "s"}`;
  }
  if (tool === "subdomain_enum") {
    const names = arrayValue(metadata.discoveredSubdomains);
    const sources = arrayValue(metadata.sources);
    const warnings = sources.filter((value) => objectValue(value)?.status !== "ok").length;
    return `${names.length} subdomain${names.length === 1 ? "" : "s"}${warnings ? ` · ${warnings} source warning${warnings === 1 ? "" : "s"}` : ""}`;
  }
  const structuredRecon = structuredReconOutcome(tool, metadata);
  if (structuredRecon) return structuredRecon;
  if (tool === "dir_enum") {
    const dirs = parseDirectoryResults(text);
    if (dirs.length > 0) return `${dirs.length} path${dirs.length === 1 ? "" : "s"}`;
    const summarized = text.split("\n").filter((line) => /^\d{3}\s+https?:\/\//.test(line.trim()));
    if (summarized.length > 0) return `${summarized.length} path${summarized.length === 1 ? "" : "s"}`;
  }
  if (tool === "http_request") {
    const http = splitHttpResponse(text);
    if (http.status) return http.status.replace(/^HTTP\/\S+\s+/, "").toLowerCase();
  }
  if (tool === "internet_search") {
    const results = arrayValue(metadata.results);
    const provider = stringValue(metadata.provider);
    return `${results.length} result${results.length === 1 ? "" : "s"}${provider ? ` · ${provider}` : ""}`;
  }
  if (tool === "internet_fetch") {
    const contentType = stringValue(metadata.contentType)?.split(";", 1)[0];
    const bytes = numberValue(metadata.bytes);
    return [contentType, bytes !== undefined ? formatBytes(bytes) : undefined].filter(Boolean).join(" · ") || result?.summary;
  }
  if (tool === "browser_context") {
    const action = stringValue(metadata.browserContextAction) ?? stringValue(args.action);
    if (action === "list") return `${arrayValue(metadata.browserContexts).length} browser context${arrayValue(metadata.browserContexts).length === 1 ? "" : "s"}`;
    return stringValue(metadata.browserContextName) ?? result?.summary;
  }
  if (tool === "email_list") return `${arrayValue(metadata.emails).length} email${arrayValue(metadata.emails).length === 1 ? "" : "s"}`;
  if (tool === "email_create") {
    const email = objectValue(metadata.email);
    return email ? `${String(email.address ?? "email")} · ${String(email.id ?? "")}`.replace(/ · $/, "") : cleanSummary(result?.summary);
  }
  if (tool === "email_inbox") return `${arrayValue(metadata.messages).length} message${arrayValue(metadata.messages).length === 1 ? "" : "s"}`;
  if (tool === "email_read" || tool === "email_wait") {
    const message = objectValue(metadata.message);
    return message ? `${String(message.from ?? "sender")} · ${String(message.subject ?? "email")}` : cleanSummary(result?.summary);
  }
  if (tool === "fs_read") return cleanSummary(result?.summary) ?? `${semanticLines(text, Number.MAX_SAFE_INTEGER).length} lines`;
  if (tool === "fs_list") {
    const count = semanticLines(text, Number.MAX_SAFE_INTEGER).length;
    return `${count} ${count === 1 ? "entry" : "entries"}`;
  }
  if (tool === "fs_grep") {
    const count = semanticLines(text, Number.MAX_SAFE_INTEGER).filter((line) => line !== "No matches").length;
    return `${count} match${count === 1 ? "" : "es"}`;
  }
  if (tool === "git_status") {
    const count = semanticLines(text, Number.MAX_SAFE_INTEGER).filter((line) => !/^on branch\b|^your branch\b|^nothing to commit/i.test(line)).length;
    return count ? `${count} changed line${count === 1 ? "" : "s"}` : "clean";
  }
  if (tool === "git_diff") {
    const lines = text.split("\n");
    const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    return added || removed ? `+${added} −${removed}` : "no diff";
  }
  if (tool.startsWith("browser_")) return browserOutcome(text, metadata) ?? cleanSummary(result?.summary);
  if (tool.startsWith("proxy_")) return proxyOutcome(metadata, result?.summary, text);
  if (tool === "image_view") return result?.summary?.replace(/^image\s+/i, "") ?? firstMeaningfulLine(text);
  if (tool === "shell_exec") {
    const first = firstMeaningfulLine(text);
    if (first) return first;
    const exit = result?.summary?.match(/\bexit=(\d+)/)?.[1];
    return exit ? `exit ${exit}` : cleanSummary(result?.summary);
  }
  return cleanSummary(result?.summary) ?? firstMeaningfulLine(text);
}

function toolPreview(
  tool: string,
  args: Record<string, unknown>,
  text: string,
  metadata: Record<string, unknown>,
  active: boolean
): string[] {
  if (!text && !Object.keys(metadata).length) return [];
  if (tool === "port_scan" || tool === "nmap_scan" || (tool === "shell_exec" && /^\s*(?:sudo\s+)?nmap\b/i.test(stringValue(args.command) ?? ""))) {
    const rows = parseNmap(text);
    if (rows.length > 0) return withMore(rows.slice(0, 5).map((row) => `${row.port}/${row.proto}  ${row.service}${row.version ? `  ${row.version}` : ""}`), rows.length, 5);
  }
  if (tool === "subdomain_enum") {
    const names = arrayValue(metadata.discoveredSubdomains).map(String);
    const errors = arrayValue(metadata.sources).flatMap((value) => {
      const source = objectValue(value);
      return source && source.status !== "ok" ? [`warning: ${String(source.source ?? "source")} ${String(source.error ?? source.status)}`] : [];
    });
    return [...withMore(names.slice(0, 4), names.length, 4), ...errors.slice(0, 2)];
  }
  const structuredRecon = structuredReconPreview(tool, metadata);
  if (structuredRecon.length) return structuredRecon;
  if (tool === "dir_enum") {
    const rows = parseDirectoryResults(text);
    if (rows.length > 0) return withMore(rows.slice(0, 5).map((row) => `${row.status}  ${row.url}`), rows.length, 5);
  }
  if (tool === "internet_search") {
    const results = arrayValue(metadata.results);
    const lines = results.slice(0, 5).flatMap((value) => {
      const result = objectValue(value);
      return result ? [`${String(result.title ?? result.url ?? "result")} · ${hostFromUrl(stringValue(result.url)) ?? String(result.source ?? "web")}`] : [];
    });
    return withMore(lines, results.length, 5);
  }
  if (tool === "browser_context") return browserContextPreview(metadata);
  if (tool === "email_list") return emailResourcePreview(arrayValue(metadata.emails));
  if (tool === "email_create") return emailResourcePreview([metadata.email]);
  if (tool === "email_inbox") return emailMessagePreview(arrayValue(metadata.messages));
  if (tool === "email_read" || tool === "email_wait") return emailMessagePreview([metadata.message]);
  if (tool.startsWith("proxy_")) {
    const flow = proxyOutcome(metadata, undefined, text);
    if (flow) return [flow, ...semanticLines(text, 3).filter((line) => line !== flow)];
  }
  if (active) return boundedTailLines(text, 4);
  return boundedPreviewLines(text, 5);
}

function structuredReconOutcome(tool: string, metadata: Record<string, unknown>): string | undefined {
  const records = numberValue(metadata.recordCount) ?? arrayValue(metadata.records).length;
  if (tool === "dns_probe") {
    const resolved = numberValue(metadata.resolvedNames) ?? records;
    return `${resolved} resolved name${resolved === 1 ? "" : "s"}`;
  }
  if (tool === "http_probe") {
    const live = numberValue(metadata.liveServices) ?? records;
    const failed = numberValue(metadata.failedTargets) ?? 0;
    return `${live} live service${live === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}`;
  }
  if (tool === "web_crawl") {
    const urls = numberValue(metadata.uniqueUrls) ?? records;
    const forms = numberValue(metadata.forms) ?? 0;
    const xhr = numberValue(metadata.xhrRequests) ?? 0;
    return `${urls} endpoint${urls === 1 ? "" : "s"}${forms ? ` · ${forms} form${forms === 1 ? "" : "s"}` : ""}${xhr ? ` · ${xhr} xhr` : ""}`;
  }
  if (tool === "vulnerability_scan") {
    const severity = objectValue(metadata.severities);
    const counts = severity ? ["critical", "high", "medium", "low", "info"].flatMap((name) => numberValue(severity[name]) ? [`${name} ${numberValue(severity[name])}`] : []) : [];
    return `${records} finding${records === 1 ? "" : "s"}${counts.length ? ` · ${counts.join(", ")}` : ""}`;
  }
  if (tool === "tls_probe") {
    const successful = numberValue(metadata.successfulProbes) ?? records;
    const expiring = numberValue(metadata.expiringCertificates) ?? 0;
    return `${successful} tls endpoint${successful === 1 ? "" : "s"}${expiring ? ` · ${expiring} expiring soon` : ""}`;
  }
  if (tool === "url_discover") {
    const urls = numberValue(metadata.uniqueUrls) ?? records;
    return `${urls} url${urls === 1 ? "" : "s"}`;
  }
  if (tool === "vulnerability_lookup") return `${records} vulnerabilit${records === 1 ? "y" : "ies"}`;
  return undefined;
}

function structuredReconPreview(tool: string, metadata: Record<string, unknown>): string[] {
  const records = arrayValue(metadata.records).flatMap((value) => {
    const item = objectValue(value);
    return item ? [item] : [];
  });
  if (!records.length) return [];
  const lines = records.slice(0, 5).map((item) => formatStructuredReconRecord(tool, item));
  return withMore(lines, records.length, 5);
}

function formatStructuredReconRecord(tool: string, item: Record<string, unknown>): string {
  if (tool === "port_scan" || tool === "nmap_scan") return `${String(item.host ?? "host")}:${String(item.port ?? "?")}/${String(item.protocol ?? "tcp")}${item.service ? ` · ${String(item.service)}` : ""}`;
  if (tool === "dns_probe") {
    const recordMap = objectValue(item.records);
    const answers = recordMap ? Object.entries(recordMap).flatMap(([type, values]) => arrayValue(values).map((value) => `${type.toUpperCase()} ${String(value)}`)).slice(0, 4) : [];
    return `${String(item.name ?? "name")}${answers.length ? ` · ${answers.join(" · ")}` : " · no answers"}`;
  }
  if (tool === "http_probe") return [item.statusCode ?? "?", item.finalUrl ?? item.url ?? item.input, item.title, item.webServer].filter((value) => value !== undefined && value !== "").map(String).join(" · ");
  if (tool === "web_crawl") return [item.method ?? "GET", item.url, item.statusCode, item.tag].filter((value) => value !== undefined && value !== "").map(String).join(" · ");
  if (tool === "vulnerability_scan") return [String(item.severity ?? "unknown").toUpperCase(), item.templateId, item.name, item.matchedAt].filter((value) => value !== undefined && value !== "").map(String).join(" · ");
  if (tool === "tls_probe") return [`${String(item.host ?? "host")}${item.port ? `:${String(item.port)}` : ""}`, item.version, item.cipher, item.commonName].filter((value) => value !== undefined && value !== "").map(String).join(" · ");
  if (tool === "url_discover") return [item.url, arrayValue(item.sources).join(", ")].filter((value) => value !== undefined && value !== "").map(String).join(" · ");
  if (tool === "vulnerability_lookup") return [item.id, String(item.severity ?? "").toUpperCase(), item.title, item.cvssScore !== undefined ? `cvss ${String(item.cvssScore)}` : undefined].filter((value) => value !== undefined && value !== "").map(String).join(" · ");
  return Object.values(item).filter((value) => typeof value === "string" || typeof value === "number").slice(0, 4).map(String).join(" · ");
}

function emailResourcePreview(values: unknown[]): string[] {
  const rows = values.flatMap((value) => {
    const email = objectValue(value);
    if (!email) return [];
    const roles = arrayValue(email.roles).map(String).join(" · ");
    return [`${String(email.address ?? "email")} · ${String(email.type ?? email.provider ?? "email")}${roles ? ` · ${roles}` : ""}`, `id: ${String(email.id ?? "unknown")}`];
  });
  return withMore(rows.slice(0, 6), rows.length, 6);
}

function emailMessagePreview(values: unknown[]): string[] {
  const rows = values.flatMap((value) => {
    const message = objectValue(value);
    if (!message) return [];
    return [`${String(message.from ?? "sender")} · ${String(message.subject ?? "(no subject)")}`, `id: ${String(message.id ?? "unknown")}`];
  });
  return withMore(rows.slice(0, 6), rows.length, 6);
}

function browserOutcome(text: string, metadata: Record<string, unknown>): string | undefined {
  const url = text.match(/(?:final url|page url):\s*(\S+)/i)?.[1];
  const title = text.match(/(?:page title|title):\s*(.+)/i)?.[1]?.trim();
  const warning = metadata.exactProtocolVerificationRequired === true ? "protocol warning" : undefined;
  return [title ?? url, warning].filter(Boolean).join(" · ") || undefined;
}

function browserContextPreview(metadata: Record<string, unknown>): string[] {
  const contexts = arrayValue(metadata.browserContexts);
  if (contexts.length > 0) return withMore(contexts.slice(0, 6).flatMap((value) => {
    const context = objectValue(value);
    if (!context) return [];
    return [`${String(context.name ?? "browser")} · ${String(context.status ?? "ready")}`];
  }), contexts.length, 6);
  const context = objectValue(metadata.browserContext);
  if (!context) return [];
  return [`${String(context.name ?? "browser")} · isolated context`];
}

function proxyOutcome(metadata: Record<string, unknown>, summary: string | undefined, text: string): string | undefined {
  const method = stringValue(metadata.method)?.toLowerCase();
  const path = stringValue(metadata.path);
  const status = numberValue(metadata.status);
  if (method || path || status !== undefined) return `${method ?? "request"} ${path ?? ""}${status !== undefined ? ` → ${status}` : ""}`.trim();
  const count = numberValue(metadata.count);
  if (count !== undefined) return `${count} captured flow${count === 1 ? "" : "s"}`;
  return cleanSummary(summary) ?? firstMeaningfulLine(text);
}

function hasWarning(result: ToolResult | undefined, text: string): boolean {
  if (!result) return false;
  if (result.metadata?.emailAction === "wait" && result.metadata.timedOut === true) return true;
  if (result.metadata?.exactProtocolVerificationRequired === true || result.metadata?.snapshotError) return true;
  if (arrayValue(result.metadata?.failures).length > 0) return true;
  if (arrayValue(result.metadata?.sources).some((value) => objectValue(value)?.status !== "ok")) return true;
  return /^(?:warning|source error):/im.test(text);
}

function liveOutcome(text: string): string | undefined {
  const lines = tailSemanticLines(text, 1);
  return lines[0];
}

function semanticLines(text: string, limit: number): string[] {
  return text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0).slice(0, limit);
}

function tailSemanticLines(text: string, limit: number): string[] {
  return text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0).slice(-limit);
}

function boundedPreviewLines(text: string, limit: number): string[] {
  const lines = semanticLines(text, Number.MAX_SAFE_INTEGER);
  if (lines.length <= limit) return lines;
  const head = Math.max(1, Math.floor(limit / 2));
  const tail = Math.max(1, limit - head - 1);
  return [...lines.slice(0, head), `… +${lines.length - head - tail} lines`, ...lines.slice(-tail)];
}

function boundedTailLines(text: string, limit: number): string[] {
  const lines = semanticLines(text, Number.MAX_SAFE_INTEGER);
  if (lines.length <= limit) return lines;
  return [`… ${lines.length - limit} earlier lines`, ...lines.slice(-limit)];
}

function withMore(lines: string[], total: number, shown: number): string[] {
  return total > shown ? [...lines, `… +${total - shown} more`] : lines;
}

function firstMeaningfulLine(text: string): string | undefined {
  return semanticLines(text, 1)[0];
}

function cleanSummary(summary: string | undefined): string | undefined {
  if (!summary?.trim()) return undefined;
  if (/^(?:exit=\d+\s+)?duration=\d+ms(?:\s+timedOut=\w+)?$/i.test(summary.trim())) return undefined;
  return summary.trim().replace(/\bprocessId=[^\s]+/g, "").replace(/\bjobId=[^\s]+/g, "").replace(/\s+/g, " ").trim();
}

function inputObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function urlOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return new URL(value).host; } catch { return undefined; }
}

function hostFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return new URL(value).hostname; } catch { return undefined; }
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} b`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10 * 1_024 ? 1 : 0)} kb`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} mb`;
}
