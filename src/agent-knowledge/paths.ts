import { join } from "node:path";
import { localFaraiDir } from "../agent-core/config";
import { activeContentKnowledgePath } from "../agent-content/paths";

export function knowledgeDbPath(): string {
  return activeContentKnowledgePath() ?? legacyKnowledgeDbPath();
}

export function legacyKnowledgeDbPath(): string {
  return join(localFaraiDir(), "knowledge.db");
}

export function knowledgeRoot(): string {
  return process.env.FARAI_KNOWLEDGE_DIR ?? join(localFaraiDir(), "knowledge");
}

export function packsDir(): string {
  return join(knowledgeRoot(), "packs");
}

export function taxonomyDir(): string {
  return join(knowledgeRoot(), "taxonomy");
}

export function cacheDir(): string {
  return join(localFaraiDir(), "knowledge-cache");
}
