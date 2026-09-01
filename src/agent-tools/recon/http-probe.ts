import type { ToolDefinition } from "../../types";
import { assertObject } from "../../utils";
import { timeoutBackgroundResult } from "../shared/background-result";
import { backend } from "../shared/backend";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import {
  booleanValue,
  inputFileCommand,
  integer,
  optionalStringList,
  parseJsonLines,
  projectDiscoveryResult,
  record,
  stringList,
  text,
  textArray,
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

export function buildHttpProbeCommand(args: Record<string, unknown>): string {
  const targets = stringList(args.targets, "targets");
  const timeout = integer(args.timeoutSeconds, 10, 1, 60);
  const rateLimit = integer(args.rateLimit, 100, 1, 1_000);
  const concurrency = integer(args.concurrency, 50, 1, 200);
  const command = [
    "-json", "-silent", "-nc", "-duc", "-sc", "-title", "-td", "-server", "-ct", "-cl", "-location", "-rt", "-ip", "-cname", "-asn", "-cdn",
    "-timeout", String(timeout), "-rl", String(rateLimit), "-threads", String(concurrency)
  ];
  if (args.includeTls !== false) command.push("-tls-grab");
  const redirect = typeof args.redirects === "string" ? args.redirects : "same_host";
  if (redirect === "same_host") command.push("-fhr");
  if (redirect === "all") command.push("-fr");
  const ports = optionalStringList(args.ports, "ports", 100);
  if (ports.length) command.push("-p", ports.join(","));
  if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
    for (const [name, value] of Object.entries(args.headers as Record<string, unknown>)) {
      if (typeof value !== "string" || !name.trim() || /[\r\n]/.test(name) || /[\r\n]/.test(value)) throw new Error("headers must contain single-line string names and values");
      command.push("-H", `${name}: ${value}`);
    }
  }
  return inputFileCommand("httpx", command, targets, "-l");
}

export function parseHttpProbeOutput(raw: string): { records: HttpProbeRecord[]; malformed: number } {
  const parsed = parseJsonLines(raw);
  return { records: parsed.records.map(normalizeHttpProbe), malformed: parsed.malformed };
}

export const httpProbeTool: ToolDefinition = {
  name: "http_probe",
  description: "Probe one or many hosts, IPs, or URLs with ProjectDiscovery httpx and return normalized live HTTP service records including status, final URL, title, server, technologies, IP/CNAME, CDN/WAF classification, timing, and optional TLS certificate metadata. Use this after subdomain or port discovery; use browser tools for interactive state and http_request for one exact protocol request.",
  inputSchema: {
    type: "object",
    required: ["targets"],
    properties: {
      targets: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 500, uniqueItems: true }] },
      ports: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 100, uniqueItems: true }] },
      redirects: { type: "string", enum: ["none", "same_host", "all"] },
      includeTls: { type: "boolean" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 60 },
      rateLimit: { type: "integer", minimum: 1, maximum: 1_000 },
      concurrency: { type: "integer", minimum: 1, maximum: 200 }
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 180_000,
  parallel: true,
  visibility: "recon",
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const kali = backend(context);
    const result = await kali.exec(buildHttpProbeCommand(args), 175_000, context.signal, 16_000_000);
    const converted = timeoutBackgroundResult("http_probe", kali, result);
    if (converted) return converted;
    const parsed = parseHttpProbeOutput(result.stdout);
    return projectDiscoveryResult(context, {
      tool: "http_probe",
      backend: "httpx",
      result,
      records: parsed.records,
      malformed: parsed.malformed,
      noun: "service",
      outputLines: parsed.records.map(renderHttpProbe),
      metadata: {
        liveServices: parsed.records.filter((item) => !item.failed).length,
        failedTargets: parsed.records.filter((item) => item.failed).length
      }
    });
  }
};

function normalizeHttpProbe(value: JsonRecord): HttpProbeRecord {
  const url = text(value.url);
  const finalUrl = text(value.final_url) ?? text(value.finalurl);
  const title = text(value.title);
  const webServer = text(value.webserver);
  const contentType = text(value.content_type);
  const responseTime = text(value.time);
  const host = text(value.host);
  const ip = text(value.host_ip);
  const cdn = booleanValue(value.cdn);
  const cdnName = text(value.cdn_name);
  const cdnType = text(value.cdn_type);
  const location = text(value.location);
  const tls = record(value.tls);
  const failed = booleanValue(value.failed);
  const error = text(value.error) ?? text(value.err);
  return {
    input: text(value.input) ?? url ?? host ?? "unknown",
    ...(url ? { url } : {}),
    ...(finalUrl ? { finalUrl } : {}),
    ...(typeof value.status_code === "number" ? { statusCode: value.status_code } : {}),
    ...(title ? { title } : {}),
    ...(webServer ? { webServer } : {}),
    ...(contentType ? { contentType } : {}),
    ...(typeof value.content_length === "number" ? { contentLength: value.content_length } : {}),
    ...(responseTime ? { responseTime } : {}),
    ...(host ? { host } : {}),
    ...(ip ? { ip } : {}),
    cnames: textArray(value.cname ?? value.cnames),
    technologies: textArray(value.tech ?? value.technologies),
    ...(cdn !== undefined ? { cdn } : {}),
    ...(cdnName ? { cdnName } : {}),
    ...(cdnType ? { cdnType } : {}),
    ...(location ? { location } : {}),
    ...(tls ? { tls } : {}),
    ...(failed !== undefined ? { failed } : {}),
    ...(error ? { error } : {})
  };
}

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
