import type { BackendExecResult } from "../backends/types";
import { isIP } from "node:net";
import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { backend } from "../shared/backend";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";

export const SUBDOMAIN_SOURCES = ["subfinder", "certspotter", "crtsh", "amass"] as const;

export type SubdomainSource = typeof SUBDOMAIN_SOURCES[number];
export type SubdomainSourceStatus = {
  source: SubdomainSource;
  status: "ok" | "unavailable" | "failed" | "invalid_response" | "timed_out";
  discovered: number;
  error?: string;
};

export function normalizeDomainInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("domain must not be empty");
  let hostname: string;
  try {
    hostname = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`).hostname;
  } catch {
    throw new Error("domain must be a valid hostname or URL");
  }
  const normalized = hostname.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
  if (isIP(normalized.replace(/^\[|\]$/g, "")) !== 0 || normalized.length > 253 || !normalized.includes(".") || !normalized.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("domain must be a valid DNS hostname");
  }
  return normalized;
}

export function buildSubdomainSourceCommand(source: SubdomainSource, domain: string, timeoutMs: number): string {
  const seconds = Math.max(5, Math.ceil(timeoutMs / 1_000));
  if (source === "subfinder") {
    return `timeout ${seconds}s subfinder -d ${shellQuote(domain)} -silent -json -collect-sources`;
  }
  if (source === "amass") {
    return `timeout ${seconds}s amass enum -passive -norecursive -silent -d ${shellQuote(domain)}`;
  }
  if (source === "certspotter") {
    const url = `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=true&expand=dns_names`;
    return httpJsonCommand(url, seconds);
  }
  const url = `https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`;
  return httpJsonCommand(url, seconds);
}

export function parseSubdomainSourceResult(
  source: SubdomainSource,
  domain: string,
  result: Pick<BackendExecResult, "exitCode" | "stdout" | "stderr" | "timedOut">
): { status: SubdomainSourceStatus; names: string[] } {
  if (result.timedOut || result.exitCode === 124) {
    return { status: { source, status: "timed_out", discovered: 0, error: "source deadline exceeded" }, names: [] };
  }
  if (result.exitCode === 127 || /(?:command not found|not found)/i.test(result.stderr)) {
    return { status: { source, status: "unavailable", discovered: 0, error: `${source} is not installed` }, names: [] };
  }
  if (source === "certspotter" || source === "crtsh") {
    return parseHttpSource(source, domain, result);
  }
  if (result.exitCode !== 0) {
    return { status: { source, status: "failed", discovered: 0, error: compactError(result.stderr || result.stdout) }, names: [] };
  }
  const candidates: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof parsed.host === "string") candidates.push(parsed.host);
        continue;
      } catch {
        return { status: { source, status: "invalid_response", discovered: 0, error: "source returned malformed JSONL" }, names: [] };
      }
    }
    candidates.push(trimmed);
  }
  const names = normalizeSubdomainNames(candidates, domain);
  return { status: { source, status: "ok", discovered: names.length }, names };
}

export function normalizeSubdomainNames(values: string[], domain: string): string[] {
  const suffix = `.${domain}`;
  const names = new Set<string>();
  for (const raw of values) {
    for (const candidate of raw.split(/[\n,]/)) {
      const normalized = candidate.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
      if (!normalized || normalized === domain || !normalized.endsWith(suffix)) continue;
      if (!normalized.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) continue;
      names.add(normalized);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export const subdomainEnumTool: ToolDefinition = {
  name: "subdomain_enum",
  description: "enumerate subdomains once across independent passive sources with structured output, suffix validation, deduplication, and isolated source failures; use this directly for subdomain, passive DNS, CT, and asset discovery instead of tool_search or ad-hoc curl/amass loops",
  inputSchema: {
    type: "object",
    required: ["domain"],
    properties: {
      domain: { type: "string" },
      sources: { type: "array", items: { type: "string", enum: [...SUBDOMAIN_SOURCES] }, uniqueItems: true },
      timeoutMs: { type: "integer", minimum: 5_000, maximum: 90_000 },
      limit: { type: "integer", minimum: 1, maximum: 1_000 }
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 100_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const domain = normalizeDomainInput(asString(args.domain, "domain"));
    const requested = Array.isArray(args.sources) ? args.sources.filter((source): source is SubdomainSource => SUBDOMAIN_SOURCES.includes(source as SubdomainSource)) : [];
    const sources = [...new Set(requested.length ? requested : ["subfinder", "certspotter", "crtsh"] as SubdomainSource[])];
    const timeoutMs = typeof args.timeoutMs === "number" && Number.isInteger(args.timeoutMs) ? Math.max(5_000, Math.min(90_000, args.timeoutMs)) : 45_000;
    const limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? Math.max(1, Math.min(1_000, args.limit)) : 200;
    const { onOutputChunk: _onOutputChunk, ...quietContext } = context;
    const kali = backend(quietContext);
    const results = await Promise.all(sources.map(async (source) => {
      const result = await kali.exec(buildSubdomainSourceCommand(source, domain, timeoutMs), timeoutMs + 5_000, context.signal, 2_000_000);
      return parseSubdomainSourceResult(source, domain, result);
    }));
    const names = [...new Set(results.flatMap((item) => item.names))].sort((left, right) => left.localeCompare(right)).slice(0, limit);
    const sourceStatuses = results.map((item) => item.status);
    const successfulSources = sourceStatuses.filter((item) => item.status === "ok").length;
    const output = [
      `domain: ${domain}`,
      `subdomains: ${names.length}`,
      `sources: ${sourceStatuses.map((item) => `${item.source}=${item.status}(${item.discovered})`).join(", ")}`,
      ...(names.length ? ["", ...names] : []),
      ...sourceStatuses.filter((item) => item.error).map((item) => `source error: ${item.source}: ${item.error}`)
    ].join("\n");
    return {
      ok: successfulSources > 0,
      summary: successfulSources > 0
        ? `found ${names.length} unique subdomains from ${successfulSources}/${sources.length} passive sources`
        : `all ${sources.length} passive subdomain sources failed`,
      output,
      metadata: {
        domain,
        sources: sourceStatuses,
        discoveredSubdomains: names,
        truncated: results.reduce((total, item) => total + item.names.length, 0) > names.length
      }
    };
  }
};

function parseHttpSource(
  source: "certspotter" | "crtsh",
  domain: string,
  result: Pick<BackendExecResult, "exitCode" | "stdout" | "stderr">
): { status: SubdomainSourceStatus; names: string[] } {
  if (result.exitCode !== 0) {
    return { status: { source, status: "failed", discovered: 0, error: compactError(result.stderr || result.stdout) }, names: [] };
  }
  const marker = "\n__FARAI_HTTP__";
  const markerAt = result.stdout.lastIndexOf(marker);
  if (markerAt < 0) {
    return { status: { source, status: "invalid_response", discovered: 0, error: "missing HTTP response metadata" }, names: [] };
  }
  const body = result.stdout.slice(0, markerAt).trim();
  const [statusText = "0", contentType = ""] = result.stdout.slice(markerAt + marker.length).trim().split("\t", 2);
  const statusCode = Number(statusText);
  if (statusCode < 200 || statusCode >= 300) {
    return { status: { source, status: "failed", discovered: 0, error: `HTTP ${statusCode || "unknown"}` }, names: [] };
  }
  if (!contentType.toLowerCase().includes("json")) {
    return { status: { source, status: "invalid_response", discovered: 0, error: `unexpected content-type ${contentType || "unknown"}` }, names: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: { source, status: "invalid_response", discovered: 0, error: "response body is not valid JSON" }, names: [] };
  }
  if (!Array.isArray(parsed)) {
    return { status: { source, status: "invalid_response", discovered: 0, error: "response JSON is not an array" }, names: [] };
  }
  const candidates = parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (source === "certspotter") return Array.isArray(record.dns_names) ? record.dns_names.filter((value): value is string => typeof value === "string") : [];
    return typeof record.name_value === "string" ? [record.name_value] : [];
  });
  const names = normalizeSubdomainNames(candidates, domain);
  return { status: { source, status: "ok", discovered: names.length }, names };
}

function httpJsonCommand(url: string, seconds: number): string {
  return [
    "curl",
    "-sS",
    "--max-time",
    String(seconds),
    "--header",
    shellQuote("Accept: application/json"),
    "--write-out",
    shellQuote("\\n__FARAI_HTTP__%{http_code}\\t%{content_type}"),
    shellQuote(url)
  ].join(" ");
}

function compactError(value: string): string {
  const compact = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return compact.slice(0, 240) || "source command failed without an error message";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
