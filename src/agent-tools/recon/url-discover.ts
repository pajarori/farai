import type { ToolDefinition } from "../../types";
import { assertObject } from "../../utils";
import { timeoutBackgroundResult } from "../shared/background-result";
import { backend } from "../shared/backend";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { inputFileCommand, integer, optionalStringList, parseJsonLines, projectDiscoveryResult, stringList, text, textArray, type JsonRecord } from "./projectdiscovery";

const PUBLIC_SOURCES = ["alienvault", "commoncrawl", "waybackarchive"] as const;

export type UrlDiscoverRecord = JsonRecord & {
  url: string;
  input: string;
  sources: string[];
};

export function buildUrlDiscoverCommand(args: Record<string, unknown>): string {
  const domains = stringList(args.domains, "domains", 500);
  const sources = optionalStringList(args.sources, "sources", PUBLIC_SOURCES.length);
  const selectedSources = sources.length ? sources : [...PUBLIC_SOURCES];
  if (selectedSources.some((value) => !PUBLIC_SOURCES.includes(value as typeof PUBLIC_SOURCES[number]))) throw new Error("sources contains a provider that requires credentials or is unsupported");
  const command = [
    "-jsonl", "-silent", "-nc", "-duc", "-cs", "-s", selectedSources.join(","),
    "-timeout", String(integer(args.timeoutSeconds, 30, 1, 120)), "-max-time", String(integer(args.maxMinutes, 10, 1, 60)),
    "-rl", String(integer(args.rateLimit, 50, 1, 1_000))
  ];
  const scope = typeof args.scope === "string" ? args.scope : "registrable_domain";
  if (scope === "none") command.push("-ns");
  else command.push("-fs", scope === "fqdn" ? "fqdn" : "rdn");
  return inputFileCommand("urlfinder", command, domains, "-d");
}

export function parseUrlDiscoverOutput(raw: string): { records: UrlDiscoverRecord[]; malformed: number } {
  const parsed = parseJsonLines(raw);
  return { records: parsed.records.map(normalizeUrlDiscover), malformed: parsed.malformed };
}

export const urlDiscoverTool: ToolDefinition = {
  name: "url_discover",
  description: "Discover historical and passive URLs associated with one or many domains through ProjectDiscovery urlfinder using public AlienVault, Common Crawl, and Wayback Archive sources. This does not request every discovered URL; use it to build an endpoint corpus, then validate selected URLs with http_probe, web_crawl, browser tools, or http_request.",
  inputSchema: {
    type: "object",
    required: ["domains"],
    properties: {
      domains: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 500, uniqueItems: true }] },
      sources: { type: "array", items: { type: "string", enum: [...PUBLIC_SOURCES] }, maxItems: PUBLIC_SOURCES.length, uniqueItems: true },
      scope: { type: "string", enum: ["fqdn", "registrable_domain", "none"] },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 },
      maxMinutes: { type: "integer", minimum: 1, maximum: 60 },
      rateLimit: { type: "integer", minimum: 1, maximum: 1_000 }
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 900_000,
  parallel: true,
  visibility: "recon",
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const kali = backend(context);
    const result = await kali.exec(buildUrlDiscoverCommand(args), 895_000, context.signal, 32_000_000);
    const converted = timeoutBackgroundResult("url_discover", kali, result);
    if (converted) return converted;
    const parsed = parseUrlDiscoverOutput(result.stdout);
    return projectDiscoveryResult(context, {
      tool: "url_discover",
      backend: "urlfinder",
      result,
      records: parsed.records,
      malformed: parsed.malformed,
      noun: "URL",
      outputLines: parsed.records.map((item) => `${item.url}${item.sources.length ? ` · ${item.sources.join(", ")}` : ""}`),
      metadata: {
        uniqueUrls: new Set(parsed.records.map((item) => item.url)).size,
        sources: [...new Set(parsed.records.flatMap((item) => item.sources))]
      }
    });
  }
};

function normalizeUrlDiscover(value: JsonRecord): UrlDiscoverRecord {
  return {
    url: text(value.url) ?? "unknown",
    input: text(value.input) ?? text(value.domain) ?? "unknown",
    sources: textArray(value.sources ?? value.source)
  };
}
