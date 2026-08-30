import type { ToolDefinition, ToolResult } from "../../types";
import { assertObject, asString } from "../../utils";
import { backend } from "../shared/backend";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { processOutput } from "../shared/process-output";
import { summarizeOrSpool } from "../shared/result-summary";
import { timeoutBackgroundResult } from "../shared/background-result";

type DiscoveredPort = { host: string; port: number; protocol: string };

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

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
      const host = typeof parsed.ip === "string" && parsed.ip.trim()
        ? parsed.ip.trim()
        : typeof parsed.host === "string" && parsed.host.trim() ? parsed.host.trim() : fallbackHost;
      const protocol = typeof parsed.protocol === "string" && parsed.protocol.trim() ? parsed.protocol.trim() : "tcp";
      const key = `${host}|${port}|${protocol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ports.push({ host, port, protocol });
    } catch {

    }
  }
  return ports;
}

function summarizePortScan(raw: string): string {
  const lines = raw.split("\n");
  const relevant = lines.filter((line) =>
    /^\d+\/(tcp|udp)/.test(line.trim()) ||
    /^(Port scan target|Nmap scan report|Host is|Not shown|OS details|Service Info)/.test(line.trim())
  );
  return relevant.length ? relevant.join("\n") : raw.slice(0, 3_000);
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
    const portMatch = line.match(/^(\d+)\/(tcp|udp)\s+open\b/);
    if (!portMatch) continue;
    const port = Number(portMatch[1]);
    const protocol = portMatch[2] ?? "tcp";
    const key = `${currentHost}|${port}|${protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ports.push({ host: currentHost, port, protocol });
  }
  return ports;
}

async function runPortScan(args: unknown, context: Parameters<NonNullable<ToolDefinition["run"]>>[1], label: string): Promise<ToolResult> {
  assertObject(args, "args");
  const target = asString(args.target, "target");
  const versionDetection = args.versionDetection !== false;
  const nmapArgs = [
    "nmap", "-Pn", "-vv",
    ...(versionDetection ? ["-sV", "-sC"] : []),
    shQuote(target)
  ];
  const kali = backend(context);
  const nmapResult = await kali.exec(nmapArgs.join(" "));
  const converted = timeoutBackgroundResult(label, kali, nmapResult);
  if (converted) return converted;

  const nmapOutput = processOutput(nmapResult.stdout, nmapResult.stderr);
  const nmapOk = nmapResult.exitCode === 0 && !nmapResult.timedOut;
  const discovered = parseNmapOpenPorts(nmapOutput, target);
  if (!discovered.length) {
    return {
      ok: nmapOk,
      summary: `${label}: no open ports found`,
      output: nmapOutput || "(no open ports found)",
      metadata: { backend: "nmap", discoveredPorts: [] }
    };
  }

  const raw = [`Port scan target: ${target}`, nmapOutput].filter(Boolean).join("\n\n");
  return summarizeOrSpool(context, {
    title: label,
    raw,
    ok: nmapOk,
    summarize: summarizePortScan
  });
}

const portScanSchema = {
  type: "object",
  required: ["target"],
  properties: {
    target: { type: "string" },
    versionDetection: { type: "boolean" }
  }
} as Record<string, unknown>;

export const portScanTool: ToolDefinition = {
  name: "port_scan",
  description: "Discover open TCP ports on one host or network target with Nmap using host-discovery bypass and verbose output. Service versions and default scripts run unless versionDetection=false; use shell_exec for custom Nmap flags, UDP scans, or specialized NSE workflows.",
  inputSchema: portScanSchema,
  mutates: false,
  timeoutMs: 300_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: (args, context) => runPortScan(args, context, "port_scan")
};

export const nmapScanTool: ToolDefinition = {
  ...portScanTool,
  name: "nmap_scan",
  description: "Compatibility alias for port_scan with the same target and versionDetection behavior. Prefer port_scan for new work; use shell_exec when the task requires custom Nmap flags, port ranges, UDP, or specialized NSE scripts.",
  run: (args, context) => runPortScan(args, context, "nmap_scan")
};
