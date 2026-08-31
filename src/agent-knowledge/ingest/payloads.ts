import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fetchGitSource } from "./git-source";
import { chunkMarkdownByHeading } from "./markdown-chunk";
import { extractEntities, recordId, sourceHash, writePack, type NormalizedRecord } from "../pack";
import type { KnowledgeEntity, KnowledgePackMeta } from "../types";
import { readBoundedFileTextSyncNoFollow } from "../../file-read";

const MARKDOWN_MAX_BYTES = 16 * 1024 * 1024;
const MARKDOWN_FILE_MAX_COUNT = 100_000;
const WALK_ENTRY_MAX_COUNT = 250_000;

const SOURCE = {
  id: "payloads",
  url: "https://github.com/swisskyrepo/PayloadsAllTheThings.git",
  branch: "master"
};

export async function ingestPayloads(): Promise<{ dir: string; records: number }> {
  const fetched = await fetchGitSource(SOURCE);
  const meta: KnowledgePackMeta = {
    id: "payloads",
    sourceUrl: "https://github.com/swisskyrepo/PayloadsAllTheThings",
    pin: fetched.pin,
    license: "MIT",
    attribution: "Swissky / PayloadsAllTheThings",
    signed: fetched.signed,
    ...(fetched.signer ? { signer: fetched.signer } : {}),
    category: "payload",
    kind: "prose",
    builderVersion: 1,
    retrievedAt: new Date().toISOString(),
    fields: { query: "heading_path", answer: "body", context: "doc_path" }
  };
  const records: NormalizedRecord[] = [];
  const entities: KnowledgeEntity[] = [];
  for (const file of markdownFiles(fetched.dir)) {
    const docPath = relative(fetched.dir, file);
    if (docPath.startsWith(".github/")) continue;
    const text = readBoundedFileTextSyncNoFollow(file, MARKDOWN_MAX_BYTES, "payload markdown");
    let ordinal = 0;
    for (const chunk of chunkMarkdownByHeading(text)) {
      const id = recordId(meta.id, meta.pin, `${docPath}#${chunk.charStart}:${ordinal++}`);
      records.push({
        id,
        query: chunk.headingPath.join(" › ") || docPath,
        answer: chunk.body,
        context: docPath,
        category: meta.category,
        source: meta.id,
        docPath,
        headingPath: chunk.headingPath,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        sourceHash: sourceHash(chunk.body)
      });
      entities.push(...extractEntities(id, `${chunk.headingPath.join(" ")} ${chunk.body}`));
    }
  }
  const dir = writePack(meta, records, entities);
  return { dir, records: records.length };
}

function markdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("payload source root must be a real directory");
  const out: string[] = [];
  const pending = [root];
  let entries = 0;
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir)) {
      if (entry === ".git") continue;
      entries += 1;
      if (entries > WALK_ENTRY_MAX_COUNT) throw new Error(`payload source exceeded ${WALK_ENTRY_MAX_COUNT} entries`);
      const full = join(dir, entry);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) pending.push(full);
      else if (info.isFile() && entry.toLowerCase().endsWith(".md")) {
        if (out.length >= MARKDOWN_FILE_MAX_COUNT) throw new Error(`payload source exceeded ${MARKDOWN_FILE_MAX_COUNT} markdown files`);
        out.push(full);
      }
    }
  }
  return out.sort();
}
