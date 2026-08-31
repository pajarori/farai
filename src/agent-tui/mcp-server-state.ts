import type { McpServerInfo, SaveMcpServerInput } from "../agent-core/mcp-server-management";
import { isSensitiveMcpField } from "../agent-core/mcp-secret-fields";
import type { McpServerProbeResult } from "../agent-tools/mcp-manager";

export type McpServerWizardField = "id" | "transport" | "endpoint" | "authentication" | "credential" | "oauth" | "environment" | "behavior" | "tools" | "review";

export type McpServerWizardState = {
  mode: "add" | "edit";
  field: McpServerWizardField;
  id: string;
  originalID?: string;
  enabled: boolean;
  transport: "stdio" | "http";
  endpoint: string;
  auth: "none" | "bearer" | "oauth";
  credential: string;
  credentialStored: boolean;
  removeCredential: boolean;
  oauth: string;
  environment: string;
  behavior: string;
  tools: string;
  location: "global" | "project";
  probe: McpServerProbeResult | undefined;
  busy: boolean;
  busyKind?: "probe" | "save" | undefined;
  error: string | undefined;
};

const TRANSPORTS = ["stdio", "http"] as const;
const AUTH_MODES = ["none", "bearer", "oauth"] as const;

export function createMcpServerWizard(server?: McpServerInfo): McpServerWizardState {
  if (!server) {
    return {
      mode: "add",
      field: "id",
      id: "",
      enabled: true,
      transport: "stdio",
      endpoint: "",
      auth: "none",
      credential: "",
      credentialStored: false,
      removeCredential: false,
      oauth: "",
      environment: "",
      behavior: "auto_start=true required=false startup=10 tool=60 container=true",
      tools: "",
      location: "global",
      probe: undefined,
      busy: false,
      error: undefined
    };
  }
  return {
    mode: "edit",
    field: "transport",
    id: server.id,
    originalID: server.id,
    enabled: server.enabled,
    transport: server.transport,
    endpoint: server.transport === "http" ? server.url ?? "" : shellJoin([server.command, ...server.args]),
    auth: server.auth,
    credential: "",
    credentialStored: server.credentialStored,
    removeCredential: false,
    oauth: serializeOAuth(server),
    environment: serializeEnvironment(server),
    behavior: serializeBehavior(server),
    tools: serializeTools(server),
    location: server.location,
    probe: undefined,
    busy: false,
    error: undefined
  };
}

export function mcpWizardFields(state: Pick<McpServerWizardState, "transport" | "auth">): McpServerWizardField[] {
  return [
    "id",
    "transport",
    "endpoint",
    ...(state.transport === "http" ? ["authentication" as const] : []),
    ...(state.transport === "http" && state.auth === "bearer" ? ["credential" as const] : []),
    ...(state.transport === "http" && state.auth === "oauth" ? ["oauth" as const] : []),
    "environment",
    "behavior",
    "tools",
    "review"
  ];
}

export function mcpWizardFieldMove(state: McpServerWizardState, delta: -1 | 1): McpServerWizardField {
  const fields = mcpWizardFields(state);
  const index = fields.indexOf(state.field);
  return fields[Math.max(0, Math.min(fields.length - 1, index + delta))] ?? state.field;
}

export function mcpWizardStep(state: McpServerWizardState): number {
  return mcpWizardFields(state).indexOf(state.field) + 1;
}

export function mcpTransportMove(value: "stdio" | "http", delta: number): "stdio" | "http" {
  const index = TRANSPORTS.indexOf(value);
  return TRANSPORTS[(index + delta + TRANSPORTS.length) % TRANSPORTS.length] ?? "stdio";
}

export function mcpAuthMove(value: "none" | "bearer" | "oauth", delta: number): "none" | "bearer" | "oauth" {
  const index = AUTH_MODES.indexOf(value);
  return AUTH_MODES[(index + delta + AUTH_MODES.length) % AUTH_MODES.length] ?? "none";
}

export function mcpWizardSaveInput(state: McpServerWizardState): SaveMcpServerInput {
  const behavior = parseAssignments(state.behavior);
  const tools = parseAssignments(state.tools);
  const input: SaveMcpServerInput = {
    id: state.id,
    ...(state.originalID ? { originalID: state.originalID } : {}),
    transport: state.transport,
    enabled: state.enabled,
    required: parseBoolean(behavior.required, false),
    autoStart: parseBoolean(behavior.auto_start ?? behavior.autostart, true),
    startupTimeoutSec: parsePositiveNumber(behavior.startup, 10),
    toolTimeoutSec: parsePositiveNumber(behavior.tool, 60),
    enabledTools: splitList(toText(tools.allow)),
    disabledTools: splitList(toText(tools.deny)),
    location: state.location,
    ...(state.credential ? { bearerToken: state.credential, credentialAction: "replace" as const } : state.removeCredential ? { credentialAction: "remove" as const } : { credentialAction: "keep" as const })
  };
  if (state.transport === "http") {
    const environment = parseEnvironment(state.environment, "http");
    const oauth = parseAssignments(state.oauth);
    return {
      ...input,
      url: state.endpoint.trim(),
      auth: state.auth,
      ...(state.auth === "bearer" && environment.bearerTokenEnvVar ? { bearerTokenEnvVar: environment.bearerTokenEnvVar } : {}),
      httpHeaders: environment.values,
      secretHttpHeaders: environment.secrets,
      retainedSecretHttpHeaders: environment.retained,
      envHttpHeaders: environment.references,
      ...(state.auth === "oauth" && toText(oauth.client_id) ? { oauthClientId: toText(oauth.client_id) } : {}),
      ...(state.auth === "oauth" && toText(oauth.callback_url) ? { oauthCallbackUrl: toText(oauth.callback_url) } : {}),
      ...(state.auth === "oauth" ? { oauthScopes: splitList(toText(oauth.scopes)) } : {})
    };
  }
  const parts = shellSplit(state.endpoint);
  if (!parts.length) throw new Error("stdio command is required");
  const environment = parseEnvironment(state.environment, "stdio");
  return {
    ...input,
    command: parts[0]!,
    args: parts.slice(1),
    ...(environment.cwd ? { cwd: environment.cwd } : {}),
    env: environment.values,
    secretEnv: environment.secrets,
    retainedSecretEnv: environment.retained,
    envVars: environment.forwarded,
    runInContainer: parseBoolean(behavior.container, true)
  };
}

function serializeOAuth(server: McpServerInfo): string {
  return [
    server.oauthClientId ? `client_id=${server.oauthClientId}` : undefined,
    server.oauthCallbackUrl ? `callback_url=${server.oauthCallbackUrl}` : undefined,
    server.oauthScopes.length ? `scopes=${server.oauthScopes.join(",")}` : undefined
  ].filter(Boolean).join("; ");
}

function serializeEnvironment(server: McpServerInfo): string {
  if (server.transport === "http") {
    return [
      ...Object.entries(server.httpHeaders).map(([name, value]) => `${name}=${value}`),
      ...(server.secretHttpHeaders ?? []).map((name) => `${name}=<stored>`),
      ...Object.entries(server.envHttpHeaders).map(([name, env]) => `${name}=$${env}`),
      server.bearerTokenEnvVar ? `bearer=$${server.bearerTokenEnvVar}` : undefined
    ].filter(Boolean).join("; ");
  }
  return [
    server.cwd ? `cwd=${server.cwd}` : undefined,
    ...Object.entries(server.env).map(([name, value]) => `${name}=${value}`),
    ...(server.secretEnvVars ?? []).map((name) => `${name}=<stored>`),
    ...server.envVars.map((name) => `$${name}`)
  ].filter(Boolean).join("; ");
}

function serializeBehavior(server: McpServerInfo): string {
  return `auto_start=${server.autoStart} required=${server.required} startup=${server.startupTimeoutSec} tool=${server.toolTimeoutSec} container=${server.runInContainer}`;
}

function serializeTools(server: McpServerInfo): string {
  return [
    server.enabledTools.length ? `allow=${server.enabledTools.join(",")}` : undefined,
    server.disabledTools.length ? `deny=${server.disabledTools.join(",")}` : undefined
  ].filter(Boolean).join(" ");
}

function parseAssignments(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of value.split(/[;\s]+/).map((item) => item.trim()).filter(Boolean)) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    result[part.slice(0, separator).trim().toLowerCase()] = part.slice(separator + 1).trim();
  }
  return result;
}

function parseEnvironment(value: string, transport: "stdio" | "http"): {
  cwd?: string;
  bearerTokenEnvVar?: string;
  values: Record<string, string>;
  secrets: Record<string, string>;
  references: Record<string, string>;
  retained: string[];
  forwarded: string[];
} {
  const values: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const references: Record<string, string> = {};
  const retained: string[] = [];
  const forwarded: string[] = [];
  let cwd: string | undefined;
  let bearerTokenEnvVar: string | undefined;
  for (const raw of value.split(";").map((item) => item.trim()).filter(Boolean)) {
    if (raw.startsWith("$") && !raw.includes("=")) {
      forwarded.push(raw.slice(1));
      continue;
    }
    const separator = raw.indexOf("=");
    if (separator <= 0) continue;
    const name = raw.slice(0, separator).trim();
    const entry = raw.slice(separator + 1).trim();
    if (transport === "stdio" && name.toLowerCase() === "cwd") {
      cwd = entry;
      continue;
    }
    if (transport === "http" && name.toLowerCase() === "bearer" && entry.startsWith("$")) {
      bearerTokenEnvVar = entry.slice(1);
      continue;
    }
    if (entry.startsWith("$")) {
      const reference = entry.slice(1);
      if (transport === "stdio") {
        if (name !== reference) throw new Error(`stdio environment forwarding must use $${reference} or ${reference}=$${reference}`);
        forwarded.push(reference);
      } else {
        references[name] = reference;
      }
    } else if (entry === "<stored>") {
      retained.push(name);
    } else if (entry.startsWith("!") || isSensitiveMcpField(transport === "stdio" ? "env" : "http-header", name)) {
      const secret = entry.startsWith("!") ? entry.slice(1) : entry;
      if (!secret) throw new Error(`${name} secret cannot be empty`);
      secrets[name] = secret;
    } else values[name] = entry;
  }
  return {
    ...(cwd ? { cwd } : {}),
    ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
    values,
    secrets,
    references,
    retained: [...new Set(retained)],
    forwarded
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`invalid boolean value: ${value}`);
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`invalid positive number: ${value}`);
  return parsed;
}

function splitList(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function toText(value: string | undefined): string {
  return value?.trim() ?? "";
}

function shellSplit(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const char of value.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("unterminated quote in stdio command");
  if (current) parts.push(current);
  return parts;
}

function shellJoin(parts: string[]): string {
  return parts.map((part) => /^[a-zA-Z0-9_./:=@+-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\"'\"'`)}'`).join(" ");
}
