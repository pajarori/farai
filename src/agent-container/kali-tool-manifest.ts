import { readFileSync } from "node:fs";
import { join } from "node:path";

export type KaliToolManifest = {
  contract: string;
  aptPackages: string[];
  workflows: Record<string, string[]>;
};

export const KALI_TOOL_MANIFEST_PATH = join(import.meta.dir, "..", "..", "docker", "kali", "farai-tool-manifest.json");
export const KALI_TOOL_MANIFEST = parseManifest(JSON.parse(readFileSync(KALI_TOOL_MANIFEST_PATH, "utf8")));

function parseManifest(value: unknown): KaliToolManifest {
  if (!value || typeof value !== "object") throw new Error("invalid farai tool manifest");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.contract !== "string" || !candidate.contract || !Array.isArray(candidate.aptPackages) || !candidate.workflows || typeof candidate.workflows !== "object") {
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
  return { contract: candidate.contract, aptPackages, workflows };
}
