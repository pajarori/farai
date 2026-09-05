import { join } from "node:path";
import { localFaraiDir } from "../agent-core/config";
import { activeContentKnowledgePath } from "../agent-content/paths";

export function knowledgeDbPath(): string {
  return activeContentKnowledgePath() ?? legacyKnowledgeDbPath();
}

export function legacyKnowledgeDbPath(): string {
  return join(localFaraiDir(), "knowledge.db");
}
