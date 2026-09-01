import type { ToolDefinition } from "../../types";
import { assertObject } from "../../utils";
import { timeoutBackgroundResult } from "../shared/background-result";
import { backend } from "../shared/backend";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { booleanValue, inputFileCommand, integer, parseJsonLines, projectDiscoveryResult, record, stringList, text, textArray, type JsonRecord } from "./projectdiscovery";

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

export const tlsProbeTool: ToolDefinition = {
  name: "tls_probe",
  description: "Inspect TLS endpoints with ProjectDiscovery tlsx and return normalized protocol, cipher, certificate subject, SAN, issuer, validity, fingerprint, wildcard, and optional enumeration or fingerprinting data. Use the default lightweight probe for inventory; enable version or cipher enumeration only for focused TLS assessment because they make many additional handshakes.",
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
  timeoutMs: 600_000,
  parallel: true,
  visibility: "recon",
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const kali = backend(context);
    const result = await kali.exec(buildTlsProbeCommand(args), 595_000, context.signal, 32_000_000);
    const converted = timeoutBackgroundResult("tls_probe", kali, result);
    if (converted) return converted;
    const parsed = parseTlsProbeOutput(result.stdout);
    return projectDiscoveryResult(context, {
      tool: "tls_probe",
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
