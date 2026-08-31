import type { ToolContext, ToolDefinition, ToolResult } from "../../types";

type OutputReadArgs = { artifactId?: unknown; offset?: unknown; limit?: unknown; byteOffset?: unknown; byteLimit?: unknown };

export const outputReadTool: ToolDefinition<OutputReadArgs> = {
  name: "tool_output_read",
  description: "Read a page of a durable tool-output artifact that was created because the original result was too large to inline. Pass the exact output_artifact_id from the truncated result and advance the zero-based line offset to inspect additional pages without rerunning the original tool.",
  inputSchema: {
    type: "object",
    required: ["artifactId"],
    properties: {
      artifactId: { type: "string", description: "The output_artifact_id from a truncated tool result." },
      offset: { type: "integer", description: "0-based starting line (default 0)." },
      limit: { type: "integer", description: "Maximum lines to return (default 400, maximum 1000)." },
      byteOffset: { type: "integer", description: "0-based byte offset for continuing inside a very long line." },
      byteLimit: { type: "integer", description: "Maximum bytes to return in byte mode (default and maximum 49152)." }
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
      ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      ...(typeof args.byteOffset === "number" ? { byteOffset: args.byteOffset } : {}),
      ...(typeof args.byteLimit === "number" ? { byteLimit: args.byteLimit } : {})
    });
    if (!result) return { ok: false, summary: `No output artifact found for ${artifactId}.` };
    if (result.byteFrom !== undefined && result.byteTo !== undefined) {
      const remaining = result.byteTo < result.artifact.bytes ? `; read more with byteOffset=${result.byteTo}` : "";
      return {
        ok: true,
        summary: `bytes ${result.byteFrom}-${result.byteTo} of ${result.artifact.bytes} from ${artifactId}${remaining}`,
        output: result.content
      };
    }
    if (result.nextByteOffset !== undefined) {
      return {
        ok: true,
        summary: `lines ${result.from}-${result.to} of ${result.totalLines} from ${artifactId}; continue with byteOffset=${result.nextByteOffset}`,
        output: result.content
      };
    }
    const remaining = result.to < result.totalLines ? `; read more with offset=${result.to}` : "";
    return {
      ok: true,
      summary: `lines ${result.from}-${result.to} of ${result.totalLines} from ${artifactId}${remaining}`,
      output: result.content
    };
  }
};

export const outputTools: ToolDefinition[] = [outputReadTool as unknown as ToolDefinition];
