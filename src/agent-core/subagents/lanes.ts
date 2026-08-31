import { existsSync } from "node:fs";
import { join } from "node:path";
import { localFaraiDir } from "../global-config";
import { readBoundedFileTextSync } from "../../file-read";

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
    id: "explore",
    description: "read-only workspace exploration and codebase analysis",
    prompt: "Explore the workspace without modifying it. Return only the evidence, file references, conclusions, and unresolved questions needed by the parent.",
    tools: ["fs_list", "fs_grep", "fs_read", "git_status", "git_diff", "lsp_inspect", "tool_output_read"]
  },
  {
    id: "recon",
    description: "bounded infrastructure and attack-surface reconnaissance",
    prompt: "Perform only the delegated reconnaissance scope. Prefer typed discovery tools, preserve evidence, avoid duplicate probes, and return deduplicated assets with source status and uncertainty.",
    tools: [
      "subdomain_enum", "port_scan", "nmap_scan", "dir_enum", "exploit_search", "kali_tool_search", "shell_exec",
      "browser_context", "browser_navigate", "browser_snapshot", "browser_find", "browser_network_requests", "browser_network_request",
      "campaign_asset", "campaign_observe", "campaign_hypothesis", "campaign_search", "notes_add", "evidence_save",
      "session_poll", "session_stop", "tool_output_read"
    ]
  },
  {
    id: "web",
    description: "web application exploration and verification",
    prompt: "Audit only the delegated web scope. Use browser, HTTP, and shell capabilities as appropriate, preserve exact evidence, and return proven findings separately from uncertainty.",
    tools: [
      "browser_context", "browser_navigate", "browser_snapshot", "browser_find", "browser_click", "browser_fill_form", "browser_type",
      "browser_press_key", "browser_wait_for", "browser_tabs", "browser_network_requests", "browser_network_request",
      "email_list", "email_create", "email_inbox", "email_read", "email_wait",
      "http_request", "dir_enum", "exploit_search", "kali_tool_search", "shell_exec", "campaign_observe",
      "campaign_hypothesis", "campaign_test", "notes_add", "evidence_save", "session_poll", "session_stop", "tool_output_read"
    ]
  },
  {
    id: "code",
    description: "isolated software implementation, debugging, and review",
    prompt: "Handle only the delegated code task. Inspect before editing, preserve unrelated changes, make the smallest coherent patch, and return changed files, validation, and residual risk.",
    tools: [
      "fs_list", "fs_grep", "fs_read", "fs_write", "fs_edit", "patch_apply", "git_status", "git_diff",
      "lsp_inspect", "code_write_script", "shell_exec", "todo_add", "todo_update", "todo_list", "tool_output_read"
    ]
  },
  {
    id: "verify",
    description: "independent verification of evidence and candidate findings",
    prompt: "Independently verify only the delegated claim. Establish a baseline, run the smallest discriminating test, save evidence, and return proven, disproven, or inconclusive with exact reasoning.",
    tools: [
      "browser_context", "browser_navigate", "browser_snapshot", "browser_find", "browser_network_requests", "browser_network_request",
      "http_request", "shell_exec", "campaign_search", "campaign_test", "campaign_verify", "evidence_save",
      "report_add_finding", "tool_output_read"
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
