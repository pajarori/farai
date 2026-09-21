import type { ToolContext, ToolDefinition, ToolResult } from "../../types";
import { takeBytes } from "../shared/output-bound";

type ContextExpandArgs = { chunk?: unknown };

const MAX_OUTPUT_BYTES = 48 * 1024;

export const contextExpandTool: ToolDefinition<ContextExpandArgs> = {
  name: "context_expand",
  description: "open the exact raw results that an older summarized chunk replaced in your context. pass the chunk id shown in a summarized-results marker to recover the full untruncated detail without rerunning anything.",
  inputSchema: {
    type: "object",
    required: ["chunk"],
    properties: {
      chunk: { type: "string", description: "the chunk id from a summarized-results marker (context_expand chunk=...)." }
    }
  },
  mutates: false,
  timeoutMs: Number.POSITIVE_INFINITY,
  parallel: true,
  visibility: "workspace",
  renderHuman: (result) => result.output ?? result.summary,
  renderModel: (result) => result.output ?? result.summary,
  run: async (args, context: ToolContext): Promise<ToolResult> => {
    if (!context.store.expandContextSummaryChunk) return { ok: false, summary: "context expansion is not available." };
    const chunkId = typeof args.chunk === "string" ? args.chunk.trim() : "";
    if (!chunkId) return { ok: false, summary: "chunk is required." };
    const expanded = context.store.expandContextSummaryChunk(context.session.id, chunkId);
    if (!expanded) return { ok: false, summary: `no summarized chunk found for ${chunkId}.` };
    if (!expanded.raws.length) return { ok: true, summary: `chunk ${chunkId} has no retained raw results.`, output: "" };
    const blocks = expanded.raws.map((raw) => `--- ${raw.tool} (${raw.toolCallId}) ---\n${raw.text}`);
    return {
      ok: true,
      summary: `raw ${expanded.lane} results for chunk ${chunkId}: ${expanded.raws.length} entries`,
      output: takeBytes(blocks.join("\n\n"), MAX_OUTPUT_BYTES, "head")
    };
  }
};

export const contextTools: ToolDefinition[] = [contextExpandTool as unknown as ToolDefinition];
