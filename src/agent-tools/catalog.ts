import type { Session, ToolDefinition, ToolProvenance } from "../types";
import { canonicalToolName } from "../tool-names";
import { getToolRegistry, getTool } from "./registry";
import { listMcpServerStatuses, listMcpTools } from "./mcp-manager";

export type ToolCatalogEntry = Readonly<{
  name: string;
  description: string;
  visibility?: ToolDefinition["visibility"];
  mutates: boolean;
  provenance: ToolProvenance;
  loaded: boolean;
}>;

export type ToolSearchQuery = Readonly<{
  text: string;
  limit?: number;
  visibility?: ToolDefinition["visibility"];
}>;

export class ToolCatalog {
  constructor(private readonly session?: Session) {}

  list(): readonly ToolCatalogEntry[] {
    const builtins = getToolRegistry().list().map((registration) => registration.spec);
    const mcp = listMcpTools(this.session);
    const loaded = new Set(mcp.map((tool) => canonicalToolName(tool.name)));
    const mcpStatus = listMcpServerStatuses(this.session);
    const entries = [
      ...builtins.map((spec) => ({
        name: spec.name,
        description: spec.description,
        ...(spec.visibility ? { visibility: spec.visibility } : {}),
        mutates: spec.mutates,
        provenance: spec.provenance,
        loaded: true
      })),
      ...mcp.map((tool) => ({
        name: canonicalToolName(tool.name),
        description: tool.description,
        ...(tool.visibility ? { visibility: tool.visibility } : {}),
        mutates: tool.mutates,
        provenance: tool.provenance ?? { source: "mcp" as const },
        loaded: loaded.has(canonicalToolName(tool.name))
      })),
      ...mcpStatus.flatMap((status) => (status.toolDetails ?? status.tools.map((name) => ({ name }))).map((tool) => ({
        name: canonicalToolName(tool.name),
        description: typeof (tool as { description?: unknown }).description === "string" && (tool as unknown as { description: string }).description
          ? (tool as unknown as { description: string }).description
          : `MCP tool from ${status.name}`,
        mutates: true,
        provenance: { source: "mcp" as const, server: status.name },
        loaded: loaded.has(canonicalToolName(tool.name))
      })))
    ];
    const seen = new Set<string>();
    return entries.filter((entry) => {
      if (seen.has(entry.name)) return false;
      seen.add(entry.name);
      return true;
    });
  }

  search(query: ToolSearchQuery): readonly ToolCatalogEntry[] {
    const text = query.text.trim().toLowerCase();
    const limit = Math.max(1, Math.min(50, query.limit ?? 10));
    return this.list()
      .filter((entry) => !query.visibility || entry.visibility === query.visibility)
      .map((entry) => ({ entry, score: scoreEntry(entry, text) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
      .slice(0, limit)
      .map((item) => item.entry);
  }

  load(names: readonly string[]): readonly ToolDefinition[] {
    return [...new Set(names.map(canonicalToolName))]
      .map((name) => getTool(name, this.session))
      .filter((tool): tool is ToolDefinition => tool !== undefined);
  }
}

function scoreEntry(entry: ToolCatalogEntry, query: string): number {
  if (!query) return 1;
  const name = entry.name.toLowerCase();
  const description = entry.description.toLowerCase();
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 60;
  if (description.includes(query)) return 30;
  const terms = query.split(/\s+/).filter(Boolean);
  return terms.every((term) => name.includes(term) || description.includes(term)) ? 20 : 0;
}

export function toolCatalog(session?: Session): ToolCatalog {
  return new ToolCatalog(session);
}
