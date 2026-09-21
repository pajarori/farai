import type { ToolDefinition } from "../../types";
import { assertObject } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import {
  integer,
  mapWithConcurrency,
  projectDiscoveryResult,
  stringList,
  type JsonRecord
} from "./projectdiscovery";

export type HttpProbeRecord = JsonRecord & {
  input: string;
  url?: string;
  finalUrl?: string;
  statusCode?: number;
  title?: string;
  webServer?: string;
  contentType?: string;
  contentLength?: number;
  responseTime?: string;
  host?: string;
  ip?: string;
  cnames: string[];
  technologies: string[];
  cdn?: boolean;
  cdnName?: string;
  cdnType?: string;
  location?: string;
  tls?: JsonRecord;
  failed?: boolean;
  error?: string;
};

function hasScheme(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
}

function probeSchemes(args: Record<string, unknown>): string[] {
  if (!Array.isArray(args.schemes)) return ["https"];
  const schemes = [...new Set(args.schemes.filter((item): item is string => item === "https" || item === "http"))];
  return schemes.length ? schemes : ["https"];
}

function fastProbeTargets(args: Record<string, unknown>): string[] {
  const schemes = probeSchemes(args);
  return stringList(args.targets, "targets").flatMap((target) => hasScheme(target) ? [target] : schemes.map((scheme) => `${scheme}://${target}`));
}

export function parseFastHttpProbeOutput(raw: string): { records: HttpProbeRecord[]; malformed: number } {
  const records: HttpProbeRecord[] = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("curl:")) continue;
    const [input, effectiveUrl, statusText, contentType, lengthText, time, ip, exitText, error] = trimmed.split("\t", 9);
    if (!input || !statusText || !time) {
      malformed += 1;
      continue;
    }
    const statusCode = Number(statusText);
    const contentLength = Number(lengthText);
    const exitCode = Number(exitText);
    const failed = statusCode === 0 || (Number.isFinite(exitCode) && exitCode !== 0);
    const normalizedInput = input.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/:\d+(?:\/|$)/, "$1");
    records.push({
      input: normalizedInput,
      ...(effectiveUrl && effectiveUrl !== input ? { url: effectiveUrl } : {}),
      ...(Number.isInteger(statusCode) && statusCode > 0 ? { statusCode } : {}),
      ...(contentType ? { contentType } : {}),
      ...(Number.isFinite(contentLength) ? { contentLength } : {}),
      ...(time ? { responseTime: `${time}s` } : {}),
      ...(ip ? { ip } : {}),
      ...(failed ? { failed: true, ...(error ? { error: error.slice(0, 240) } : {}) } : {}),
      cnames: [],
      technologies: []
    });
  }
  return { records, malformed };
}

export function selectFastHttpProbeRecords(records: HttpProbeRecord[]): HttpProbeRecord[] {
  const selected = new Map<string, HttpProbeRecord>();
  for (const record of records) {
    const current = selected.get(record.input);
    if (!current || fastRecordRank(record) < fastRecordRank(current)) selected.set(record.input, record);
  }
  return [...selected.values()];
}

async function probeOne(target: string, timeoutMs: number, follow: boolean, parentSignal?: AbortSignal): Promise<HttpProbeRecord> {
  const input = target.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/:\d+(?:\/|$)/, "$1");
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timed out")), timeoutMs);
  const onAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal) parentSignal.addEventListener("abort", onAbort, { once: true });
  const elapsed = () => `${((performance.now() - started) / 1_000).toFixed(3)}s`;
  try {
    const response = await fetch(target, {
      method: "GET",
      redirect: follow ? "follow" : "manual",
      headers: { "user-agent": "Mozilla/5.0 Farai/0.1", accept: "*/*" },
      signal: controller.signal,
      tls: { rejectUnauthorized: false }
    } as RequestInit);
    try { await response.body?.cancel(); } catch { }
    const contentType = response.headers.get("content-type") ?? undefined;
    const contentLength = Number(response.headers.get("content-length") ?? "");
    return {
      input,
      url: target,
      ...(response.url && response.url !== target ? { finalUrl: response.url } : {}),
      statusCode: response.status,
      ...(contentType ? { contentType } : {}),
      ...(Number.isFinite(contentLength) ? { contentLength } : {}),
      responseTime: elapsed(),
      cnames: [],
      technologies: []
    };
  } catch (error) {
    if (parentSignal?.aborted) throw parentSignal.reason ?? error;
    return {
      input,
      failed: true,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 240),
      responseTime: elapsed(),
      cnames: [],
      technologies: []
    };
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", onAbort);
  }
}

export async function nativeFastProbe(args: Record<string, unknown>, signal?: AbortSignal): Promise<HttpProbeRecord[]> {
  const targets = fastProbeTargets(args);
  const timeoutMs = integer(args.timeoutSeconds, 3, 1, 15) * 1_000;
  const concurrency = integer(args.concurrency, 100, 1, 200);
  const follow = args.redirects === "all" || args.redirects === "same_host";
  return mapWithConcurrency(targets, concurrency, (target) => probeOne(target, timeoutMs, follow, signal), signal);
}


export const httpProbeTool: ToolDefinition = {
  name: "service_probe",
  description: "Probe one or many hosts, IPs, or URLs and return normalized live service records. Runs a native concurrent probe directly from the farai host — fast and reliable, bypassing the container network — trying https only for bare hosts and returning status, content type, size, final url, and timing; pass schemes:[\"https\",\"http\"] to also probe http. Use this after subdomain or port discovery; use browser tools for interactive state and http_request for one exact protocol request.",
  inputSchema: {
    type: "object",
    required: ["targets"],
    properties: {
      targets: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 500, uniqueItems: true }] },
      ports: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 100, uniqueItems: true }] },
      schemes: { type: "array", items: { type: "string", enum: ["https", "http"] }, minItems: 1, maxItems: 2, uniqueItems: true, description: "schemes to try for bare hosts; defaults to https only for speed, pass [\"https\",\"http\"] to also probe http" },
      redirects: { type: "string", enum: ["none", "same_host", "all"] },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 60 },
      concurrency: { type: "integer", minimum: 1, maximum: 200 }
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
    const records = selectFastHttpProbeRecords(await nativeFastProbe(args, context.signal));
    const liveServices = records.filter((item) => !item.failed && item.statusCode).length;
    return projectDiscoveryResult(context, {
      tool: "service_probe",
      backend: "farai-native-probe",
      result: { exitCode: 0, stdout: "", stderr: "", durationMs: Math.round(performance.now() - started), timedOut: false },
      records,
      malformed: 0,
      noun: "live service",
      resultCount: liveServices,
      outputLines: records.map(renderHttpProbe),
      metadata: {
        liveServices,
        failedTargets: records.filter((item) => item.failed).length
      }
    });
  }
};

function renderHttpProbe(item: HttpProbeRecord): string {
  if (item.failed) return `failed ${item.input}${item.error ? ` · ${item.error}` : ""}`;
  const target = item.finalUrl ?? item.url ?? item.input;
  return [
    `${item.statusCode ?? "?"} ${target}`,
    item.title,
    item.webServer,
    item.technologies.length ? item.technologies.join(", ") : undefined,
    item.ip,
    item.cdnName ? `${item.cdnName}${item.cdnType ? ` ${item.cdnType}` : ""}` : undefined,
    item.responseTime
  ].filter(Boolean).join(" · ");
}

function fastRecordRank(record: HttpProbeRecord): number {
  const failed = record.failed ? 10 : 0;
  const secure = record.url?.startsWith("https://") ? 0 : 1;
  return failed + secure;
}
