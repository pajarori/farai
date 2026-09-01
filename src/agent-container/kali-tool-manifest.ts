import { join } from "node:path";
import { readBoundedFileTextSync } from "../file-read";

export type KaliToolManifest = {
  contract: string;
  aptPackages: string[];
  pinnedTools: Record<string, { version: string; sha256: Record<"amd64" | "arm64", string> }>;
  pinnedAssets: Record<string, { version: string; path: string; sha256: string }>;
  workflows: Record<string, string[]>;
};

export const KALI_TOOL_MANIFEST_PATH = join(import.meta.dir, "..", "..", "docker", "kali", "farai-tool-manifest.json");
export const KALI_TOOL_MANIFEST = parseManifest(JSON.parse(readBoundedFileTextSync(KALI_TOOL_MANIFEST_PATH, 1024 * 1024, "kali tool manifest")));

function parseManifest(value: unknown): KaliToolManifest {
  if (!value || typeof value !== "object") throw new Error("invalid farai tool manifest");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.contract !== "string" || !candidate.contract || !Array.isArray(candidate.aptPackages) || !candidate.pinnedTools || typeof candidate.pinnedTools !== "object" || !candidate.pinnedAssets || typeof candidate.pinnedAssets !== "object" || !candidate.workflows || typeof candidate.workflows !== "object") {
    throw new Error("invalid farai tool manifest");
  }
  const aptPackages = candidate.aptPackages.filter((item): item is string => typeof item === "string" && Boolean(item));
  if (!aptPackages.length || aptPackages.length !== candidate.aptPackages.length || new Set(aptPackages).size !== aptPackages.length) {
    throw new Error("invalid farai tool package list");
  }
  const workflows = Object.fromEntries(Object.entries(candidate.workflows as Record<string, unknown>).map(([name, items]) => {
    if (!name || !Array.isArray(items) || !items.length || items.some((item) => typeof item !== "string" || !item) || new Set(items).size !== items.length) {
      throw new Error(`invalid farai tool workflow: ${name}`);
    }
    return [name, items as string[]];
  }));
  if (!Object.keys(workflows).length) throw new Error("empty farai tool manifest");
  const pinnedTools = Object.fromEntries(Object.entries(candidate.pinnedTools as Record<string, unknown>).map(([name, value]) => {
    if (!name || !value || typeof value !== "object") throw new Error(`invalid pinned tool: ${name}`);
    const tool = value as Record<string, unknown>;
    const sha256 = tool.sha256 as Record<string, unknown> | undefined;
    if (typeof tool.version !== "string" || !tool.version || !sha256 || !isSha256(sha256.amd64) || !isSha256(sha256.arm64)) throw new Error(`invalid pinned tool: ${name}`);
    return [name, { version: tool.version, sha256: { amd64: sha256.amd64, arm64: sha256.arm64 } }];
  }));
  if (!Object.keys(pinnedTools).length) throw new Error("empty pinned tool manifest");
  const pinnedAssets = Object.fromEntries(Object.entries(candidate.pinnedAssets as Record<string, unknown>).map(([name, value]) => {
    if (!name || !value || typeof value !== "object") throw new Error(`invalid pinned asset: ${name}`);
    const asset = value as Record<string, unknown>;
    if (typeof asset.version !== "string" || !asset.version || typeof asset.path !== "string" || !asset.path.startsWith("/") || !isSha256(asset.sha256)) throw new Error(`invalid pinned asset: ${name}`);
    return [name, { version: asset.version, path: asset.path, sha256: asset.sha256 }];
  }));
  if (!Object.keys(pinnedAssets).length) throw new Error("empty pinned asset manifest");
  return { contract: candidate.contract, aptPackages, pinnedTools, pinnedAssets, workflows };
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
