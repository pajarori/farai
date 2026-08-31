import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { taxonomyDir } from "../paths";
import type { KnowledgeEdge, KnowledgeNode } from "../types";
import { forEachFileLineSync, readBoundedFileTextSyncNoFollow } from "../../file-read";
import { atomicWriteFile, syncDirectory } from "../../agent-core/atomic-file";
import { ensurePrivateDirectory } from "../../agent-core/private-path";

const TAXONOMY_META_MAX_BYTES = 1024 * 1024;
const TAXONOMY_JSONL_MAX_BYTES = 256 * 1024 * 1024;
const TAXONOMY_LINE_MAX_BYTES = 4 * 1024 * 1024;
const TAXONOMY_ENTRY_MAX_COUNT = 1_000_000;
const TAXONOMY_DIRECTORY_MAX_COUNT = 4_096;

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
  assertPathPart(meta.id, "taxonomy id");
  assertPathPart(meta.pin, "taxonomy pin");
  const root = taxonomyDir();
  ensurePrivateDirectory(root, "knowledge taxonomy directory");
  const dir = join(root, `${meta.id}@${meta.pin}`);
  const temporary = `${dir}.tmp-${process.pid}-${randomUUID()}`;
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  try {
    atomicWriteFile(join(temporary, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, 0o600);
    writeJsonl(join(temporary, "nodes.jsonl"), nodes, "taxonomy nodes");
    writeJsonl(join(temporary, "edges.jsonl"), edges, "taxonomy edges");
    if (realDirectoryExists(dir, "knowledge taxonomy")) rmSync(dir, { recursive: true, force: true });
    renameSync(temporary, dir);
    syncDirectory(root);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

function writeJsonl(path: string, values: unknown[], label: string): void {
  const descriptor = openSync(path, "wx", 0o600);
  let totalBytes = 0;
  try {
    for (const value of values) {
      const line = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
      if (line.byteLength > TAXONOMY_LINE_MAX_BYTES) throw new Error(`${label} line exceeded ${TAXONOMY_LINE_MAX_BYTES} bytes`);
      totalBytes += line.byteLength;
      if (totalBytes > TAXONOMY_JSONL_MAX_BYTES) throw new Error(`${label} exceeded ${TAXONOMY_JSONL_MAX_BYTES} bytes`);
      let offset = 0;
      while (offset < line.byteLength) {
        const written = writeSync(descriptor, line, offset, line.byteLength - offset);
        if (written <= 0) throw new Error(`${label} write made no progress`);
        offset += written;
      }
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function listTaxonomies(): TaxonomyDir[] {
  const root = taxonomyDir();
  if (!existsSync(root)) return [];
  assertRealDirectory(root, "knowledge taxonomy directory");
  const entries = readdirSync(root);
  if (entries.length > TAXONOMY_DIRECTORY_MAX_COUNT) throw new Error(`knowledge taxonomy directory exceeded ${TAXONOMY_DIRECTORY_MAX_COUNT} entries`);
  const out: TaxonomyDir[] = [];
  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      assertRealDirectory(dir, "knowledge taxonomy");
      const metaPath = join(dir, "meta.json");
      if (!existsSync(metaPath)) continue;
      const meta = JSON.parse(readBoundedFileTextSyncNoFollow(metaPath, TAXONOMY_META_MAX_BYTES, "taxonomy metadata")) as TaxonomyMeta;
      if (typeof meta?.id !== "string" || typeof meta.pin !== "string" || typeof meta.retrievedAt !== "string") continue;
      out.push({ meta, dir });
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
  assertRealDirectory(dir, "knowledge taxonomy");
  return readJsonl<KnowledgeNode>(join(dir, "nodes.jsonl"));
}

export function readEdges(dir: string): KnowledgeEdge[] {
  assertRealDirectory(dir, "knowledge taxonomy");
  return readJsonl<KnowledgeEdge>(join(dir, "edges.jsonl"));
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  forEachFileLineSync(path, { label: "taxonomy data", maxBytes: TAXONOMY_JSONL_MAX_BYTES, maxLineBytes: TAXONOMY_LINE_MAX_BYTES, noFollow: true }, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (out.length >= TAXONOMY_ENTRY_MAX_COUNT) throw new Error(`taxonomy data exceeded ${TAXONOMY_ENTRY_MAX_COUNT} entries`);
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
    }
  });
  return out;
}

function assertPathPart(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value)) throw new Error(`${label} is invalid`);
}

function realDirectoryExists(path: string, label: string): boolean {
  if (!existsSync(path)) return false;
  assertRealDirectory(path, label);
  return true;
}

function assertRealDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory`);
}
