import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fetchGitSource } from "./git-source";
import { chunkMarkdownByHeading } from "./markdown-chunk";
import { extractEntities, recordId, sourceHash, writePack, type NormalizedRecord } from "../pack";
import type { KnowledgeEntity, KnowledgePackMeta } from "../types";

const SOURCE = {
  id: "hacktricks",
  url: "https://github.com/HackTricks-wiki/hacktricks.git",
  branch: "master",
  sparse: ["/src/**/*.md"]
};

export function ingestHacktricks(): { dir: string; records: number } {
  const fetched = fetchGitSource(SOURCE);
  const srcDir = join(fetched.dir, "src");
  const meta: KnowledgePackMeta = {
    id: "hacktricks",
    sourceUrl: "https://github.com/HackTricks-wiki/hacktricks",
    pin: fetched.pin,
    license: "CC-BY-NC-4.0",
    attribution: "Carlos Polop / HackTricks",
    signed: fetched.signed,
    ...(fetched.signer ? { signer: fetched.signer } : {}),
    category: "technique",
    kind: "prose",
    builderVersion: 1,
    retrievedAt: new Date().toISOString(),
    fields: { query: "heading_path", answer: "body", context: "doc_path" }
  };
  const records: NormalizedRecord[] = [];
  const entities: KnowledgeEntity[] = [];
  for (const file of markdownFiles(srcDir)) {
    const docPath = relative(srcDir, file);
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
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else if (entry.toLowerCase().endsWith(".md")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}
