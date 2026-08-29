import { realpathSync } from "node:fs";
import { join, normalize, relative, resolve } from "node:path";
import { CONTAINER_WORKSPACE_MOUNT } from "../../agent-container/kali";

const ESCAPE_HINT = " Absolute paths outside the active workspace are not accepted here.";

function stripContainerWorkspaceMount(path: string): string {
  if (path === CONTAINER_WORKSPACE_MOUNT) return ".";
  const prefix = `${CONTAINER_WORKSPACE_MOUNT}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export function safePathInside(base: string, path: string): string {
  const resolved = normalize(join(base, stripContainerWorkspaceMount(path)));
  const rel = relative(base, resolved);
  if (rel.startsWith("..") || rel === "") throw new Error(`path escapes workspace${path.startsWith("/") ? ESCAPE_HINT : ""}`);
  return resolved;
}

export function safeWorkspacePath(workspace: string, path: string, intent: "read" | "write"): string {
  const normalizedInput = stripContainerWorkspaceMount(path);
  const resolved = normalize(resolve(workspace, normalizedInput));
  const rel = relative(workspace, resolved);
  if (rel.startsWith("..")) throw new Error(`path escapes workspace${path.startsWith("/") ? ESCAPE_HINT : ""}`);
  if (rel === "") {
    if (intent === "write") throw new Error("path escapes workspace");
    return resolved;
  }
  const normalized = rel.split(/[\\/]+/).join("/");
  if (normalized === ".farai" || normalized.startsWith(".farai/")) throw new Error("path is protected: .farai");
  return resolved;
}

export function safeExistingWorkspacePath(workspace: string, path: string, intent: "read" | "write"): string {
  const lexical = safeWorkspacePath(workspace, path, intent);
  const root = realpathSync(workspace);
  const resolved = realpathSync(lexical);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || rel === "") throw new Error(`path escapes workspace${path.startsWith("/") ? ESCAPE_HINT : ""}`);
  const normalized = rel.split(/[\\/]+/).join("/");
  if (normalized === ".farai" || normalized.startsWith(".farai/")) throw new Error("path is protected: .farai");
  return resolved;
}

export function page(items: string[], offset: unknown, limit: unknown): { items: string[]; start: number; end: number } {
  const start = typeof offset === "number" ? Math.max(1, Math.floor(offset)) : 1;
  const size = typeof limit === "number" ? Math.max(1, Math.min(500, Math.floor(limit))) : 200;
  const selected = items.slice(start - 1, start - 1 + size);
  return { items: selected, start, end: start + selected.length - 1 };
}

export function occurrences(text: string, search: string): number {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(search, index)) !== -1) {
    count++;
    index += search.length;
  }
  return count;
}

export function previewEdit(oldString: string, newString: string): string {
  return ["```diff", ...oldString.split("\n").slice(0, 8).map((line) => `-${line}`), ...newString.split("\n").slice(0, 8).map((line) => `+${line}`), "```"].join("\n");
}
