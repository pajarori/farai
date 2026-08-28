import type { ToolDefinition, ToolResult } from "../types";
import { takeBytes } from "./shared/output-bound";

const BRIDGE_NAMES = new Set(["tool_search", "tool_invoke"]);

type SearchArgs = { query: string; limit?: number };
type InvokeArgs = { name: string; arguments: Record<string, unknown> };

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_.-]{2,}/g) ?? [];
}

function score(query: string, tool: ToolDefinition): number {
  const queryWords = words(query);
  if (queryWords.length === 0) return 0;
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  let total = 0;
  for (const word of queryWords) {
    if (name === word) total += 20;
    else if (name.includes(word)) total += 8;
    if (description.includes(word)) total += 2;
  }
  return total;
}

export const toolSearchTool: ToolDefinition<SearchArgs> = {
  name: "tool_search",
  description: "Find an additional task-scoped tool and load its argument schema.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Capability keywords, such as 'inspect browser traffic'." },
      limit: { type: "integer", minimum: 1, maximum: 8, description: "Maximum matches. Default 5." }
    },
    required: ["query"]
  },
  mutates: false,
  timeoutMs: 5_000,
  parallel: true,
  renderHuman: (result) => result.output ?? result.summary,
  renderModel: (result) => result.output ?? result.summary,
  run: async (args, context) => {
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, summary: "tool search requires a query" };
    const limit = Math.max(1, Math.min(8, Number(args.limit) || 5));
    const tools = (context.availableTools?.() ?? [])
      .filter((tool) => !BRIDGE_NAMES.has(tool.name))
      .map((tool) => ({ tool, score: score(query, tool) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, limit)
      .map(({ tool }) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
    const output = tools.length > 0
      ? JSON.stringify({ matches: tools }, null, 2)
      : JSON.stringify({ matches: [], hint: "Try broader capability keywords." });
    return {
      ok: true,
      summary: `loaded ${tools.length} matching tools for the next model step`,
      output: takeBytes(output, 8 * 1024, "head"),
      metadata: { loadedTools: tools.map((tool) => tool.name) }
    };
  }
};

export const toolInvokeTool: ToolDefinition<InvokeArgs> = {
  name: "tool_invoke",
  description: "Invoke a tool returned by tool_search immediately when a direct loaded-tool call is unavailable.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact tool name from tool_search." },
      arguments: { type: "object", description: "Arguments matching the discovered schema." }
    },
    required: ["name", "arguments"]
  },
  mutates: true,
  timeoutMs: 120_000,
  parallel: false,
  renderHuman: (result) => result.output ?? result.summary,
  renderModel: (result) => result.output ?? result.summary,
  run: async (args, context): Promise<ToolResult> => {
    const name = String(args.name ?? "").trim();
    if (!name || BRIDGE_NAMES.has(name)) return { ok: false, summary: `cannot invoke deferred tool: ${name || "missing name"}` };
    if (!context.invokeTool) return { ok: false, summary: "deferred tool invocation is unavailable in this runtime" };
    return context.invokeTool(name, args.arguments ?? {});
  }
};

export const deferredTools: ToolDefinition[] = [toolSearchTool as ToolDefinition, toolInvokeTool as ToolDefinition];
