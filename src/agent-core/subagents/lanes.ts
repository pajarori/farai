import { existsSync } from "node:fs";
import { join } from "node:path";
import { localFaraiDir } from "../global-config";
import { readBoundedFileTextSync } from "../../file-read";
import { atomicWriteFile } from "../atomic-file";

const LANE_CONFIG_MAX_BYTES = 2 * 1024 * 1024;

export type LaneDefinition = {
  id: string;
  description?: string;
  prompt?: string;
  tools?: string[];
  model?: string;
};

export const BUILTIN_LANES: LaneDefinition[] = [
  {
    id: "recon",
    description: "basic attack-surface reconnaissance: subdomains, dns, live probing, and crawling",
    prompt: [
      "You are a focused reconnaissance subagent. Map only the delegated target's attack surface using passive and light-active discovery: subdomain enumeration, DNS records, live HTTP/TLS probing, content and URL discovery, and crawling.",
      "Scope: discovery only. Do NOT exploit, brute-force, run broad port or vulnerability scanners, or perform intrusive testing — those belong to other lanes. Prefer the typed discovery tools; use shell only to run a recon CLI when no typed tool covers the need.",
      "Deduplicate assets, preserve exact evidence, and record the source and confidence of each item. Return a structured inventory: subdomains/hosts, resolved DNS, live services with status code and detected technology, discovered URLs and paths, and TLS facts — separating confirmed from uncertain. End with coverage gaps and the highest-value next recon steps for the parent."
    ].join("\n\n"),
    tools: [
      "asset_subdomains", "dns_resolve", "service_probe", "tls_inspect", "url_discover", "web_crawl", "web_directory",
      "kali_search", "command_run", "command_input", "command_poll", "command_stop",
      "campaign_manage", "knowledge_manage", "output_read", "agent_manage"
    ]
  }
];

export function laneConfigPaths(workspace: string): string[] {
  if (process.env.NODE_ENV === "test") return [join(workspace, ".farai", "agents.json")];
  return [join(localFaraiDir(), "agents.json"), join(workspace, ".farai", "agents.json")];
}

export function loadLanes(workspace: string): LaneDefinition[] {
  const merged = new Map(BUILTIN_LANES.map((lane) => [lane.id, structuredClone(lane)]));
  for (const path of laneConfigPaths(workspace)) {
    if (!existsSync(path)) continue;
    try {
      const parsed: unknown = JSON.parse(readBoundedFileTextSync(path, LANE_CONFIG_MAX_BYTES, "agent lane config"));
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        const lane = normalizeLane(entry);
        if (lane) merged.set(lane.id, { ...merged.get(lane.id), ...lane });
      }
    } catch {
      continue;
    }
  }
  return [...merged.values()];
}

export function resolveLane(workspace: string, id: string): LaneDefinition | undefined {
  return loadLanes(workspace).find((lane) => lane.id === id);
}

export function laneWriteTarget(workspace: string): string {
  return laneConfigPaths(workspace)[0]!;
}

export function readLaneFile(path: string): LaneDefinition[] {
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readBoundedFileTextSync(path, LANE_CONFIG_MAX_BYTES, "agent lane config"));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const lane = normalizeLane(entry);
      return lane ? [lane] : [];
    });
  } catch {
    return [];
  }
}

export function writeLaneFile(path: string, lanes: LaneDefinition[]): void {
  atomicWriteFile(path, `${JSON.stringify(lanes, null, 2)}\n`, 0o600);
}

function normalizeLane(value: unknown): LaneDefinition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(candidate.id.trim())) return undefined;
  const tools = Array.isArray(candidate.tools)
    ? [...new Set(candidate.tools.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))]
    : undefined;
  return {
    id: candidate.id.trim(),
    ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
    ...(typeof candidate.prompt === "string" ? { prompt: candidate.prompt } : {}),
    ...(tools && tools.length ? { tools } : {}),
    ...(typeof candidate.model === "string" ? { model: candidate.model } : {})
  };
}
