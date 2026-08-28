import type { ToolContext, ToolResult } from "../../types";
import { sanitizeToolOutput } from "./output-sanitize";

export function summarizeOrSpool(
  context: ToolContext,
  opts: {
    title: string;
    raw: string;
    ok: boolean;
    summarize?: (raw: string) => string;
  }
): ToolResult {
  const visibleRaw = sanitizeToolOutput(opts.raw).trim() || `${opts.title}: command produced no output`;
  if (!opts.summarize) {
    return { ok: opts.ok, summary: `${opts.title}: ${opts.ok ? "completed" : "failed"}`, output: visibleRaw };
  }
  const compact = opts.summarize(opts.raw).trim() || `${opts.title}: no notable results`;
  const artifact = context.store.saveOutputArtifact({
    sessionId: context.session.id,
    ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
    content: opts.raw
  });
  return {
    ok: opts.ok,
    summary: `${opts.title}: ${opts.ok ? "completed" : "failed"}`,
    output: `${compact}\n\n[full output stored as artifact ${artifact.id}; read it with tool_output_read]`,
    outputArtifactId: artifact.id,
    metadata: {
      fullOutputArtifactId: artifact.id,
      fullOutputArtifactPath: artifact.path,
      fullOutputBytes: artifact.bytes,
      outputArtifact: artifact
    }
  };
}
