import type { ToolDefinition } from "../../types";
import { assertObject } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { integer, mapWithConcurrency, projectDiscoveryResult, stringList, type JsonRecord } from "./projectdiscovery";

export type WebCrawlRecord = JsonRecord & {
  url: string;
  method: string;
  statusCode?: number;
  depth?: number;
  contentType?: string;
  contentLength?: number;
  technologies: string[];
  forms: number;
  xhrRequests: number;
  failed?: boolean;
  error?: string;
};

function hasScheme(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
}

function seedUrl(target: string): string {
  return hasScheme(target) ? target : `https://${target}`;
}

function apexOf(hostname: string): string {
  const labels = hostname.toLowerCase().split(".").filter(Boolean);
  return labels.length <= 2 ? labels.join(".") : labels.slice(-2).join(".");
}

function inScope(candidate: URL, seeds: URL[], scope: string): boolean {
  if (scope === "none") return true;
  return seeds.some((seed) => {
    if (scope === "fqdn") return candidate.hostname.toLowerCase() === seed.hostname.toLowerCase();
    const apex = apexOf(seed.hostname);
    const host = candidate.hostname.toLowerCase();
    return host === apex || host.endsWith(`.${apex}`);
  });
}

function extractLinks(baseUrl: string, html: string): string[] {
  const links = new Set<string>();
  const pattern = /(?:href|src)\s*=\s*["']([^"'#\s]+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const raw = match[1];
    if (!raw || raw.startsWith("data:") || raw.startsWith("javascript:") || raw.startsWith("mailto:") || raw.startsWith("tel:")) continue;
    try {
      links.add(new URL(raw, baseUrl).toString());
    } catch { }
  }
  return [...links];
}

async function fetchPage(url: string, timeoutMs: number, maxBytes: number, signal?: AbortSignal): Promise<{ record: WebCrawlRecord; html: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timed out")), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 Farai/0.1", accept: "text/html,*/*" },
      signal: controller.signal,
      tls: { rejectUnauthorized: false }
    } as RequestInit);
    const contentType = response.headers.get("content-type") ?? undefined;
    const isHtml = contentType ? /html|xml/i.test(contentType) : false;
    let html = "";
    if (isHtml && response.body) {
      const buffer = await response.arrayBuffer();
      html = new TextDecoder().decode(buffer.byteLength > maxBytes ? buffer.slice(0, maxBytes) : buffer);
    } else {
      try { await response.body?.cancel(); } catch { }
    }
    const headerLength = Number(response.headers.get("content-length") ?? "");
    const contentLength: number | undefined = Number.isFinite(headerLength) ? headerLength : html ? html.length : undefined;
    return {
      record: {
        url: response.url || url,
        method: "GET",
        statusCode: response.status,
        ...(contentType ? { contentType } : {}),
        ...(contentLength !== undefined ? { contentLength } : {}),
        technologies: [],
        forms: html ? (html.match(/<form\b/gi)?.length ?? 0) : 0,
        xhrRequests: 0
      },
      html
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return {
      record: { url, method: "GET", failed: true, error: (error instanceof Error ? error.message : String(error)).slice(0, 240), technologies: [], forms: 0, xhrRequests: 0 } as WebCrawlRecord,
      html: ""
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

export async function nativeWebCrawl(args: Record<string, unknown>, signal?: AbortSignal): Promise<WebCrawlRecord[]> {
  const targets = stringList(args.targets, "targets", 100).map(seedUrl);
  const seeds = targets.flatMap((target) => { try { return [new URL(target)]; } catch { return []; } });
  const depthLimit = integer(args.depth, 2, 1, 5);
  const maxPages = integer(args.maxPagesPerDomain, 200, 1, 2_000);
  const timeoutMs = integer(args.timeoutSeconds, 8, 1, 60) * 1_000;
  const maxBytes = integer(args.maxResponseBytes, 2_097_152, 1_024, 8_388_608);
  const concurrency = integer(args.concurrency, 10, 1, 50);
  const scope = typeof args.scope === "string" ? args.scope : "registrable_domain";
  const visited = new Set<string>();
  const records: WebCrawlRecord[] = [];
  let frontier = [...new Set(targets)];
  for (let depth = 0; depth <= depthLimit && frontier.length > 0 && records.length < maxPages; depth += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error("cancelled");
    const batch = frontier.filter((url) => !visited.has(url)).slice(0, maxPages - records.length);
    for (const url of batch) visited.add(url);
    const results = await mapWithConcurrency(batch, concurrency, (url) => fetchPage(url, timeoutMs, maxBytes, signal), signal);
    const next = new Set<string>();
    for (const { record, html } of results) {
      records.push({ ...record, depth });
      if (depth < depthLimit && html) {
        for (const link of extractLinks(record.url, html)) {
          if (visited.has(link)) continue;
          let candidate: URL;
          try { candidate = new URL(link); } catch { continue; }
          if (candidate.protocol !== "http:" && candidate.protocol !== "https:") continue;
          if (inScope(candidate, seeds, scope)) next.add(candidate.toString());
        }
      }
    }
    frontier = [...next];
  }
  return records;
}

export const webCrawlTool: ToolDefinition = {
  name: "web_crawl",
  description: "Crawl one or many authorized web targets with a fast native host crawler and return normalized discovered URLs, methods, status codes, content types, and form counts without embedding response bodies. Static crawl only (follows same-scope links up to a bounded depth); use browser tools for JavaScript-rendered or authenticated workflows.",
  inputSchema: {
    type: "object",
    required: ["targets"],
    properties: {
      targets: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100, uniqueItems: true }] },
      depth: { type: "integer", minimum: 1, maximum: 5 },
      scope: { type: "string", enum: ["fqdn", "registrable_domain", "none"] },
      maxPagesPerDomain: { type: "integer", minimum: 1, maximum: 2_000 },
      maxResponseBytes: { type: "integer", minimum: 1_024, maximum: 8_388_608 },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 60 },
      concurrency: { type: "integer", minimum: 1, maximum: 50 }
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: Number.POSITIVE_INFINITY,
  parallel: true,
  visibility: "recon",
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const started = performance.now();
    const records = await nativeWebCrawl(args, context.signal);
    return projectDiscoveryResult(context, {
      tool: "web_crawl",
      backend: "farai-native-crawl",
      result: { exitCode: 0, stdout: "", stderr: "", durationMs: Math.round(performance.now() - started), timedOut: false },
      records,
      malformed: 0,
      noun: "endpoint",
      outputLines: records.map(renderWebCrawl),
      metadata: {
        uniqueUrls: new Set(records.map((item) => item.url)).size,
        forms: records.reduce((total, item) => total + item.forms, 0),
        failedRequests: records.filter((item) => item.failed).length
      }
    });
  }
};

function renderWebCrawl(item: WebCrawlRecord): string {
  if (item.failed) return `failed ${item.method} ${item.url}${item.error ? ` · ${item.error}` : ""}`;
  return [
    `${item.method} ${item.url}`,
    item.statusCode,
    item.contentType,
    item.forms ? `${item.forms} form${item.forms === 1 ? "" : "s"}` : undefined
  ].filter((value) => value !== undefined && value !== "").join(" · ");
}
