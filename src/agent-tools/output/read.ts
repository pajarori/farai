import type { ToolContext, ToolDefinition, ToolResult } from "../../types";

type OutputReadArgs = { artifactId?: unknown; offset?: unknown; limit?: unknown };

export const outputReadTool: ToolDefinition<OutputReadArgs> = {
  name: "tool_output_read",
  description: "Read a page of a durable tool-output artifact that was created because the original result was too large to inline. Pass the exact output_artifact_id from the truncated result and advance the zero-based line offset to inspect additional pages without rerunning the original tool.",
  inputSchema: {
    type: "object",
    required: ["artifactId"],
    properties: {
      artifactId: { type: "string", description: "The output_artifact_id from a truncated tool result." },
      offset: { type: "integer", description: "0-based starting line (default 0)." },
      limit: { type: "integer", description: "Maximum lines to return (default 400)." }
    }
  },
  mutates: false,
  timeoutMs: 5_000,
  parallel: true,
  visibility: "workspace",
  renderHuman: (result) => result.output ?? result.summary,
  renderModel: (result) => result.output ?? result.summary,
  run: async (args, context: ToolContext): Promise<ToolResult> => {
    if (!context.store.readOutputArtifact) return { ok: false, summary: "Output artifact reading is not available." };
    const artifactId = typeof args.artifactId === "string" ? args.artifactId : "";
    if (!artifactId) return { ok: false, summary: "artifactId is required." };
    const result = context.store.readOutputArtifact(artifactId, {
      ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
      ...(typeof args.limit === "number" ? { limit: args.limit } : {})
    });
    if (!result) return { ok: false, summary: `No output artifact found for ${artifactId}.` };
    const remaining = result.to < result.totalLines ? `; read more with offset=${result.to}` : "";
    return {
      ok: true,
      summary: `Lines ${result.from}-${result.to} of ${result.totalLines} from ${artifactId}${remaining}`,
      output: result.content
    };
  }
};

export const outputTools: ToolDefinition[] = [outputReadTool as unknown as ToolDefinition];
