import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fetchGitSource } from "./git-source";
import { chunkMarkdownByHeading } from "./markdown-chunk";
import { extractEntities, recordId, sourceHash, writePack, type NormalizedRecord } from "../pack";
import type { KnowledgeEntity, KnowledgePackMeta } from "../types";

const SOURCE = {
  id: "payloads",
  url: "https://github.com/swisskyrepo/PayloadsAllTheThings.git",
  branch: "master"
};

export function ingestPayloads(): { dir: string; records: number } {
  const fetched = fetchGitSource(SOURCE);
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
    const text = readFileSync(file, "utf8");
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
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === ".git") continue;
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else if (entry.toLowerCase().endsWith(".md")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}
