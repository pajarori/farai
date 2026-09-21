import type { ToolDefinition } from "../../types";
import type { LspInspectOperation, LspInspectResult } from "../../agent-lsp";
import { formatInspectResult } from "../../agent-lsp";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { containerReadFile } from "../filesystem/container-fs";

const OPERATIONS = new Set<LspInspectOperation>([
  "definition",
  "references",
  "hover",
  "document_symbols",
  "workspace_symbols"
]);

export const lspInspectTool: ToolDefinition = {
  name: "lsp_inspect",
  description: "Query a language server for definitions, references, hover information, document symbols, or workspace symbols in TypeScript, Python, Go, or Rust. Use this for semantic code navigation that text search cannot provide; positional operations require 1-based line and column values.",
  inputSchema: {
    type: "object",
    required: ["operation", "path"],
    properties: {
      operation: { type: "string", enum: [...OPERATIONS] },
      path: { type: "string", description: "Workspace file path; workspace_symbols uses it to select the language server." },
      line: { type: "number", description: "1-based line for definition, references, or hover." },
      column: { type: "number", description: "1-based column for definition, references, or hover." },
      query: { type: "string", description: "Search query for workspace_symbols." }
    }
  },
  mutates: false,
  timeoutMs: Number.POSITIVE_INFINITY,
  parallel: true,
  visibility: "workspace",
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    if (!context.lsp) throw new Error("LSP is unavailable in this runtime");
    assertObject(args, "args");
    const operation = asString(args.operation, "operation") as LspInspectOperation;
    if (!OPERATIONS.has(operation)) throw new Error(`unsupported LSP operation: ${operation}; use one of: ${[...OPERATIONS].join(", ")}`);
    const path = asString(args.path, "path");
    const positional = operation === "definition" || operation === "references" || operation === "hover";
    const line = positiveInteger(args.line, "line", positional);
    const column = positiveInteger(args.column, "column", positional);
    const content = await containerReadFile(context, path);
    let result: LspInspectResult;
    try {
      result = await context.lsp.inspect({
        operation,
        path,
        content,
        ...(line ? { line } : {}),
        ...(column ? { column } : {}),
        ...(typeof args.query === "string" ? { query: args.query } : {})
      });
    } catch (error) {
      const availability = lspAvailability(error);
      return {
        ok: availability.state === "starting",
        summary: `${operation}: language server ${availability.state}`,
        output: availability.message,
        metadata: { operation, state: availability.state, fallback: "file_search" }
      };
    }
    return {
      ok: true,
      summary: `${operation}: ${result.entries.length} result(s) via ${result.server}`,
      output: formatInspectResult(result),
      metadata: { server: result.server, projectRoot: result.projectRoot, operation, state: "ready" }
    };
  }
};

export function lspAvailability(error: unknown): { state: "starting" | "unavailable"; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (/initialization timed out|warming|starting/i.test(message)) {
    return {
      state: "starting",
      message: "language server is still starting; use file_search now or retry semantic inspection later"
    };
  }
  if (/disabled/i.test(message)) return { state: "unavailable", message: "language server is disabled; use file_search for lexical navigation" };
  if (/no built-in lsp server supports/i.test(message)) return { state: "unavailable", message: "no language server supports this file type; use file_search for lexical navigation" };
  return { state: "unavailable", message: "language server is unavailable; use file_search for lexical navigation" };
}

function positiveInteger(value: unknown, name: string, required: boolean): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
