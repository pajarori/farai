import { Resolver } from "node:dns/promises";
import type { ToolDefinition } from "../../types";
import { assertObject } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { integer, mapWithConcurrency, optionalStringList, projectDiscoveryResult, stringList, type JsonRecord } from "./projectdiscovery";

const DNS_RECORD_TYPES = ["a", "aaaa", "cname", "ns", "txt", "srv", "ptr", "mx", "soa", "caa"] as const;
type DnsRecordType = typeof DNS_RECORD_TYPES[number];

export type DnsProbeRecord = JsonRecord & {
  name: string;
  records: Record<string, string[]>;
  resolver: string[];
  status: "resolved" | "not_found" | "timeout" | "no_answer" | "error";
  errors: Record<string, string>;
  wildcard?: boolean;
  wildcardName?: string;
};

function dnsErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "dns_error";
}

export function dnsProbeStatus(records: Record<string, string[]>, errors: Record<string, string>): DnsProbeRecord["status"] {
  if (Object.values(records).some((values) => values.length > 0)) return "resolved";
  const codes = Object.values(errors).map((value) => value.toUpperCase());
  if (codes.some((value) => value.includes("TIMEOUT") || value === "ETIMEOUT")) return "timeout";
  if (codes.length > 0 && codes.every((value) => value === "ENOTFOUND" || value === "ENODATA" || value === "ENODOMAIN")) return "not_found";
  if (codes.length > 0) return "error";
  return "no_answer";
}

function dnsSignature(records: Record<string, string[]>): string {
  return Object.entries(records)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([type, values]) => values.slice().sort().map((value) => `${type}:${value}`))
    .join("|");
}

function wildcardSibling(name: string): string | undefined {
  const labels = name.replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length < 3) return undefined;
  return `farai-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}.${labels.slice(1).join(".")}`;
}

async function resolveType(resolver: Resolver, name: string, type: DnsRecordType): Promise<string[]> {
  switch (type) {
    case "a": return resolver.resolve4(name);
    case "aaaa": return resolver.resolve6(name);
    case "cname": return resolver.resolveCname(name);
    case "ns": return resolver.resolveNs(name);
    case "ptr": return resolver.resolvePtr(name);
    case "txt": return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(""));
    case "mx": return (await resolver.resolveMx(name)).map((mx) => `${mx.priority} ${mx.exchange}`);
    case "srv": return (await resolver.resolveSrv(name)).map((srv) => `${srv.priority} ${srv.weight} ${srv.port} ${srv.name}`);
    case "caa": return (await resolver.resolveCaa(name)).map((caa) => JSON.stringify(caa));
    case "soa": {
      const soa = await resolver.resolveSoa(name);
      return [`${soa.nsname} ${soa.hostmaster} ${soa.serial} ${soa.refresh} ${soa.retry} ${soa.expire} ${soa.minttl}`];
    }
  }
}

export async function nativeDnsResolve(args: Record<string, unknown>, signal?: AbortSignal): Promise<DnsProbeRecord[]> {
  const names = stringList(args.names, "names", 2_000);
  const requested = optionalStringList(args.recordTypes, "recordTypes", DNS_RECORD_TYPES.length);
  const recordTypes = (requested.length ? requested : ["a", "aaaa", "cname"]) as DnsRecordType[];
  if (recordTypes.some((value) => !DNS_RECORD_TYPES.includes(value))) throw new Error("recordTypes contains an unsupported DNS record type");
  const timeoutMs = integer(args.timeoutSeconds, 5, 1, 30) * 1_000;
  const resolvers = optionalStringList(args.resolvers, "resolvers", 100);
  const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
  if (resolvers.length) resolver.setServers(resolvers);

  const resolveName = async (name: string): Promise<DnsProbeRecord> => {
    const entry: Record<string, string[]> = {};
    const errors: Record<string, string> = {};
    for (const type of recordTypes) {
      try {
        const values = await resolveType(resolver, name, type);
        if (values.length) entry[type] = values;
      } catch (error) {
        errors[type] = dnsErrorCode(error);
      }
    }
    return { name, records: entry, resolver: resolvers, status: dnsProbeStatus(entry, errors), errors };
  };
  const records = await mapWithConcurrency(names, 50, resolveName, signal);
  if (args.wildcard === "off") return records;
  const wildcardParents = [...new Set(records.flatMap((item) => {
    const sibling = item.status === "resolved" ? wildcardSibling(item.name) : undefined;
    return sibling ? [sibling.split(".").slice(1).join(".")] : [];
  }))];
  const wildcardNames = wildcardParents.map((parent) => `farai-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}.${parent}`);
  if (!wildcardNames.length) return records;
  const wildcardRecords = await mapWithConcurrency(wildcardNames, 20, resolveName, signal);
  const wildcardByParent = new Map(wildcardRecords.map((item) => [item.name.split(".").slice(1).join("."), item]));
  return records.map((item) => {
    if (item.status !== "resolved") return item;
    const parent = item.name.replace(/\.$/, "").split(".").slice(1).join(".");
    const wildcard = wildcardByParent.get(parent);
    if (!wildcard || wildcard.status !== "resolved" || dnsSignature(item.records) !== dnsSignature(wildcard.records)) return item;
    return { ...item, wildcard: true, wildcardName: wildcard.name };
  });
}

export const dnsProbeTool: ToolDefinition = {
  name: "dns_resolve",
  description: "Resolve one or many hostnames using a fast native resolver that runs directly on the farai host (reliable — it does not depend on the container's DNS). Select DNS record types and optionally set custom resolver servers. Returns answer records grouped by name. Use this to validate candidates from asset_subdomains before HTTP or port probing; it is not a passive discovery source.",
  inputSchema: {
    type: "object",
    required: ["names"],
    properties: {
      names: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2_000, uniqueItems: true }] },
      recordTypes: { type: "array", items: { type: "string", enum: [...DNS_RECORD_TYPES] }, maxItems: DNS_RECORD_TYPES.length, uniqueItems: true },
      resolvers: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 100, uniqueItems: true }], description: "optional resolver server ip(s); defaults to the host's system resolver" },
      wildcard: { type: "string", enum: ["off", "auto"], description: "detect sibling wildcard DNS answers; defaults to auto" },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 30 }
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: Number.POSITIVE_INFINITY,
  parallel: true,
  visibility: "recon",
  run: async (args, context) => {
    assertObject(args, "args");
    const started = performance.now();
    const records = await nativeDnsResolve(args, context.signal);
    const resolved = records.filter((item) => item.status === "resolved" && !item.wildcard).length;
    return {
      ...projectDiscoveryResult(context, {
        tool: "dns_resolve",
        backend: "farai-native-dns",
        result: { exitCode: 0, stdout: "", stderr: "", durationMs: Math.round(performance.now() - started), timedOut: false },
        records,
        malformed: 0,
        noun: "DNS result",
        outputLines: records.map(renderDnsProbe),
        resultCount: resolved,
        metadata: {
          resolvedNames: resolved,
          wildcardNames: records.filter((item) => item.wildcard).length,
          notFoundNames: records.filter((item) => item.status === "not_found").length,
          timedOutNames: records.filter((item) => item.status === "timeout").length,
          errorNames: records.filter((item) => item.status === "error").length
        }
      }),
      campaignFeed: {
        observations: records
          .filter((item) => item.status === "resolved" && !item.wildcard)
          .map((item) => ({ assetCanonical: item.name, kind: "dns_record", value: item.records, source: "dns_resolve", confidence: 0.8 }))
      }
    };
  },
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer
};

function renderDnsProbe(item: DnsProbeRecord): string {
  const answers = Object.entries(item.records).flatMap(([type, values]) => values.map((value) => `${type.toUpperCase()} ${value}`));
  if (item.wildcard) return `${item.name} · wildcard DNS match`;
  if (answers.length) return `${item.name} · ${answers.join(" · ")}`;
  if (item.status === "not_found") return `${item.name} · not found`;
  if (item.status === "timeout") return `${item.name} · resolver timeout`;
  if (item.status === "error") return `${item.name} · resolver error`;
  return `${item.name} · no answers`;
}
