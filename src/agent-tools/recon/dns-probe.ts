import type { ToolDefinition } from "../../types";
import { assertObject } from "../../utils";
import { timeoutBackgroundResult } from "../shared/background-result";
import { backend } from "../shared/backend";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { integer, optionalStringList, projectDiscoveryResult, shellQuote, stringList, type JsonRecord } from "./projectdiscovery";

const DNS_RECORD_TYPES = ["a", "aaaa", "cname", "ns", "txt", "srv", "ptr", "mx", "soa", "caa"] as const;

export type DnsProbeRecord = JsonRecord & {
  name: string;
  records: Record<string, string[]>;
  resolver: string[];
};

export function buildDnsProbeCommand(args: Record<string, unknown>): string {
  const names = stringList(args.names, "names", 2_000);
  const requested = optionalStringList(args.recordTypes, "recordTypes", DNS_RECORD_TYPES.length);
  const recordTypes = requested.length ? requested : ["a", "aaaa", "cname"];
  if (recordTypes.some((value) => !DNS_RECORD_TYPES.includes(value as typeof DNS_RECORD_TYPES[number]))) throw new Error("recordTypes contains an unsupported DNS record type");
  const timeout = integer(args.timeoutSeconds, 5, 1, 30);
  const resolvers = optionalStringList(args.resolvers, "resolvers", 100);
  const queries = names.flatMap((name) => recordTypes.map((type) => `${name} ${type.toUpperCase()}`));
  const queryLines = queries.map(shellQuote).join(" ");
  const fixed = ["dig", "+noall", "+answer", "+nocomments", "+tries=1", `+time=${timeout}`].join(" ");
  const server = resolvers[0] ? ` ${shellQuote(`@${resolvers[0]}`)}` : "";
  return [
    'file="$(mktemp /tmp/farai-dig.XXXXXX)" || exit 1',
    'trap \'rm -f "$file"\' EXIT',
    `printf '%s\\n' ${queryLines} > "$file"`,
    `${fixed}${server} -f "$file"`
  ].join("\n");
}

export function parseDnsProbeOutput(raw: string): { records: DnsProbeRecord[]; malformed: number } {
  const byName = new Map<string, Record<string, string[]>>();
  let malformed = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";")) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 5) {
      malformed += 1;
      continue;
    }
    const owner = fields[0]!.replace(/\.$/, "").toLowerCase();
    const type = fields[3]!.toLowerCase();
    const value = fields.slice(4).join(" ").replace(/\.$/, "");
    if (!DNS_RECORD_TYPES.includes(type as typeof DNS_RECORD_TYPES[number])) continue;
    const entry = byName.get(owner) ?? {};
    (entry[type] ??= []).push(value);
    byName.set(owner, entry);
  }
  const records = [...byName.entries()].map(([name, entryRecords]): DnsProbeRecord => ({ name, records: entryRecords, resolver: [] }));
  return { records, malformed };
}

export const dnsProbeTool: ToolDefinition = {
  name: "dns_resolve",
  description: "Resolve one or many hostnames with dig using selected DNS record types and optional custom resolver. Returns answer records grouped by name (following CNAME targets as their own entries). Use this to validate candidates from asset_subdomains before HTTP or port probing; it is not a passive discovery source.",
  inputSchema: {
    type: "object",
    required: ["names"],
    properties: {
      names: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2_000, uniqueItems: true }] },
      recordTypes: { type: "array", items: { type: "string", enum: [...DNS_RECORD_TYPES] }, maxItems: DNS_RECORD_TYPES.length, uniqueItems: true },
      resolvers: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 100, uniqueItems: true }], description: "optional custom resolver; the first entry is passed to dig as @resolver" },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 30 }
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
    const converted = timeoutBackgroundResult("dns_resolve", kali, result);
    if (converted) return converted;
    const parsed = parseDnsProbeOutput(result.stdout);
    return projectDiscoveryResult(context, {
      tool: "dns_resolve",
      backend: "dig",
      result,
      records: parsed.records,
      malformed: parsed.malformed,
      noun: "DNS result",
      outputLines: parsed.records.map(renderDnsProbe),
      metadata: { resolvedNames: parsed.records.filter((item) => Object.values(item.records).some((values) => values.length)).length }
    });
  }
};

function renderDnsProbe(item: DnsProbeRecord): string {
  const answers = Object.entries(item.records).flatMap(([type, values]) => values.map((value) => `${type.toUpperCase()} ${value}`));
  return `${item.name}${answers.length ? ` · ${answers.join(" · ")}` : " · no answers"}`;
}
