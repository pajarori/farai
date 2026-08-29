import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { safeExistingWorkspacePath } from "./shared";

type NotebookCell = { id?: string; cell_type: string; source: string[]; metadata?: Record<string, unknown>; outputs?: unknown[]; execution_count?: number | null };
type Notebook = { cells: NotebookCell[]; metadata?: Record<string, unknown>; nbformat: number; nbformat_minor: number };

export const notebookEditTool: ToolDefinition = {
  name: "notebook_edit",
  description: "Insert, replace, or delete a Jupyter notebook cell while preserving notebook and cell metadata.",
  inputSchema: {
    type: "object",
    required: ["path", "operation", "index"],
    properties: {
      path: { type: "string" },
      operation: { type: "string", enum: ["insert_cell", "replace_cell", "delete_cell"] },
      index: { type: "number", minimum: 0 },
      cellType: { type: "string", enum: ["code", "markdown", "raw"] },
      source: { type: "string" }
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 10_000,
  parallel: false,
  concurrencyScope: "workspace",
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const requested = asString(args.path, "path");
    const path = safeExistingWorkspacePath(context.workspace, requested, "write");
    const notebook = parseNotebook(readFileSync(path, "utf8"));
    if (typeof args.index !== "number" || !Number.isFinite(args.index) || !Number.isInteger(args.index)) throw new Error("index must be a finite integer");
    const index = args.index;
    const operation = asString(args.operation, "operation");
    if (operation !== "insert_cell" && operation !== "replace_cell" && operation !== "delete_cell") throw new Error(`unsupported notebook operation: ${operation}`);
    if (args.cellType !== undefined && args.cellType !== "code" && args.cellType !== "markdown" && args.cellType !== "raw") {
      throw new Error("cellType must be code, markdown, or raw");
    }
    if (index < 0 || index > notebook.cells.length || (operation !== "insert_cell" && index >= notebook.cells.length)) throw new Error(`cell index out of range: ${index}`);
    if (operation === "delete_cell") notebook.cells.splice(index, 1);
    else {
      if (typeof args.source !== "string") throw new Error(`${operation} requires source`);
      const source = args.source;
      if (operation === "insert_cell") {
        const cellType = typeof args.cellType === "string" ? args.cellType : "code";
        notebook.cells.splice(index, 0, newCell(cellType, source, notebook.nbformat === 4 && notebook.nbformat_minor >= 5));
      }
      else {
        const current = notebook.cells[index]!;
        const cellType = args.cellType === "code" || args.cellType === "markdown" || args.cellType === "raw" ? args.cellType : current.cell_type;
        notebook.cells[index] = { ...current, cell_type: cellType, source: sourceLines(source), ...(cellType === "code" ? { outputs: current.outputs ?? [], execution_count: current.execution_count ?? null } : {}) };
        if (cellType !== "code") { delete notebook.cells[index]!.outputs; delete notebook.cells[index]!.execution_count; }
      }
    }
    writeNotebookAtomically(path, `${JSON.stringify(notebook, null, 1)}\n`);
    context.fileState?.invalidate(context.session.id, `/workspace/${requested.replace(/^\.\//, "")}`);
    return { ok: true, summary: `${operation} at cell ${index}`, output: `${requested}: ${notebook.cells.length} cells` };
  }
};

function parseNotebook(text: string): Notebook {
  const value = JSON.parse(text) as Partial<Notebook>;
  if (!Array.isArray(value.cells) || !Number.isInteger(value.nbformat) || !Number.isInteger(value.nbformat_minor)) throw new Error("invalid Jupyter notebook");
  for (const [index, cell] of value.cells.entries()) {
    if (!cell || typeof cell !== "object" || Array.isArray(cell)) throw new Error(`invalid Jupyter notebook cell at index ${index}`);
    const candidate = cell as Partial<NotebookCell>;
    if (!["code", "markdown", "raw"].includes(candidate.cell_type ?? "") || !Array.isArray(candidate.source) || candidate.source.some((line) => typeof line !== "string")) {
      throw new Error(`invalid Jupyter notebook cell at index ${index}`);
    }
  }
  return value as Notebook;
}

function writeNotebookAtomically(path: string, content: string): void {
  const mode = statSync(path).mode & 0o777;
  const temporary = join(dirname(path), `.${basename(path)}.farai-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { }
  }
}

function newCell(cellType: string, source: string, includeId: boolean): NotebookCell {
  return {
    ...(includeId ? { id: randomUUID() } : {}),
    cell_type: cellType,
    metadata: {},
    source: sourceLines(source),
    ...(cellType === "code" ? { outputs: [], execution_count: null } : {})
  };
}

function sourceLines(source: string): string[] {
  const lines = source.split(/(?<=\n)/);
  return lines.length ? lines : [""];
}
