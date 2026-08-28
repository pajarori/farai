import { fileURLToPath } from "node:url";
import type { LspInspectEntry, LspInspectOperation } from "./types";

const SYMBOL_KINDS = [
  "", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor",
  "enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object",
  "key", "null", "enum-member", "struct", "event", "operator", "type-parameter"
];

export function normalizeInspectEntries(operation: LspInspectOperation, raw: unknown, currentPath?: string): LspInspectEntry[] {
  if (operation === "hover") {
    const detail = hoverText(raw);
    return detail ? [{ ...(currentPath ? { path: currentPath } : {}), detail }] : [];
  }
  if (operation === "document_symbols") return documentSymbols(raw, currentPath);
  if (operation === "workspace_symbols") return workspaceSymbols(raw);
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return values.flatMap((value) => locationEntry(value) ?? []);
}

function documentSymbols(raw: unknown, currentPath?: string): LspInspectEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: LspInspectEntry[] = [];
  const visit = (value: unknown): void => {
    if (!isRecord(value) || typeof value.name !== "string") return;
    if (isRecord(value.location)) {
      const location = locationEntry(value.location);
      const kind = symbolKind(value.kind);
      if (location) entries.push({ ...location, name: value.name, ...(kind ? { kind } : {}), ...(typeof value.containerName === "string" ? { detail: value.containerName } : {}) });
      return;
    }
    const range = isRange(value.selectionRange) ? value.selectionRange : isRange(value.range) ? value.range : undefined;
    const kind = symbolKind(value.kind);
    entries.push({
      ...(currentPath ? { path: currentPath } : {}),
      ...(range ? rangeFields(range) : {}),
      name: value.name,
      ...(kind ? { kind } : {}),
      ...(typeof value.detail === "string" ? { detail: value.detail } : {})
    });
    if (Array.isArray(value.children)) for (const child of value.children) visit(child);
  };
  for (const value of raw) visit(value);
  return entries;
}

function workspaceSymbols(raw: unknown): LspInspectEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: LspInspectEntry[] = [];
  for (const value of raw) {
    if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.location)) continue;
    const location = locationEntry(value.location);
    if (!location) continue;
    const kind = symbolKind(value.kind);
    entries.push({
      ...location,
      name: value.name,
      ...(kind ? { kind } : {}),
      ...(typeof value.containerName === "string" ? { detail: value.containerName } : {})
    });
  }
  return entries;
}

function locationEntry(value: unknown): LspInspectEntry | undefined {
  if (!isRecord(value)) return undefined;
  const uri = typeof value.uri === "string" ? value.uri : typeof value.targetUri === "string" ? value.targetUri : undefined;
  const range = isRange(value.range)
    ? value.range
    : isRange(value.targetSelectionRange)
      ? value.targetSelectionRange
      : isRange(value.targetRange)
        ? value.targetRange
        : undefined;
  if (!uri || !range) return undefined;
  const path = relativeWorkspacePath(uri);
  if (!path) return undefined;
  return { path, ...rangeFields(range) };
}

function relativeWorkspacePath(uri: string): string | undefined {
  try {
    const path = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
    if (path === "/workspace") return ".";
    return path.startsWith("/workspace/") ? path.slice("/workspace/".length) : undefined;
  } catch {
    return undefined;
  }
}

function rangeFields(range: { start: { line: number; character: number }; end: { line: number; character: number } }): Pick<LspInspectEntry, "line" | "column" | "endLine" | "endColumn"> {
  return {
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1
  };
}

function hoverText(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  return markupText(raw.contents);
}

function markupText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(markupText).filter((item): item is string => !!item).join("\n");
  if (isRecord(value) && typeof value.value === "string") return value.value;
  return undefined;
}

function symbolKind(value: unknown): string | undefined {
  return typeof value === "number" ? SYMBOL_KINDS[value] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRange(value: unknown): value is { start: { line: number; character: number }; end: { line: number; character: number } } {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}

function isPosition(value: unknown): value is { line: number; character: number } {
  return isRecord(value) && typeof value.line === "number" && typeof value.character === "number";
}
