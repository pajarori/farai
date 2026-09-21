import { connect, type PeerCertificate } from "node:tls";
import type { ToolDefinition } from "../../types";
import { assertObject } from "../../utils";
import { timeoutBackgroundResult } from "../shared/background-result";
import { backend } from "../shared/backend";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { booleanValue, inputFileCommand, integer, mapWithConcurrency, parseJsonLines, projectDiscoveryResult, record, stringList, text, textArray, type JsonRecord } from "./projectdiscovery";
import { BACKGROUND_HANDOFF_TIMEOUT_MS } from "../../agent-core/tool-execution-control";

export type TlsProbeRecord = JsonRecord & {
  host: string;
  ip?: string;
  port?: number;
  status?: boolean;
  version?: string;
  cipher?: string;
  keyExchange?: string;
  notBefore?: string;
  notAfter?: string;
  subject?: string;
  commonName?: string;
  subjectAlternativeNames: string[];
  issuer?: string;
  issuerOrganization?: string;
  serial?: string;
  fingerprints?: JsonRecord;
  wildcard?: boolean;
  supportedVersions: string[];
  supportedCiphers: string[];
  jarm?: string;
  ja3?: string;
  ja3s?: string;
};

export function buildTlsProbeCommand(args: Record<string, unknown>): string {
  const targets = stringList(args.targets, "targets", 500);
  const command = [
    "-json", "-silent", "-nc", "-duc", "-tv", "-cipher", "-hash", "sha256", "-se", "-tps",
    "-timeout", String(integer(args.timeoutSeconds, 5, 1, 60)), "-retry", String(integer(args.retries, 1, 0, 5)),
    "-c", String(integer(args.concurrency, 100, 1, 500))
  ];
  if (args.enumerateVersions === true) command.push("-ve");
  if (args.enumerateCiphers === true) command.push("-ce", "-ct", typeof args.cipherTypes === "string" ? args.cipherTypes : "all");
  if (args.jarm === true) command.push("-jarm");
  if (args.ja3 === true) command.push("-ja3", "-ja3s");
  if (args.verifyCertificate === true) command.push("-vc");
  const ports = Array.isArray(args.ports) ? args.ports : typeof args.ports === "number" ? [args.ports] : [];
  if (ports.length) {
    if (ports.some((port) => typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535)) throw new Error("ports must contain valid TCP port numbers");
    command.push("-p", ports.join(","));
  }
  return inputFileCommand("tlsx", command, targets, "-l");
}

export function parseTlsProbeOutput(raw: string): { records: TlsProbeRecord[]; malformed: number } {
  const parsed = parseJsonLines(raw);
  return { records: parsed.records.map(normalizeTlsProbe), malformed: parsed.malformed };
}

function tlsIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function tlsTargets(args: Record<string, unknown>): Array<{ host: string; port: number }> {
  const targets = stringList(args.targets, "targets", 500);
  const explicitPorts = Array.isArray(args.ports) ? args.ports : typeof args.ports === "number" ? [args.ports] : [];
  const ports = explicitPorts.filter((port): port is number => typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535);
  return targets.flatMap((target) => {
    const clean = target.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/.*$/, "");
    const [host, portText] = clean.split(":");
    const hostPorts = ports.length ? ports : portText ? [Number(portText)] : [443];
    return hostPorts.filter((port) => Number.isInteger(port) && port >= 1 && port <= 65_535).map((port) => ({ host: host!, port }));
  });
}

function probeTlsOne(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<TlsProbeRecord> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (record: TlsProbeRecord): void => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      try { socket.destroy(); } catch { }
      resolve(record);
    };
    const fail = (error: string): TlsProbeRecord => ({ host, port, status: false, error, subjectAlternativeNames: [], supportedVersions: [], supportedCiphers: [] });
    const onAbort = (): void => finish(fail("cancelled"));
    const socket = connect({ host, port, servername: host, rejectUnauthorized: false, ALPNProtocols: ["h2", "http/1.1"] });
    socket.setTimeout(timeoutMs, () => finish(fail("timed out")));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate(true) as PeerCertificate & { subjectaltname?: string };
      const sans = (cert.subjectaltname ?? "").split(",").map((entry) => entry.trim().replace(/^DNS:/i, "")).filter(Boolean);
      const commonName = typeof cert.subject?.CN === "string" ? cert.subject.CN : undefined;
      const subject = cert.subject ? Object.entries(cert.subject).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("+") : value}`).join(", ") : undefined;
      const issuerOrganization = typeof cert.issuer?.O === "string" ? cert.issuer.O : undefined;
      const issuer = typeof cert.issuer?.CN === "string" ? cert.issuer.CN : issuerOrganization;
      const version = socket.getProtocol() ?? undefined;
      const cipher = socket.getCipher()?.name || undefined;
      const notBefore = tlsIso(cert.valid_from);
      const notAfter = tlsIso(cert.valid_to);
      finish({
        host,
        port,
        status: true,
        ...(version ? { version } : {}),
        ...(cipher ? { cipher } : {}),
        ...(notBefore ? { notBefore } : {}),
        ...(notAfter ? { notAfter } : {}),
        ...(subject ? { subject } : {}),
        ...(commonName ? { commonName } : {}),
        subjectAlternativeNames: sans,
        ...(issuer ? { issuer } : {}),
        ...(issuerOrganization ? { issuerOrganization } : {}),
        ...(cert.serialNumber ? { serial: cert.serialNumber } : {}),
        ...(cert.fingerprint256 ? { fingerprints: { sha256: cert.fingerprint256 } } : {}),
        wildcard: Boolean(commonName?.startsWith("*.")) || sans.some((name) => name.startsWith("*.")),
        supportedVersions: [],
        supportedCiphers: []
      });
    });
    socket.once("error", (error) => finish(fail(error instanceof Error ? error.message : String(error))));
  });
}

export async function nativeTlsProbe(args: Record<string, unknown>, signal?: AbortSignal): Promise<TlsProbeRecord[]> {
  const targets = tlsTargets(args);
  const timeoutMs = integer(args.timeoutSeconds, 5, 1, 60) * 1_000;
  const concurrency = integer(args.concurrency, 100, 1, 500);
  return mapWithConcurrency(targets, concurrency, (target) => probeTlsOne(target.host, target.port, timeoutMs, signal), signal);
}

function tlsNeedsContainer(args: Record<string, unknown>): boolean {
  return args.enumerateVersions === true || args.enumerateCiphers === true || args.jarm === true || args.ja3 === true;
}

export const tlsProbeTool: ToolDefinition = {
  name: "tls_inspect",
  description: "Inspect TLS endpoints and return normalized protocol, cipher, certificate subject, SAN, issuer, validity, fingerprint, and wildcard. The default probe runs natively on the farai host (fast and reliable, bypassing the container). Set enumerateVersions, enumerateCiphers, jarm, or ja3 for a deep tlsx assessment in the container (slower, many extra handshakes). Use the default for inventory.",
  inputSchema: {
    type: "object",
    required: ["targets"],
    properties: {
      targets: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 500, uniqueItems: true }] },
      ports: { oneOf: [{ type: "integer", minimum: 1, maximum: 65_535 }, { type: "array", items: { type: "integer", minimum: 1, maximum: 65_535 }, maxItems: 100, uniqueItems: true }] },
      enumerateVersions: { type: "boolean" },
      enumerateCiphers: { type: "boolean" },
      cipherTypes: { type: "string", enum: ["all", "secure", "insecure", "weak"] },
      jarm: { type: "boolean" },
      ja3: { type: "boolean" },
      verifyCertificate: { type: "boolean" },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 60 },
      retries: { type: "integer", minimum: 0, maximum: 5 },
      concurrency: { type: "integer", minimum: 1, maximum: 500 }
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
    if (!tlsNeedsContainer(args)) {
      const started = performance.now();
      const records = await nativeTlsProbe(args, context.signal);
      return projectDiscoveryResult(context, {
        tool: "tls_inspect",
        backend: "farai-native-tls",
        result: { exitCode: 0, stdout: "", stderr: "", durationMs: Math.round(performance.now() - started), timedOut: false },
        records,
        malformed: 0,
        noun: "TLS endpoint",
        outputLines: records.map(renderTlsProbe),
        metadata: {
          successfulProbes: records.filter((item) => item.status !== false).length,
          expiringCertificates: records.filter((item) => expiresWithin(item.notAfter, 30)).length
        }
      });
    }
    const kali = backend(context);
    const result = await kali.exec(buildTlsProbeCommand(args), BACKGROUND_HANDOFF_TIMEOUT_MS, context.signal, 32_000_000);
    const converted = timeoutBackgroundResult("tls_inspect", kali, result);
    if (converted) return converted;
    const parsed = parseTlsProbeOutput(result.stdout);
    return projectDiscoveryResult(context, {
      tool: "tls_inspect",
      backend: "tlsx",
      result,
      records: parsed.records,
      malformed: parsed.malformed,
      noun: "TLS endpoint",
      outputLines: parsed.records.map(renderTlsProbe),
      metadata: {
        successfulProbes: parsed.records.filter((item) => item.status !== false).length,
        expiringCertificates: parsed.records.filter((item) => expiresWithin(item.notAfter, 30)).length
      }
    });
  }
};

function normalizeTlsProbe(value: JsonRecord): TlsProbeRecord {
  const port = typeof value.port === "number" ? value.port : Number.isInteger(Number(value.port)) ? Number(value.port) : undefined;
  const status = booleanValue(value.probe_status);
  const ip = text(value.ip);
  const version = text(value.tls_version);
  const cipher = text(value.cipher);
  const keyExchange = text(value.key_exchange);
  const notBefore = text(value.not_before);
  const notAfter = text(value.not_after);
  const subject = text(value.subject_dn);
  const commonName = text(value.subject_cn);
  const issuer = text(value.issuer_dn) ?? text(value.issuer_cn);
  const issuerOrganization = text(value.issuer_org);
  const serial = text(value.serial);
  const fingerprints = record(value.fingerprint_hash);
  const wildcard = booleanValue(value.wildcard_certificate);
  const jarm = text(value.jarm_hash) ?? text(value.jarm);
  const ja3 = text(value.ja3_hash) ?? text(value.ja3);
  const ja3s = text(value.ja3s_hash) ?? text(value.ja3s);
  return {
    host: text(value.host) ?? text(value.input) ?? "unknown",
    ...(ip ? { ip } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(version ? { version } : {}),
    ...(cipher ? { cipher } : {}),
    ...(keyExchange ? { keyExchange } : {}),
    ...(notBefore ? { notBefore } : {}),
    ...(notAfter ? { notAfter } : {}),
    ...(subject ? { subject } : {}),
    ...(commonName ? { commonName } : {}),
    subjectAlternativeNames: textArray(value.subject_an),
    ...(issuer ? { issuer } : {}),
    ...(issuerOrganization ? { issuerOrganization } : {}),
    ...(serial ? { serial } : {}),
    ...(fingerprints ? { fingerprints } : {}),
    ...(wildcard !== undefined ? { wildcard } : {}),
    supportedVersions: textArray(value.version_enum ?? value.versions),
    supportedCiphers: textArray(value.cipher_enum ?? value.ciphers),
    ...(jarm ? { jarm } : {}),
    ...(ja3 ? { ja3 } : {}),
    ...(ja3s ? { ja3s } : {})
  };
}

function renderTlsProbe(item: TlsProbeRecord): string {
  const target = `${item.host}${item.port ? `:${item.port}` : ""}`;
  return [target, item.status === false ? "failed" : item.version, item.cipher, item.commonName, item.issuerOrganization, item.notAfter ? `expires ${item.notAfter}` : undefined].filter(Boolean).join(" · ");
}

function expiresWithin(value: string | undefined, days: number): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= Date.now() && timestamp <= Date.now() + days * 86_400_000;
}
