import type { ToolDefinition } from "../../types";
import { assertObject } from "../../utils";
import { timeoutBackgroundResult } from "../shared/background-result";
import { backend } from "../shared/backend";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { inputFileCommand, integer, parseJsonLines, projectDiscoveryResult, record, stringList, text, textArray, type JsonRecord } from "./projectdiscovery";

export type WebCrawlRecord = JsonRecord & {
  url: string;
  method: string;
  statusCode?: number;
  source?: string;
  tag?: string;
  depth?: number;
  contentLength?: number;
  technologies: string[];
  forms: number;
  xhrRequests: number;
  error?: string;
};

export function buildWebCrawlCommand(args: Record<string, unknown>): string {
  const targets = stringList(args.targets, "targets", 100);
  const depth = integer(args.depth, 3, 1, 10);
  const timeout = integer(args.timeoutSeconds, 10, 1, 60);
  const maxPages = integer(args.maxPagesPerDomain, 1_000, 1, 20_000);
  const maxResponseSize = integer(args.maxResponseBytes, 4_194_304, 1_024, 16_777_216);
  const rateLimit = integer(args.rateLimit, 100, 1, 1_000);
  const concurrency = integer(args.concurrency, 10, 1, 100);
  const parallelism = integer(args.parallelism, 5, 1, 50);
  const command = [
    "-jsonl", "-silent", "-nc", "-duc", "-or", "-ob", "-td", "-fx",
    "-d", String(depth), "-timeout", String(timeout), "-mdp", String(maxPages),
    "-mrs", String(maxResponseSize), "-rl", String(rateLimit), "-c", String(concurrency), "-p", String(parallelism)
  ];
  if (args.javascript !== false) command.push("-jc");
  if (args.ignoreQueryParameters === true) command.push("-iqp");
  if (args.filterSimilar === true) command.push("-fsu");
  const scope = typeof args.scope === "string" ? args.scope : "registrable_domain";
  if (scope === "none") command.push("-ns");
  else command.push("-fs", scope === "fqdn" ? "fqdn" : "rdn");
  const knownFiles = typeof args.knownFiles === "string" ? args.knownFiles : "none";
  if (knownFiles !== "none") command.push("-kf", knownFiles === "all" ? "all" : knownFiles === "robots" ? "robotstxt" : "sitemapxml");
  if (args.headless === true) command.push("-hl", "-xhr", "-scp", "/usr/bin/chromium", "-nos");
  return inputFileCommand("katana", command, targets, "-u");
}

export function parseWebCrawlOutput(raw: string): { records: WebCrawlRecord[]; malformed: number } {
  const parsed = parseJsonLines(raw);
  return { records: parsed.records.map(normalizeWebCrawl), malformed: parsed.malformed };
}

export const webCrawlTool: ToolDefinition = {
  name: "web_crawl",
  description: "Crawl one or many authorized web targets with ProjectDiscovery katana and return normalized discovered URLs, methods, status codes, technologies, forms, and XHR counts without embedding response bodies. Use this for breadth-first application mapping after live HTTP services are known; enable headless mode only when JavaScript execution is necessary, and use browser tools for interactive workflows or authenticated state.",
  inputSchema: {
    type: "object",
    required: ["targets"],
    properties: {
      targets: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100, uniqueItems: true }] },
      depth: { type: "integer", minimum: 1, maximum: 10 },
      scope: { type: "string", enum: ["fqdn", "registrable_domain", "none"] },
      javascript: { type: "boolean" },
      headless: { type: "boolean" },
      knownFiles: { type: "string", enum: ["none", "robots", "sitemap", "all"] },
      ignoreQueryParameters: { type: "boolean" },
      filterSimilar: { type: "boolean" },
      maxPagesPerDomain: { type: "integer", minimum: 1, maximum: 20_000 },
      maxResponseBytes: { type: "integer", minimum: 1_024, maximum: 16_777_216 },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 60 },
      rateLimit: { type: "integer", minimum: 1, maximum: 1_000 },
      concurrency: { type: "integer", minimum: 1, maximum: 100 },
      parallelism: { type: "integer", minimum: 1, maximum: 50 }
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 600_000,
  parallel: true,
  visibility: "recon",
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const kali = backend(context);
    const result = await kali.exec(buildWebCrawlCommand(args), 595_000, context.signal, 32_000_000);
    const converted = timeoutBackgroundResult("web_crawl", kali, result);
    if (converted) return converted;
    const parsed = parseWebCrawlOutput(result.stdout);
    return projectDiscoveryResult(context, {
      tool: "web_crawl",
      backend: "katana",
      result,
      records: parsed.records,
      malformed: parsed.malformed,
      noun: "endpoint",
      outputLines: parsed.records.map(renderWebCrawl),
      metadata: {
        uniqueUrls: new Set(parsed.records.map((item) => item.url)).size,
        forms: parsed.records.reduce((total, item) => total + item.forms, 0),
        xhrRequests: parsed.records.reduce((total, item) => total + item.xhrRequests, 0)
      }
    });
  }
};

function normalizeWebCrawl(value: JsonRecord): WebCrawlRecord {
  const request = record(value.request);
  const response = record(value.response);
  const url = text(request?.endpoint) ?? text(request?.url) ?? text(value.endpoint) ?? text(value.url) ?? "unknown";
  const source = text(value.source);
  const tag = text(value.tag);
  const error = text(value.error);
  const statusCode = typeof response?.status_code === "number" ? response.status_code : typeof value.status_code === "number" ? value.status_code : undefined;
  const depth = typeof value.depth === "number" ? value.depth : undefined;
  const contentLength = typeof response?.content_length === "number" ? response.content_length : undefined;
  return {
    url,
    method: text(request?.method) ?? text(value.method) ?? "GET",
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(source ? { source } : {}),
    ...(tag ? { tag } : {}),
    ...(depth !== undefined ? { depth } : {}),
    ...(contentLength !== undefined ? { contentLength } : {}),
    technologies: textArray(value.technologies ?? response?.technologies),
    forms: Array.isArray(value.forms) ? value.forms.length : 0,
    xhrRequests: Array.isArray(value.xhr_requests) ? value.xhr_requests.length : 0,
    ...(error ? { error } : {})
  };
}

function renderWebCrawl(item: WebCrawlRecord): string {
  return [
    `${item.method} ${item.url}`,
    item.statusCode,
    item.tag,
    item.technologies.length ? item.technologies.join(", ") : undefined,
    item.forms ? `${item.forms} form${item.forms === 1 ? "" : "s"}` : undefined,
    item.xhrRequests ? `${item.xhrRequests} xhr` : undefined,
    item.error
  ].filter((value) => value !== undefined && value !== "").join(" · ");
}
