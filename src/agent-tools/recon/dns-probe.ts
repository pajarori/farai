import type { ToolDefinition } from "../../types";
import { assertObject } from "../../utils";
import { timeoutBackgroundResult } from "../shared/background-result";
import { backend } from "../shared/backend";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { inputFileCommand, integer, optionalStringList, parseJsonLines, projectDiscoveryResult, record, stringList, text, textArray, type JsonRecord } from "./projectdiscovery";

const DNS_RECORD_TYPES = ["a", "aaaa", "cname", "ns", "txt", "srv", "ptr", "mx", "soa", "caa"] as const;

export type DnsProbeRecord = JsonRecord & {
  name: string;
  status?: string;
  records: Record<string, string[]>;
  resolver: string[];
  asn?: JsonRecord;
};

export function buildDnsProbeCommand(args: Record<string, unknown>): string {
  const names = stringList(args.names, "names", 2_000);
  const requested = optionalStringList(args.recordTypes, "recordTypes", DNS_RECORD_TYPES.length);
  const recordTypes = requested.length ? requested : ["a", "aaaa", "cname"];
  if (recordTypes.some((value) => !DNS_RECORD_TYPES.includes(value as typeof DNS_RECORD_TYPES[number]))) throw new Error("recordTypes contains an unsupported DNS record type");
  const command = ["-json", "-silent", "-nc", "-duc", "-omit-raw", "-timeout", `${integer(args.timeoutSeconds, 5, 1, 30)}s`, "-rl", String(integer(args.rateLimit, 500, 1, 10_000))];
  for (const type of recordTypes) command.push(`-${type}`);
  if (args.includeAsn === true) command.push("-asn");
  const resolvers = optionalStringList(args.resolvers, "resolvers", 100);
  if (resolvers.length) command.push("-r", resolvers.join(","));
  if (args.wildcard === "auto") command.push("-auto-wildcard");
  return inputFileCommand("dnsx", command, names, "-l");
}

export function parseDnsProbeOutput(raw: string): { records: DnsProbeRecord[]; malformed: number } {
  const parsed = parseJsonLines(raw);
  return { records: parsed.records.map(normalizeDnsProbe), malformed: parsed.malformed };
}

export const dnsProbeTool: ToolDefinition = {
  name: "dns_probe",
  description: "Resolve and enrich one or many hostnames with ProjectDiscovery dnsx using selected DNS record types, optional custom resolvers, ASN enrichment, and automatic wildcard filtering. Use this to validate candidates from subdomain_enum before HTTP or port probing; it is not a passive discovery source.",
  inputSchema: {
    type: "object",
    required: ["names"],
    properties: {
      names: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2_000, uniqueItems: true }] },
      recordTypes: { type: "array", items: { type: "string", enum: [...DNS_RECORD_TYPES] }, maxItems: DNS_RECORD_TYPES.length, uniqueItems: true },
      resolvers: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 100, uniqueItems: true }] },
      wildcard: { type: "string", enum: ["off", "auto"] },
      includeAsn: { type: "boolean" },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 30 },
      rateLimit: { type: "integer", minimum: 1, maximum: 10_000 }
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
    const result = await kali.exec(buildDnsProbeCommand(args), 175_000, context.signal, 16_000_000);
    const converted = timeoutBackgroundResult("dns_probe", kali, result);
    if (converted) return converted;
    const parsed = parseDnsProbeOutput(result.stdout);
    return projectDiscoveryResult(context, {
      tool: "dns_probe",
      backend: "dnsx",
      result,
      records: parsed.records,
      malformed: parsed.malformed,
      noun: "DNS result",
      outputLines: parsed.records.map(renderDnsProbe),
      metadata: { resolvedNames: parsed.records.filter((item) => Object.values(item.records).some((values) => values.length)).length }
    });
  }
};

function normalizeDnsProbe(value: JsonRecord): DnsProbeRecord {
  const records: Record<string, string[]> = {};
  for (const type of DNS_RECORD_TYPES) {
    const values = textArray(value[type]);
    if (values.length) records[type] = values;
  }
  const status = text(value.status_code);
  const asn = record(value.asn);
  return {
    name: text(value.host) ?? text(value.input) ?? "unknown",
    ...(status ? { status } : {}),
    records,
    resolver: textArray(value.resolver),
    ...(asn ? { asn } : {})
  };
}

function renderDnsProbe(item: DnsProbeRecord): string {
  const answers = Object.entries(item.records).flatMap(([type, values]) => values.map((value) => `${type.toUpperCase()} ${value}`));
  return `${item.name}${item.status ? ` · ${item.status}` : ""}${answers.length ? ` · ${answers.join(" · ")}` : " · no answers"}`;
}
