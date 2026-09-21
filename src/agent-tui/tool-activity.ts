import type { ToolResult } from "../types";
import { parseDirectoryResults, parseNmap, splitHttpResponse } from "./tool-renderers";
import { truncateTerminal } from "./terminal-text";
import {
  TOOL_TITLE_MAX_WIDTH,
  canonicalToolLifecycleState,
  compactToolText,
  isActiveToolStatus,
  toolDefinition,
  toolTitle
} from "./tool-presentation";
import { resolveToolLifecycle, type ToolLifecycleFamily, type ToolLifecycleInput, type ToolLifecyclePolicy } from "./tool-lifecycle";
import { collapsedToolError, collapsedToolLines, collapsedToolPreview, collapsedToolText } from "./collapsed-tool-text";

export type ToolActivityFamily = ToolLifecycleFamily;

export type ToolActivityPresentation = {
  state: import("../types").ToolLifecycleState;
  family: ToolActivityFamily;
  title: string;
  compact: string;
  noun: string;
  outcome?: string;
  preview: string[];
  groupKey?: string;
  groupPast?: string;
  groupActive?: string;
  groupMutations?: boolean;
  groupItem?: string;
  groupNoun?: string;
  groupMaxItems?: number;
  detail?: ToolLifecyclePolicy["detail"];
  showOutcome?: boolean;
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

function isCommandTool(tool: string): boolean {
  return tool === "command_run";
}

function commandText(tool: string, args: Record<string, unknown>): string | undefined {
  return stringValue(tool === "command_run" ? args.command ?? args.cmd : args.command);
}

export function presentToolActivity(input: ToolActivityInput): ToolActivityPresentation {
  const definition = toolDefinition(input.tool);
  const lifecycleInput: ToolLifecycleInput = {
    tool: input.tool,
    args: input.args,
    status: input.status,
    metadata: input.toolResult?.metadata ?? {},
    ...(input.toolResult ? { result: input.toolResult } : {}),
    warning: hasWarning(input.toolResult, input.result ?? input.fullResult ?? ""),
    ...(definition ? { definitionMutates: definition.mutates } : {})
  };
  const lifecycle = resolveToolLifecycle(lifecycleInput);
  const tool = lifecycle.tool;
  const args = lifecycle.args;
  const state = canonicalToolLifecycleState(input.status, input.toolResult);
  const active = state === "pending" || state === "running" || state === "background";
  const text = active ? input.liveOutput ?? input.result ?? "" : input.result ?? input.fullResult ?? "";
  const metadata = input.toolResult?.metadata ?? {};
  const family = lifecycle.family;
  const rawTitle = tool === "email_wait" && !active && metadata.timedOut === true
    ? emailWaitTimeoutTitle(args)
    : toolTitle(tool, args, input.status, TOOL_TITLE_MAX_WIDTH);
  const warning = hasWarning(input.toolResult, text);
  const title = collapsedToolText(rawTitle) ?? (active ? `running ${lifecycle.noun}` : `completed ${lifecycle.noun}`);
  const preview = collapsedToolLines(toolPreview(tool, args, text, metadata, active));
  const outcome = collapsedToolText(toolOutcome(tool, args, text, metadata, input.toolResult, active));
  const groupPast = collapsedToolText(lifecycle.groupPast);
  const groupActive = collapsedToolText(lifecycle.groupActive);
  const groupItem = collapsedToolText(lifecycle.groupItem);
  return {
    state,
    family,
    title,
    compact: compactActivityLabel(tool, args, title),
    noun: lifecycle.noun,
    ...(outcome ? { outcome } : {}),
    preview,
    ...(lifecycle.groupKey ? { groupKey: lifecycle.groupKey } : {}),
    ...(groupPast ? { groupPast } : {}),
    ...(groupActive ? { groupActive } : {}),
    ...(lifecycle.groupMutations !== undefined ? { groupMutations: lifecycle.groupMutations } : {}),
    ...(groupItem ? { groupItem } : {}),
    ...(lifecycle.groupNoun ? { groupNoun: lifecycle.groupNoun } : {}),
    ...(lifecycle.groupMaxItems !== undefined ? { groupMaxItems: lifecycle.groupMaxItems } : {}),
    ...(lifecycle.detail ? { detail: lifecycle.detail } : {}),
    ...(lifecycle.showOutcome !== undefined ? { showOutcome: lifecycle.showOutcome } : {}),
    standalone: lifecycle.standalone,
    warning
  };
}

export function activityStatus(items: readonly ToolActivityInput[]): "running" | "error" | "done" {
  const states = items.map((item) => canonicalToolLifecycleState(item.status, item.toolResult));
  if (states.some((state) => state === "pending" || state === "running" || state === "background")) return "running";
  if (states.some((state) => state === "failed" || state === "cancelled")) return "error";
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

function compactActivityLabel(tool: string, args: Record<string, unknown>, title: string): string {
  void tool;
  void args;
  return compactToolText(title, TOOL_TITLE_MAX_WIDTH);
}

function emailWaitTimeoutTitle(args: Record<string, unknown>): string {
  const filter = stringValue(args.subject) ?? stringValue(args.from);
  return truncateTerminal(`no matching email${filter ? ` · ${compactToolText(filter)}` : ""}`, TOOL_TITLE_MAX_WIDTH);
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
  if (result?.ok === false) return firstMeaningfulLine(text) ?? cleanSummary(result.summary) ?? collapsedToolError(result.errorCategory);
  if (tool === "network_scan" || (isCommandTool(tool) && /^\s*(?:sudo\s+)?nmap\b/i.test(commandText(tool, args) ?? ""))) {
    const ports = parseNmap(text);
    if (ports.length > 0) return ports.slice(0, 6).map((row) => `${row.port}/${row.service}`).join(", ") + (ports.length > 6 ? ` · +${ports.length - 6}` : "");
    const discovered = numberValue(metadata.recordCount) ?? arrayValue(metadata.discoveredPorts).length;
    if (discovered > 0) return `${discovered} open port${discovered === 1 ? "" : "s"}`;
  }
  if (tool === "asset_subdomains") {
    const names = arrayValue(metadata.discoveredSubdomains);
    const sources = arrayValue(metadata.sources);
    const warnings = sources.filter((value) => objectValue(value)?.status !== "ok").length;
    return `${names.length} subdomain${names.length === 1 ? "" : "s"}${warnings ? ` · ${warnings} source warning${warnings === 1 ? "" : "s"}` : ""}`;
  }
  const structuredRecon = structuredReconOutcome(tool, metadata);
  if (structuredRecon) return structuredRecon;
  if (tool === "web_directory") {
    const dirs = parseDirectoryResults(text);
    if (dirs.length > 0) return `${dirs.length} path${dirs.length === 1 ? "" : "s"}`;
    const summarized = text.split("\n").filter((line) => /^\d{3}\s+https?:\/\//.test(line.trim()));
    if (summarized.length > 0) return `${summarized.length} path${summarized.length === 1 ? "" : "s"}`;
  }
  if (tool === "http_request") {
    const http = splitHttpResponse(text);
    if (http.status) return http.status.replace(/^HTTP\/\S+\s+/, "").toLowerCase();
  }
  if (tool === "web_search") {
    const results = arrayValue(metadata.results);
    const provider = stringValue(metadata.provider);
    return `${results.length} result${results.length === 1 ? "" : "s"}${provider ? ` · ${provider}` : ""}`;
  }
  if (tool === "knowledge_search") {
    const hits = numberValue(metadata.hits) ?? 0;
    return `${hits} found`;
  }
  if (tool === "web_fetch") {
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
    return email ? String(email.address ?? "email") : cleanSummary(result?.summary);
  }
  if (tool === "email_inbox") return `${arrayValue(metadata.messages).length} message${arrayValue(metadata.messages).length === 1 ? "" : "s"}`;
  if (tool === "email_read" || tool === "email_wait") {
    const message = objectValue(metadata.message);
    return message ? `${String(message.from ?? "sender")} · ${String(message.subject ?? "email")}` : cleanSummary(result?.summary);
  }
  if (tool === "file_read") return cleanSummary(result?.summary) ?? `${semanticLines(text, Number.MAX_SAFE_INTEGER).length} lines`;
  if (tool === "file_list") {
    const count = semanticLines(text, Number.MAX_SAFE_INTEGER).length;
    return `${count} ${count === 1 ? "entry" : "entries"}`;
  }
  if (tool === "file_search") {
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
  if (tool === "image_read") return result?.summary?.replace(/^image\s+/i, "") ?? firstMeaningfulLine(text);
  if (isCommandTool(tool)) {
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
  if (tool === "network_scan" || (isCommandTool(tool) && /^\s*(?:sudo\s+)?nmap\b/i.test(commandText(tool, args) ?? ""))) {
    const rows = parseNmap(text);
    if (rows.length > 0) return withMore(rows.slice(0, 5).map((row) => `${row.port}/${row.proto}  ${row.service}${row.version ? `  ${row.version}` : ""}`), rows.length, 5);
  }
  if (tool === "asset_subdomains") {
    const names = arrayValue(metadata.discoveredSubdomains).map(String);
    const errors = arrayValue(metadata.sources).flatMap((value) => {
      const source = objectValue(value);
      return source && source.status !== "ok" ? [`warning: ${String(source.source ?? "source")} ${String(source.error ?? source.status)}`] : [];
    });
    return [...withMore(names.slice(0, 4), names.length, 4), ...errors.slice(0, 2)];
  }
  if (tool === "knowledge_search") return [];
  const structuredRecon = structuredReconPreview(tool, metadata);
  if (structuredRecon.length) return structuredRecon;
  if (tool === "web_directory") {
    const rows = parseDirectoryResults(text);
    if (rows.length > 0) return withMore(rows.slice(0, 5).map((row) => `${row.status}  ${row.url}`), rows.length, 5);
  }
  if (tool === "web_search") {
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
    if (flow) return [flow];
  }
  if (active) return collapsedToolPreview(text, 4, true);
  return collapsedToolPreview(text, 5);
}

function structuredReconOutcome(tool: string, metadata: Record<string, unknown>): string | undefined {
  const records = numberValue(metadata.recordCount) ?? arrayValue(metadata.records).length;
  if (tool === "dns_resolve") {
    const resolved = numberValue(metadata.resolvedNames) ?? records;
    const wildcard = numberValue(metadata.wildcardNames) ?? 0;
    const timedOut = numberValue(metadata.timedOutNames) ?? 0;
    const errors = numberValue(metadata.errorNames) ?? 0;
    return `${resolved} resolved name${resolved === 1 ? "" : "s"}${wildcard ? ` · ${wildcard} wildcard` : ""}${timedOut ? ` · ${timedOut} timed out` : ""}${errors ? ` · ${errors} failed` : ""}`;
  }
  if (tool === "service_probe") {
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
  if (tool === "tls_inspect") {
    const successful = numberValue(metadata.successfulProbes) ?? records;
    const expiring = numberValue(metadata.expiringCertificates) ?? 0;
    return `${successful} tls endpoint${successful === 1 ? "" : "s"}${expiring ? ` · ${expiring} expiring soon` : ""}`;
  }
  if (tool === "url_discover") {
    const urls = numberValue(metadata.uniqueUrls) ?? records;
    const sourceHealth = arrayValue(metadata.sources).flatMap((value) => {
      const source = objectValue(value);
      return source ? [source] : [];
    });
    const failed = sourceHealth.filter((source) => source.status === "failed" || source.status === "unknown").length;
    const certainty = stringValue(metadata.certainty);
    if (urls === 0 && certainty === "confirmed_empty") return "0 urls · all sources checked";
    return `${urls} url${urls === 1 ? "" : "s"}${failed ? ` · ${failed} source${failed === 1 ? "" : "s"} degraded` : ""}`;
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
  if (tool === "network_scan") return `${String(item.host ?? "host")}:${String(item.port ?? "?")}/${String(item.protocol ?? "tcp")}${item.service ? ` · ${String(item.service)}` : ""}`;
  if (tool === "dns_resolve") {
    const recordMap = objectValue(item.records);
    const answers = recordMap ? Object.entries(recordMap).flatMap(([type, values]) => arrayValue(values).map((value) => `${type.toUpperCase()} ${String(value)}`)).slice(0, 4) : [];
    if (item.wildcard === true) return `${String(item.name ?? "name")} · wildcard DNS match`;
    if (answers.length) return `${String(item.name ?? "name")} · ${answers.join(" · ")}`;
    if (item.status === "not_found") return `${String(item.name ?? "name")} · not found`;
    if (item.status === "timeout") return `${String(item.name ?? "name")} · resolver timeout`;
    if (item.status === "error") return `${String(item.name ?? "name")} · resolver error`;
    return `${String(item.name ?? "name")} · no answers`;
  }
  if (tool === "service_probe") {
    if (item.failed === true) return `failed ${String(item.input ?? "target")}${item.error ? ` · ${String(item.error)}` : ""}`;
    return [item.statusCode ?? "?", item.finalUrl ?? item.url ?? item.input, item.title, item.webServer].filter((value) => value !== undefined && value !== "").map(String).join(" · ");
  }
  if (tool === "web_crawl") return [item.method ?? "GET", item.url, item.statusCode, item.tag].filter((value) => value !== undefined && value !== "").map(String).join(" · ");
  if (tool === "vulnerability_scan") return [String(item.severity ?? "unknown").toUpperCase(), item.templateId, item.name, item.matchedAt].filter((value) => value !== undefined && value !== "").map(String).join(" · ");
  if (tool === "tls_inspect") return [`${String(item.host ?? "host")}${item.port ? `:${String(item.port)}` : ""}`, item.version, item.cipher, item.commonName].filter((value) => value !== undefined && value !== "").map(String).join(" · ");
  if (tool === "url_discover") return [item.url, arrayValue(item.sources).join(", ")].filter((value) => value !== undefined && value !== "").map(String).join(" · ");
  if (tool === "vulnerability_lookup") return [item.id, String(item.severity ?? "").toUpperCase(), item.title, item.cvssScore !== undefined ? `cvss ${String(item.cvssScore)}` : undefined].filter((value) => value !== undefined && value !== "").map(String).join(" · ");
  return Object.values(item).filter((value) => typeof value === "string" || typeof value === "number").slice(0, 4).map(String).join(" · ");
}

function emailResourcePreview(values: unknown[]): string[] {
  const rows = values.flatMap((value) => {
    const email = objectValue(value);
    if (!email) return [];
    const roles = arrayValue(email.roles).map(String).join(" · ");
    return [`${String(email.address ?? "email")} · ${String(email.type ?? email.provider ?? "email")}${roles ? ` · ${roles}` : ""}`];
  });
  return withMore(rows.slice(0, 6), rows.length, 6);
}

function emailMessagePreview(values: unknown[]): string[] {
  const rows = values.flatMap((value) => {
    const message = objectValue(value);
    if (!message) return [];
    return [`${String(message.from ?? "sender")} · ${String(message.subject ?? "(no subject)")}`];
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
  const lines = collapsedToolPreview(text, 1, true);
  return lines[0];
}

function semanticLines(text: string, limit: number): string[] {
  return text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0).slice(0, limit);
}

function withMore(lines: string[], total: number, shown: number): string[] {
  return total > shown ? [...lines, `… +${total - shown} more`] : lines;
}

function firstMeaningfulLine(text: string): string | undefined {
  return collapsedToolPreview(text, 1)[0];
}

function cleanSummary(summary: string | undefined): string | undefined {
  if (!summary?.trim()) return undefined;
  if (/^exit=\d+$/i.test(summary.trim())) return undefined;
  if (/^(?:exit=\d+\s+)?duration=\d+ms(?:\s+timedOut=\w+)?$/i.test(summary.trim())) return undefined;
  return collapsedToolText(summary);
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

function hostFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return new URL(value).hostname; } catch { return undefined; }
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} b`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10 * 1_024 ? 1 : 0)} kb`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} mb`;
}
