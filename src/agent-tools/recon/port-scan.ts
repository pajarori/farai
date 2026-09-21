import { lookup } from "node:dns/promises";
import { Socket } from "node:net";
import type { BackendExecResult } from "../backends/types";
import type { ToolDefinition, ToolResult } from "../../types";
import { assertObject, asString } from "../../utils";
import { backend } from "../shared/backend";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { processOutput } from "../shared/process-output";
import { timeoutBackgroundResult } from "../shared/background-result";
import { integer, mapWithConcurrency, projectDiscoveryResult, shellQuote, text, type JsonRecord } from "./projectdiscovery";

export type DiscoveredPort = JsonRecord & { host: string; port: number; protocol: string; service?: string };

const FAST_PORTS = [20, 21, 22, 23, 25, 53, 67, 68, 69, 80, 81, 88, 110, 111, 119, 123, 135, 137, 138, 139, 143, 161, 162, 179, 389, 443, 445, 465, 500, 512, 513, 514, 515, 520, 548, 554, 587, 593, 631, 636, 873, 902, 989, 990, 993, 995, 1080, 1194, 1433, 1521, 1723, 1883, 2049, 2375, 2376, 2483, 2484, 3000, 3128, 3268, 3269, 3306, 3389, 3690, 4000, 4369, 4444, 5000, 5060, 5061, 5432, 5555, 5601, 5672, 5900, 5984, 5985, 5986, 6379, 6443, 6667, 7001, 7002, 7070, 7199, 7474, 8000, 8008, 8080, 8081, 8088, 8090, 8161, 8443, 8500, 8888, 9000, 9042, 9090, 9100, 9200, 9300, 9418, 9999, 10000, 11211, 15672, 27017];
const SERVICE_NAMES: Record<number, string> = {
  21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "dns", 80: "http", 110: "pop3", 123: "ntp", 143: "imap", 161: "snmp", 389: "ldap", 443: "https", 445: "smb", 465: "smtps", 587: "submission", 636: "ldaps", 993: "imaps", 995: "pop3s", 1433: "mssql", 1521: "oracle", 1883: "mqtt", 2049: "nfs", 2375: "docker", 2376: "docker-tls", 3000: "http", 3128: "http-proxy", 3306: "mysql", 3389: "rdp", 5432: "postgresql", 5601: "kibana", 5672: "amqp", 5900: "vnc", 5985: "winrm", 5986: "winrm-tls", 6379: "redis", 6443: "kubernetes", 8000: "http", 8080: "http-proxy", 8443: "https-alt", 8888: "http", 9000: "http", 9090: "http", 9200: "elasticsearch", 11211: "memcached", 27017: "mongodb"
};

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
    "naabu", "-host", target, "-json", "-silent", "-nc", "-duc", "-Pn", "-irt", "10s",
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
  const mode = args.mode === "discover" || args.mode === "nmap" || args.mode === "deep" ? args.mode : "fast";

  if (mode === "fast") {
    const started = performance.now();
    const records = await nativeTcpScan(args, target, context.signal);
    const result: BackendExecResult = { exitCode: 0, stdout: "", stderr: "", durationMs: Math.round(performance.now() - started), timedOut: false };
    return portResult(context, "network_scan", "farai-native-tcp", mode, target, result, records, false);
  }

  const kali = backend(context);

  if (mode === "nmap" || mode === "deep") {
    const portSelection = normalizePortSelection(args.ports);
    const ports = portSelection ? expandPorts(portSelection, 65_535) : undefined;
    const result = await kali.exec(buildNmapCommand([target], { ...(ports ? { ports } : {}), versionDetection, deep: mode === "deep" }), undefined, context.signal, 32_000_000);
    const converted = timeoutBackgroundResult("network_scan", kali, result);
    if (converted) return converted;
    return portResult(context, "network_scan", "nmap", mode, target, result, parseNmapOpenPorts(processOutput(result.stdout, result.stderr), target), false);
  }

  const naabuResult = await kali.exec(buildNaabuCommand(args), undefined, context.signal, 16_000_000);
  const converted = timeoutBackgroundResult("network_scan", kali, naabuResult);
  if (converted) return converted;
  const discovered = parseNaabuOutput(naabuResult.stdout, target);
  return portResult(context, "network_scan", "naabu", mode, target, naabuResult, discovered, false);
}

export async function nativeTcpScan(args: Record<string, unknown>, target: string, signal?: AbortSignal): Promise<DiscoveredPort[]> {
  const host = scanHost(target);
  const selection = normalizePortSelection(args.ports);
  if (!selection && args.topPorts === "full") throw new Error("fast mode does not scan all 65535 ports; use mode=discover with topPorts=full");
  const ports = selection ? expandPorts(selection, 65_535) : FAST_PORTS;
  if (ports.length > 5_000) throw new Error("fast mode accepts at most 5000 explicit ports; use mode=discover for larger scans");
  const addresses = [...new Map((await lookup(host, { all: true, verbatim: true })).map((entry) => [entry.address, entry])).values()];
  const timeoutMs = integer(args.timeoutMs, 600, 100, 5_000);
  const concurrency = integer(args.concurrency, 200, 1, 500);
  const attempts = addresses.flatMap((address) => ports.map((port) => ({ address: address.address, family: address.family, port })));
  const results = await mapWithConcurrency(attempts, concurrency, async (attempt) => {
    const open = await tcpConnect(attempt.address, attempt.family, attempt.port, timeoutMs, signal);
    return open ? { host: attempt.address, port: attempt.port, protocol: "tcp", ...(SERVICE_NAMES[attempt.port] ? { service: SERVICE_NAMES[attempt.port] } : {}) } : undefined;
  }, signal);
  return results.filter((record): record is DiscoveredPort => Boolean(record));
}

function scanHost(target: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return target;
  try { return new URL(target).hostname; }
  catch { throw new Error("target must be a hostname, IP address, or URL"); }
}

function tcpConnect(host: string, family: number, port: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    const socket = new Socket();
    let settled = false;
    const settle = (open: boolean): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolvePromise(open);
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(signal?.reason ?? new Error("cancelled"));
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    if (!settled) socket.connect({ host, port, family });
  });
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
    mode: { type: "string", enum: ["fast", "discover", "nmap", "deep"] },
    ports: { type: "string" },
    topPorts: { type: "string", enum: ["100", "1000", "full"] },
    versionDetection: { type: "boolean" },
    rateLimit: { type: "integer", minimum: 1, maximum: 100_000 },
    concurrency: { type: "integer", minimum: 1, maximum: 500 },
    timeoutMs: { type: "integer", minimum: 100, maximum: 30_000 },
    retries: { type: "integer", minimum: 1, maximum: 10 }
  },
  additionalProperties: false
} as Record<string, unknown>;

export const networkScanTool: ToolDefinition = {
  name: "network_scan",
  description: "Discover open TCP ports. Fast mode (default) uses bounded native TCP connects for common or explicitly selected ports without starting Kali. Discover mode uses naabu for larger SYN scans, while nmap and deep are explicit service-enrichment modes. Use service_probe for HTTP inventory and command_run for UDP, custom NSE, evasion, or specialized workflows.",
  inputSchema: portScanSchema,
  mutates: false,
  timeoutMs: Number.POSITIVE_INFINITY,
  parallel: true,
  visibility: "recon",
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: runNetworkScan
};
