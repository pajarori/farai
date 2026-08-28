import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { taxonomyDir } from "../paths";
import type { KnowledgeEdge, KnowledgeNode } from "../types";

export type TaxonomyMeta = {
  id: string;
  sourceUrl: string;
  pin: string;
  license: string;
  attribution: string;
  retrievedAt: string;
};

export type TaxonomyDir = { meta: TaxonomyMeta; dir: string };

export function writeTaxonomy(meta: TaxonomyMeta, nodes: KnowledgeNode[], edges: KnowledgeEdge[]): string {
  const dir = join(taxonomyDir(), `${meta.id}@${meta.pin}`);
  const temporary = `${dir}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(taxonomyDir(), { recursive: true });
  mkdirSync(temporary, { recursive: true });
  try {
    writeFileSync(join(temporary, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    writeFileSync(join(temporary, "nodes.jsonl"), nodes.map((node) => JSON.stringify(node)).join("\n") + (nodes.length ? "\n" : ""));
    writeFileSync(join(temporary, "edges.jsonl"), edges.map((edge) => JSON.stringify(edge)).join("\n") + (edges.length ? "\n" : ""));
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    renameSync(temporary, dir);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

export function listTaxonomies(): TaxonomyDir[] {
  const root = taxonomyDir();
  if (!existsSync(root)) return [];
  const out: TaxonomyDir[] = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    const metaPath = join(dir, "meta.json");
    if (!existsSync(metaPath)) continue;
    try {
      out.push({ meta: JSON.parse(readFileSync(metaPath, "utf8")) as TaxonomyMeta, dir });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.meta.id.localeCompare(b.meta.id) || b.meta.retrievedAt.localeCompare(a.meta.retrievedAt) || b.meta.pin.localeCompare(a.meta.pin));
}

export function latestTaxonomies(): TaxonomyDir[] {
  const latest = new Map<string, TaxonomyDir>();
  for (const taxonomy of listTaxonomies()) if (!latest.has(taxonomy.meta.id)) latest.set(taxonomy.meta.id, taxonomy);
  return [...latest.values()].sort((a, b) => a.meta.id.localeCompare(b.meta.id));
}

export function readNodes(dir: string): KnowledgeNode[] {
  return readJsonl<KnowledgeNode>(join(dir, "nodes.jsonl"));
}

export function readEdges(dir: string): KnowledgeEdge[] {
  return readJsonl<KnowledgeEdge>(join(dir, "edges.jsonl"));
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      continue;
    }
  }
  return out;
}
