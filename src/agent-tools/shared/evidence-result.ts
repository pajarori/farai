import type { ToolContext, ToolResult } from "../../types";
import { id, nowIso } from "../../utils";
import { sanitizeToolOutput } from "./output-sanitize";

export function evidenceResult(context: ToolContext, title: string, output: string, ok: boolean): ToolResult {
  const visibleOutput = sanitizeToolOutput(output).trim() || `${title}: command produced no output`;
  const evidence = {
    id: id(),
    sessionId: context.session.id,
    source: "tool" as const,
    title,
    summary: visibleOutput.slice(0, 500),
    createdAt: nowIso()
  };
  return {
    ok,
    summary: `${title}: ${ok ? "completed" : "failed"}`,
    output: visibleOutput,
    evidence: [evidence]
  };
}
