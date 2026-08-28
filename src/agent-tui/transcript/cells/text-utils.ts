export function sanitizeText(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

export function stripOuterBlankLines(value: string): string {
  return value.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");
}

export function tailLines(value: string, count: number): string[] {
  return value.split("\n").filter((line) => line.trim().length > 0).slice(-count);
}

export function firstResultLine(value: string): string {
  return value.split("\n").find((line) => line.trim().length > 0) ?? "(no output)";
}

export function args(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
