import { deleteCredential, readCredential, writeCredential } from "./credential-store";
import { mergeMcpHeaders } from "./mcp-headers";
import type { ConfigLocation } from "./paths";

export type McpSecretFields = {
  env: Record<string, string>;
  httpHeaders: Record<string, string>;
};

export function emptyMcpSecretFields(): McpSecretFields {
  return { env: {}, httpHeaders: {} };
}

export async function readMcpSecretFields(
  id: string,
  location: ConfigLocation,
  workspace?: string
): Promise<McpSecretFields> {
  const serialized = await readCredential("mcp-fields", id, location, workspace);
  if (!serialized) return emptyMcpSecretFields();
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!isRecord(parsed)) return emptyMcpSecretFields();
    return {
      env: stringRecord(parsed.env),
      httpHeaders: stringRecord(parsed.httpHeaders ?? parsed.http_headers)
    };
  } catch {
    return emptyMcpSecretFields();
  }
}

export async function writeMcpSecretFields(
  id: string,
  fields: McpSecretFields,
  location: ConfigLocation,
  workspace?: string
): Promise<void> {
  const normalized = normalizeMcpSecretFields(fields);
  if (!Object.keys(normalized.env).length && !Object.keys(normalized.httpHeaders).length) {
    await deleteCredential("mcp-fields", id, location, workspace);
    return;
  }
  await writeCredential("mcp-fields", id, JSON.stringify(normalized), location, workspace);
}

export async function deleteMcpSecretFields(
  id: string,
  location: ConfigLocation,
  workspace?: string
): Promise<void> {
  await deleteCredential("mcp-fields", id, location, workspace);
}

export function normalizeMcpSecretFields(fields: McpSecretFields): McpSecretFields {
  return {
    env: cleanRecord(fields.env),
    httpHeaders: mergeMcpHeaders(cleanRecord(fields.httpHeaders))
  };
}

export function isSensitiveMcpField(kind: "env" | "http-header", name: string): boolean {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (kind === "http-header" && ["authorization", "cookie", "proxy_authorization", "x_api_key"].includes(normalized)) return true;
  return /(^|_)(api_?key|auth|bearer|client_?secret|connection_?string|credential|cookie|database_?url|dsn|pass(word|phrase)?|private_?key|secret|session|token)($|_)/.test(normalized);
}

function cleanRecord(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([name, secret]) => [name.trim(), secret]).filter(([name, secret]) => name && secret));
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
