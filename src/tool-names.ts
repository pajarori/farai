export const TOOL_NAME_MAX_LENGTH = 64;
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function canonicalToolName(name: unknown): string {
  return typeof name === "string" ? name.replaceAll(".", "_") : "";
}

export function isCanonicalToolName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= TOOL_NAME_MAX_LENGTH && TOOL_NAME_PATTERN.test(name);
}

export function assertCanonicalToolName(name: unknown): asserts name is string {
  if (!isCanonicalToolName(name)) {
    throw new Error(`Invalid tool name "${String(name)}". Use 1-${TOOL_NAME_MAX_LENGTH} letters, numbers, underscores, or hyphens.`);
  }
}
