import type { ToolDefinition } from "../../types";
import type { LspInspectOperation } from "../../agent-lsp";
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
  description: "Inspect TypeScript, Python, Go, or Rust code through a language server running inside the session container.",
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
  timeoutMs: 10_000,
  parallel: true,
  visibility: "workspace",
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    if (!context.lsp) throw new Error("LSP is unavailable in this runtime");
    assertObject(args, "args");
    const operation = asString(args.operation, "operation") as LspInspectOperation;
    if (!OPERATIONS.has(operation)) throw new Error(`unsupported LSP operation: ${operation}`);
    const path = asString(args.path, "path");
    const positional = operation === "definition" || operation === "references" || operation === "hover";
    const line = positiveInteger(args.line, "line", positional);
    const column = positiveInteger(args.column, "column", positional);
    const content = await containerReadFile(context, path);
    const result = await context.lsp.inspect({
      operation,
      path,
      content,
      ...(line ? { line } : {}),
      ...(column ? { column } : {}),
      ...(typeof args.query === "string" ? { query: args.query } : {})
    });
    return {
      ok: true,
      summary: `${operation}: ${result.entries.length} result(s) via ${result.server}`,
      output: formatInspectResult(result),
      metadata: { server: result.server, projectRoot: result.projectRoot, operation }
    };
  }
};

function positiveInteger(value: unknown, name: string, required: boolean): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
