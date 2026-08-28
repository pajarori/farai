import type { ToolResult } from "../../types";
import { sanitizeToolOutput } from "./output-sanitize";

export function defaultHumanRenderer(result: ToolResult): string {
  const output = sanitizeToolOutput(result.output ?? result.summary);
  return compactJsonRecord(output) ?? output;
}

export function defaultModelRenderer(result: ToolResult): string {
  const output = result.output ? sanitizeToolOutput(result.output).slice(0, 4_000) : "";
  return [result.summary, output].filter(Boolean).join("\n");
}

function compactJsonRecord(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); }
  catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const fields = Object.entries(parsed as Record<string, unknown>)
    .filter(([key]) => !INTERNAL_FIELDS.has(key))
    .map(([key, value]) => `${humanFieldName(key)}: ${compactJsonValue(value)}`);
  return fields.length > 0 ? fields.join(" · ") : undefined;
}

const INTERNAL_FIELDS = new Set([
  "id",
  "sessionId",
  "childSessionId",
  "parentSessionId",
  "jobId",
  "toolCallId",
  "processId",
  "runtimeId",
  "createdAt",
  "updatedAt"
]);

function compactJsonValue(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) return `[${value.join(", ")}]`;
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (value && typeof value === "object") {
    const count = Object.keys(value as Record<string, unknown>).length;
    return `${count} field${count === 1 ? "" : "s"}`;
  }
  return String(value);
}

function humanFieldName(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();
}
