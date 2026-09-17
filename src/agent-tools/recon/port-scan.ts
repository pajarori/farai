import type { BackendExecResult } from "../backends/types";
import type { ToolDefinition, ToolResult } from "../../types";
import { assertObject, asString } from "../../utils";
import { backend } from "../shared/backend";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { processOutput } from "../shared/process-output";
import { timeoutBackgroundResult } from "../shared/background-result";
import { integer, projectDiscoveryResult, shellQuote, text, type JsonRecord } from "./projectdiscovery";

export type DiscoveredPort = JsonRecord & { host: string; port: number; protocol: string; service?: string };

export function parseNaabuOutput(raw: string, fallbackHost: string): DiscoveredPort[] {
  const seen = new Set<string>();
  const ports: DiscoveredPort[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const port = typeof parsed.port === "number" ? parsed.port : Number(parsed.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
      const host = text(parsed.ip) ?? text(parsed.host) ?? fallbackHost;
      const protocol = text(parsed.protocol) ?? "tcp";
      const service = text(parsed.service);
      const key = `${host}|${port}|${protocol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ports.push({ host, port, protocol, ...(service ? { service } : {}) });
    } catch {
    }
  }
  return ports;
}

export function parseNmapOpenPorts(raw: string, fallbackHost: string): DiscoveredPort[] {
  const seen = new Set<string>();
  const ports: DiscoveredPort[] = [];
  let currentHost = fallbackHost;
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    const hostMatch = line.match(/^Nmap scan report for (.+)$/);
    if (hostMatch) {
      const value = hostMatch[1] ?? fallbackHost;
      const ipMatch = value.match(/\(([^)]+)\)$/);
      currentHost = ipMatch ? ipMatch[1] ?? fallbackHost : value;
      continue;
    }
    const portMatch = line.match(/^(\d+)\/(tcp|udp)\s+open\s*([^\s]*)/);
    if (!portMatch) continue;
    const port = Number(portMatch[1]);
    const protocol = portMatch[2] ?? "tcp";
    const service = portMatch[3]?.trim();
    const key = `${currentHost}|${port}|${protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ports.push({ host: currentHost, port, protocol, ...(service ? { service } : {}) });
  }
  return ports;
}

export function buildNaabuCommand(args: Record<string, unknown>): string {
  const target = asString(args.target, "target");
  if (/\r|\n|\0/.test(target) || target.length > 2_048) throw new Error("target must be a single line of at most 2048 characters");
  const command = [
    "naabu", "-host", target, "-json", "-silent", "-nc", "-duc", "-Pn", "-verify",
    "-rate", String(integer(args.rateLimit, 1_000, 1, 100_000)),
    "-c", String(integer(args.concurrency, 25, 1, 200)),
    "-timeout", `${integer(args.timeoutMs, 1_000, 100, 30_000)}ms`,
    "-retries", String(integer(args.retries, 2, 1, 10))
  ];
  const ports = normalizePortSelection(args.ports);
  if (ports) command.push("-p", ports);
  else command.push("-tp", typeof args.topPorts === "string" ? args.topPorts : "1000");
  return command.map(shellQuote).join(" ");
}

export function buildNmapCommand(targets: string[], options: { ports?: number[]; versionDetection: boolean; deep: boolean }): string {
  if (!targets.length) throw new Error("nmap targets are required");
  const command = ["nmap", "-Pn", "-vv"];
  if (options.deep) command.push("-T4");
  if (options.versionDetection) command.push("-sV", "-sC");
  if (options.ports?.length) command.push("-p", [...new Set(options.ports)].sort((left, right) => left - right).join(","));
  command.push(...targets);
  return command.map(shellQuote).join(" ");
}

async function runNetworkScan(args: unknown, context: Parameters<NonNullable<ToolDefinition["run"]>>[1]): Promise<ToolResult> {
  assertObject(args, "args");
  const target = asString(args.target, "target");
  const versionDetection = args.versionDetection !== false;
  const mode = args.mode === "nmap" || args.mode === "deep" ? args.mode : "discover";
  const kali = backend(context);

  if (mode === "nmap" || mode === "deep") {
    const portSelection = normalizePortSelection(args.ports);
    const ports = portSelection ? expandPorts(portSelection, 65_535) : undefined;
    const result = await kali.exec(buildNmapCommand([target], { ...(ports ? { ports } : {}), versionDetection, deep: mode === "deep" }), 595_000, context.signal, 32_000_000);
    const converted = timeoutBackgroundResult("network_scan", kali, result);
    if (converted) return converted;
    return portResult(context, "network_scan", "nmap", mode, target, result, parseNmapOpenPorts(processOutput(result.stdout, result.stderr), target), false);
  }

  const naabuResult = await kali.exec(buildNaabuCommand(args), 295_000, context.signal, 16_000_000);
  const converted = timeoutBackgroundResult("network_scan", kali, naabuResult);
  if (converted) return converted;
  const discovered = parseNaabuOutput(naabuResult.stdout, target);
  return portResult(context, "network_scan", "naabu", mode, target, naabuResult, discovered, false);
}

function portResult(
  context: Parameters<NonNullable<ToolDefinition["run"]>>[1],
  label: string,
  backendName: string,
  mode: string,
  target: string,
  result: BackendExecResult,
  records: DiscoveredPort[],
  serviceEnriched: boolean,
  warning?: string
): ToolResult {
  return projectDiscoveryResult(context, {
    tool: label,
    backend: backendName,
    result,
    records,
    malformed: 0,
    noun: "open port",
    outputLines: [
      ...(warning ? [`warning: ${warning}`] : []),
      ...records.map((item) => `${item.host}:${item.port}/${item.protocol}${item.service ? ` · ${item.service}` : ""}`)
    ],
    metadata: {
      target,
      scanMode: mode,
      serviceEnriched,
      discoveredPorts: records.slice(0, 200)
    }
  });
}

function normalizePortSelection(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("ports must be an nmap-style TCP port list or range");
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || normalized.length > 2_048 || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(normalized)) throw new Error("ports must contain comma-separated TCP ports or ranges");
  expandPorts(normalized, 65_535);
  return normalized;
}

function expandPorts(value: string, maximum: number): number[] {
  const ports: number[] = [];
  for (const part of value.split(",")) {
    const [startText, endText] = part.split("-", 2);
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > maximum || end < start) throw new Error("ports contains an invalid port or range");
    if (end - start > 10_000) throw new Error("a single port range cannot exceed 10001 ports");
    for (let port = start; port <= end; port += 1) ports.push(port);
  }
  return [...new Set(ports)];
}

const portScanSchema = {
  type: "object",
  required: ["target"],
  properties: {
    target: { type: "string" },
    mode: { type: "string", enum: ["discover", "nmap", "deep"] },
    ports: { type: "string" },
    topPorts: { type: "string", enum: ["100", "1000", "full"] },
    versionDetection: { type: "boolean" },
    rateLimit: { type: "integer", minimum: 1, maximum: 100_000 },
    concurrency: { type: "integer", minimum: 1, maximum: 200 },
    timeoutMs: { type: "integer", minimum: 100, maximum: 30_000 },
    retries: { type: "integer", minimum: 1, maximum: 10 }
  },
  additionalProperties: false
} as Record<string, unknown>;

export const networkScanTool: ToolDefinition = {
  name: "network_scan",
  description: "Discover open TCP ports with naabu. The default mode is fast TCP discovery; mode=nmap and mode=deep are explicit Nmap scans for service identification. Use service_probe for HTTP inventory and command_run for UDP, custom NSE, evasion, or specialized workflows.",
  inputSchema: portScanSchema,
  mutates: false,
  timeoutMs: 900_000,
  parallel: true,
  visibility: "recon",
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: runNetworkScan
};
