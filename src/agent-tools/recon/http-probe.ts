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
  shellQuote,
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

export type HttpProbeMode = "fast" | "detail";

export function buildFastHttpProbeCommand(args: Record<string, unknown>): string {
  const targets = stringList(args.targets, "targets");
  const timeoutSeconds = integer(args.timeoutSeconds, 3, 1, 15);
  const concurrency = integer(args.concurrency, 100, 1, 200);
  const probeTargets = targets.flatMap((target) => /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? [target] : [`https://${target}`, `http://${target}`]);
  const configLines = probeTargets.flatMap((target) => [
    `url = "${curlConfigQuote(target)}"`,
    'output = "/dev/null"',
    'write-out = "%{url}\\t%{url_effective}\\t%{http_code}\\t%{content_type}\\t%{size_download}\\t%{time_total}\\t%{remote_ip}\\t%{exitcode}\\t%{errormsg}\\n"'
  ]).map(shellQuote).join(" ");
  return [
    'config="$(mktemp /tmp/farai-http-probe.XXXXXX)" || exit 1',
    'trap \'rm -f "$config"\' EXIT',
    `printf '%s\\n' ${configLines} > "$config"`,
    `curl --parallel --parallel-immediate --parallel-max ${concurrency} --silent --show-error --insecure --connect-timeout 1 --max-time ${timeoutSeconds} --config "$config"`
  ].join("\n");
}

export function buildHttpProbeCommand(args: Record<string, unknown>): string {
  if (args.mode !== "detail") return buildFastHttpProbeCommand(args);
  const targets = stringList(args.targets, "targets");
  const timeout = integer(args.timeoutSeconds, 10, 1, 60);
  const rateLimit = integer(args.rateLimit, 100, 1, 1_000);
  const concurrency = integer(args.concurrency, 50, 1, 200);
  const command = [
    "-json", "-silent", "-nc", "-duc", "-sc", "-title", "-server", "-ct", "-cl", "-location", "-rt", "-ip", "-cname",
    "-timeout", String(timeout), "-retries", "1", "-rl", String(rateLimit), "-threads", String(concurrency),
    "-rstr", "5000000"
  ];
  command.push("-td", "-asn", "-cdn");
  if (args.includeTls !== false) command.push("-tls-grab");
  const redirect = typeof args.redirects === "string" ? args.redirects : "same_host";
  if (redirect === "same_host") command.push("-fhr");
  if (redirect === "all") command.push("-fr");
  if (targets.every((target) => /^[a-z][a-z0-9+.-]*:\/\//i.test(target))) command.push("-nfs");
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

export const httpProbeTool: ToolDefinition = {
  name: "service_probe",
  description: "Probe one or many hosts, IPs, or URLs with a lightweight concurrent HTTP probe and return normalized live service records. The default fast mode returns status, content type, response size, address, and timing; detail mode uses ProjectDiscovery httpx for page title, server, technology, ASN, CDN/WAF, redirect, and TLS enrichment. Use this after subdomain or port discovery; use browser tools for interactive state and http_request for one exact protocol request.",
  inputSchema: {
    type: "object",
    required: ["targets"],
    properties: {
      targets: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 500, uniqueItems: true }] },
      mode: { type: "string", enum: ["fast", "detail"] },
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
  timeoutMs: 30_000,
  parallel: true,
  visibility: "recon",
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const kali = backend(context);
    const detail = args.mode === "detail";
    const result = await kali.exec(buildHttpProbeCommand(args), detail ? 25_000 : 8_000, context.signal, 16_000_000);
    const converted = timeoutBackgroundResult("service_probe", kali, result);
    if (converted) return converted;
    const parsed = detail ? parseHttpProbeOutput(result.stdout) : parseFastHttpProbeOutput(result.stdout);
    const records = detail ? parsed.records : selectFastHttpProbeRecords(parsed.records);
    return projectDiscoveryResult(context, {
      tool: "service_probe",
      backend: detail ? "httpx" : "farai-http-probe",
      result,
      records,
      malformed: parsed.malformed,
      noun: "service",
      outputLines: records.map(renderHttpProbe),
      metadata: {
        liveServices: records.filter((item) => !item.failed).length,
        failedTargets: records.filter((item) => item.failed).length
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

function curlConfigQuote(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function fastRecordRank(record: HttpProbeRecord): number {
  const failed = record.failed ? 10 : 0;
  const secure = record.url?.startsWith("https://") ? 0 : 1;
  return failed + secure;
}
