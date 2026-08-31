const providerIDPattern = /^[a-z0-9][a-z0-9_-]*$/;
const environmentVariablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeModelProviderID(value: string): string {
  const normalized = value.trim().replace(/\s+/g, "-").toLowerCase();
  if (!providerIDPattern.test(normalized)) {
    throw new Error("provider id must start with a letter or number and contain only lowercase letters, numbers, hyphens, or underscores");
  }
  return normalized;
}

export function normalizeModelProviderBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("provider base url must be a valid http or https url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("provider base url must use http or https");
  if (parsed.username || parsed.password) throw new Error("provider credentials must not be embedded in the base url");
  return trimmed;
}

export function isEnvironmentVariableName(value: string): boolean {
  return environmentVariablePattern.test(value);
}

export function normalizeEnvironmentVariableName(value: string): string {
  const trimmed = value.trim();
  if (!isEnvironmentVariableName(trimmed)) throw new Error("api key environment variable must be a valid variable name");
  return trimmed;
}
