import { existsSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { posix } from "node:path";
import { CONTAINER_WORKSPACE_MOUNT } from "../agent-container/kali";
import type { LspServerId } from "./types";

export type LspServerDefinition = {
  id: LspServerId;
  command: string[];
  extensions: string[];
  languageId(path: string): string;
  projectRoot(workspace: string, hostFilePath: string): string;
};

function nearestRoot(workspace: string, filePath: string, markerGroups: string[][]): string {
  const workspaceRoot = resolve(workspace);
  const start = dirname(filePath);
  for (const markers of markerGroups) {
    let current = start;
    while (current === workspaceRoot || current.startsWith(`${workspaceRoot}${sep}`)) {
      if (markers.some((marker) => existsSync(join(current, marker)))) return current;
      if (current === workspaceRoot) break;
      current = dirname(current);
    }
  }
  return workspaceRoot;
}

const definitions: LspServerDefinition[] = [
  {
    id: "typescript",
    command: ["typescript-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    languageId: (path) => {
      const ext = extname(path).toLowerCase();
      if (ext === ".tsx") return "typescriptreact";
      if (ext === ".jsx") return "javascriptreact";
      return [".js", ".mjs", ".cjs"].includes(ext) ? "javascript" : "typescript";
    },
    projectRoot: (workspace, filePath) => nearestRoot(workspace, filePath, [["tsconfig.json", "package.json"]])
  },
  {
    id: "pyright",
    command: ["pyright-langserver", "--stdio"],
    extensions: [".py", ".pyi"],
    languageId: () => "python",
    projectRoot: (workspace, filePath) => nearestRoot(workspace, filePath, [["pyproject.toml", "setup.py", "requirements.txt"]])
  },
  {
    id: "gopls",
    command: ["gopls", "serve"],
    extensions: [".go"],
    languageId: () => "go",
    projectRoot: (workspace, filePath) => nearestRoot(workspace, filePath, [["go.work"], ["go.mod"]])
  },
  {
    id: "rust-analyzer",
    command: ["rust-analyzer"],
    extensions: [".rs"],
    languageId: () => "rust",
    projectRoot: (workspace, filePath) => nearestRoot(workspace, filePath, [["Cargo.toml"]])
  }
];

export const LSP_SERVER_DEFINITIONS: Readonly<Record<LspServerId, LspServerDefinition>> = Object.freeze(
  Object.fromEntries(definitions.map((definition) => [definition.id, definition])) as Record<LspServerId, LspServerDefinition>
);

export function resolveLspFile(workspace: string, path: string, containerWorkspace = CONTAINER_WORKSPACE_MOUNT): {
  definition: LspServerDefinition;
  hostPath: string;
  containerPath: string;
  projectRoot: string;
} | undefined {
  const containerPath = posix.normalize(path.startsWith("/") ? path : `${containerWorkspace}/${path}`);
  if (containerPath !== containerWorkspace && !containerPath.startsWith(`${containerWorkspace}/`)) return undefined;
  const rel = posix.relative(containerWorkspace, containerPath);
  const hostPath = resolve(workspace, rel);
  const workspaceRoot = resolve(workspace);
  if (hostPath !== workspaceRoot && !hostPath.startsWith(`${workspaceRoot}${sep}`)) return undefined;
  const ext = extname(hostPath).toLowerCase();
  const definition = definitions.find((candidate) => candidate.extensions.includes(ext));
  if (!definition) return undefined;
  const hostProjectRoot = definition.projectRoot(workspaceRoot, hostPath);
  const rootRel = relative(workspaceRoot, hostProjectRoot).split(sep).join("/");
  const projectRoot = rootRel ? `${containerWorkspace}/${rootRel}` : containerWorkspace;
  return { definition, hostPath, containerPath, projectRoot };
}
