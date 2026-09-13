import { sanitizeToolOutput } from "./output-sanitize";
import { BoundedOutputBuffer } from "../backends/output-buffer";

const DEFAULT_CHARS_PER_TOKEN = 4;
const MAX_TOOL_OUTPUT_TOKENS = 100_000;

export function processOutput(stdout: string, stderr: string, maxOutputTokens?: unknown): string {
  return boundOutputTokens(
    sanitizeToolOutput([stdout, stderr.trim() ? `STDERR:\n${stderr}` : ""].filter(Boolean).join("\n")),
    maxOutputTokens
  );
}

export function boundOutputTokens(output: string, maxOutputTokens?: unknown): string {
  const tokens = outputTokenLimit(maxOutputTokens);
  if (tokens === undefined) return output;
  const buffer = new BoundedOutputBuffer(tokens * DEFAULT_CHARS_PER_TOKEN);
  buffer.push(output);
  return buffer.text();
}

export function outputTokenLimit(maxOutputTokens: unknown): number | undefined {
  if (maxOutputTokens === undefined) return undefined;
  if (typeof maxOutputTokens !== "number" || !Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error("max_output_tokens must be a positive number");
  }
  return Math.min(MAX_TOOL_OUTPUT_TOKENS, Math.max(1, Math.floor(maxOutputTokens)));
}
