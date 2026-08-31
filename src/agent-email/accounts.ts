import { createHash } from "node:crypto";
import { configPath, loadRawConfig, writeConfig, type ConfigLocation, type FaraiConfig } from "../agent-core/config";
import { secretStore, type SecretLocator, type SecretStore } from "../agent-core/secret-store";
import { id as createID } from "../utils";
import { probeImapAccount } from "./imap";
import type { EmailAccountInfo, EmailAccountProbe, EmailAuthMode, EmailCredentialStorage, EmailProviderID, EmailProviderPreset, ProbeEmailAccountInput, SaveEmailAccountInput } from "./types";

export const EMAIL_PROVIDER_PRESETS: readonly EmailProviderPreset[] = [
  { id: "gmail", label: "gmail", host: "imap.gmail.com", port: 993, secure: true, auth: "password", credentialLabel: "app password" },
  { id: "yahoo", label: "yahoo", host: "imap.mail.yahoo.com", port: 993, secure: true, auth: "password", credentialLabel: "app password" },
  { id: "outlook", label: "outlook", host: "outlook.office365.com", port: 993, secure: true, auth: "oauth", credentialLabel: "oauth access token" },
  { id: "icloud", label: "icloud", host: "imap.mail.me.com", port: 993, secure: true, auth: "password", credentialLabel: "app-specific password" },
  { id: "fastmail", label: "fastmail", host: "imap.fastmail.com", port: 993, secure: true, auth: "password", credentialLabel: "app password" },
  { id: "zoho", label: "zoho", host: "imap.zoho.com", port: 993, secure: true, auth: "password", credentialLabel: "app password" },
  { id: "custom", label: "custom imap", host: "", port: 993, secure: true, auth: "password", credentialLabel: "password or app password" }
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function emailProviderPreset(provider: EmailProviderID): EmailProviderPreset {
  return EMAIL_PROVIDER_PRESETS.find((preset) => preset.id === provider) ?? EMAIL_PROVIDER_PRESETS.at(-1)!;
}

export function listEmailAccounts(workspace: string): EmailAccountInfo[] {
  const merged = new Map<string, EmailAccountInfo>();
  for (const location of ["global", "project"] as const) {
    const accounts = loadRawConfig(configPath(location, workspace)).emailAccounts ?? {};
    for (const [configKey, raw] of Object.entries(accounts)) {
      try {
        const account = accountInfo(configKey, raw, location, workspace);
        merged.set(account.id, account);
      } catch {
      }
    }
  }
  return [...merged.values()].sort((left, right) => left.label.localeCompare(right.label) || left.address.localeCompare(right.address));
}

export function findEmailAccount(workspace: string, emailId: string): EmailAccountInfo {
  const normalized = emailId.trim().toLowerCase();
  const accounts = listEmailAccounts(workspace);
  const account = accounts.find((item) => item.id.toLowerCase() === normalized);
  if (!account) {
    const available = accounts.map((item) => `${item.address} (${item.id})`).join(", ");
    throw new Error(`email not found: ${emailId}${available ? `. available: ${available}` : ". add one with /email"}`);
  }
  return account;
}

export async function readEmailCredential(workspace: string, account: EmailAccountInfo, signal?: AbortSignal): Promise<string> {
  const credential = await secretStore.get(emailSecretLocator(account.id, account.location, workspace), account.credentialStorage, signal);
  if (!credential) throw new Error(`${account.label} has no usable credential. open /email and reconnect it`);
  return credential;
}

export async function saveEmailAccount(workspace: string, input: SaveEmailAccountInput, signal?: AbortSignal, secrets: SecretStore = secretStore): Promise<EmailAccountInfo> {
  const location = input.location ?? "global";
  const previousConfig = loadRawConfig(configPath(location, workspace));
  const accounts = { ...(previousConfig.emailAccounts ?? {}) };
  const resourceId = input.id ? normalizeResourceID(input.id) : createID();
  const existing = configEntryByID(accounts, location, workspace, resourceId);
  const previous = existing ? accountInfo(existing.key, existing.raw, location, workspace, secrets) : undefined;
  const label = normalizeLabel(input.label);
  const provider = normalizeProvider(input.provider);
  const preset = emailProviderPreset(provider);
  const address = normalizeEmailAddress(input.address);
  const username = (input.username?.trim() || address).slice(0, 320);
  const host = normalizeHost(input.host ?? preset.host);
  const port = normalizePort(input.port ?? preset.port);
  const secure = input.secure ?? preset.secure;
  const auth = normalizeAuth(input.auth ?? preset.auth);
  const credentialStorage = normalizeStorage(input.credentialStorage ?? previous?.credentialStorage ?? "system");
  const credentialAction = input.credentialAction ?? "keep";
  const credential = input.credential?.trim();
  if (credentialAction === "replace" && !credential) throw new Error(`${preset.credentialLabel} cannot be empty`);
  const previousConfigured = previous?.credentialConfigured ?? false;
  const credentialConfigured = credentialAction === "replace" ? true : credentialAction === "remove" ? false : previousConfigured;
  if (existing && existing.key !== resourceId) delete accounts[existing.key];
  accounts[resourceId] = {
    label,
    provider,
    address,
    username,
    host,
    port,
    secure,
    auth,
    credential_storage: credentialStorage,
    credential_configured: credentialStorage === "system" && credentialConfigured
  };
  const nextConfig = { ...previousConfig, emailAccounts: accounts };
  const locator = emailSecretLocator(resourceId, location, workspace);
  const previousCredential = previousConfigured && previous
    ? await secrets.get(locator, previous.credentialStorage, signal)
    : undefined;
  let configChanged = false;
  let credentialChanged = false;
  try {
    writeConfig(nextConfig, location, workspace);
    configChanged = true;
    if (credentialAction === "replace") {
      credentialChanged = true;
      await secrets.set(locator, credential!, credentialStorage, signal);
      if (previousConfigured && previous && previous.credentialStorage !== credentialStorage) {
        await secrets.delete(locator, previous.credentialStorage, signal);
      }
    }
    if (credentialAction === "remove" && previousConfigured && previous) {
      credentialChanged = true;
      await secrets.delete(locator, previous.credentialStorage, signal);
    }
    if (previousConfigured && previous && previous.credentialStorage !== credentialStorage && credentialAction === "keep") {
      if (!previousCredential) throw new Error("stored email credential is unavailable; provide a new credential before changing storage");
      credentialChanged = true;
      await secrets.set(locator, previousCredential, credentialStorage, signal);
      await secrets.delete(locator, previous.credentialStorage, signal);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (configChanged) {
      try { writeConfig(previousConfig, location, workspace); } catch (rollbackError) { rollbackErrors.push(`config: ${errorMessage(rollbackError)}`); }
    }
    if (credentialChanged) {
      try {
        await restoreCredential(secrets, locator, previous, previousCredential, credentialStorage);
      } catch (rollbackError) {
        rollbackErrors.push(`credential: ${errorMessage(rollbackError)}`);
      }
    }
    throw rollbackErrors.length
      ? new Error(`${errorMessage(error)} · rollback failed: ${rollbackErrors.join("; ")}`)
      : error;
  }
  return accountInfo(resourceId, accounts[resourceId]!, location, workspace, secrets);
}

export async function removeEmailAccount(workspace: string, emailId: string, location?: ConfigLocation, signal?: AbortSignal): Promise<{ id: string; location: ConfigLocation; accountRemains: boolean }> {
  const resourceId = normalizeResourceID(emailId);
  const resolvedLocation = location ?? emailAccountLocation(workspace, resourceId);
  if (!resolvedLocation) throw new Error(`email ${resourceId} is not configured`);
  const previousConfig = loadRawConfig(configPath(resolvedLocation, workspace));
  const accounts = { ...(previousConfig.emailAccounts ?? {}) };
  const existing = configEntryByID(accounts, resolvedLocation, workspace, resourceId);
  if (!existing) throw new Error(`email ${resourceId} is not configured in ${resolvedLocation} config`);
  const account = accountInfo(existing.key, existing.raw, resolvedLocation, workspace);
  delete accounts[existing.key];
  const next: FaraiConfig = { ...previousConfig };
  if (Object.keys(accounts).length) next.emailAccounts = accounts;
  else delete next.emailAccounts;
  writeConfig(next, resolvedLocation, workspace);
  try {
    if (account.credentialConfigured) await secretStore.delete(emailSecretLocator(resourceId, resolvedLocation, workspace), account.credentialStorage, signal);
  } catch (error) {
    writeConfig(previousConfig, resolvedLocation, workspace);
    throw error;
  }
  return { id: resourceId, location: resolvedLocation, accountRemains: Boolean(emailAccountLocation(workspace, resourceId)) };
}

export async function probeEmailAccount(workspace: string, input: ProbeEmailAccountInput, signal?: AbortSignal): Promise<EmailAccountProbe> {
  const account = input.account
    ? draftAccountInfo(input.account)
    : findEmailAccount(workspace, input.emailId ?? "");
  const started = Date.now();
  try {
    const credential = input.credential?.trim()
      || (input.account?.id ? await readEmailCredential(workspace, findEmailAccount(workspace, input.account.id), signal) : undefined);
    if (!credential) throw new Error(`${emailProviderPreset(account.provider).credentialLabel} is required to test this account`);
    const result = await probeImapAccount(account, credential, signal);
    return { ok: true, latencyMs: Date.now() - started, mailbox: result.mailbox, messages: result.messages };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: errorMessage(error) };
  }
}

function draftAccountInfo(input: SaveEmailAccountInput): EmailAccountInfo {
  const provider = normalizeProvider(input.provider);
  const preset = emailProviderPreset(provider);
  const address = normalizeEmailAddress(input.address);
  return {
    id: input.id ? normalizeResourceID(input.id) : createID(),
    label: normalizeLabel(input.label),
    provider,
    address,
    username: (input.username?.trim() || address).slice(0, 320),
    host: normalizeHost(input.host ?? preset.host),
    port: normalizePort(input.port ?? preset.port),
    secure: input.secure ?? preset.secure,
    auth: normalizeAuth(input.auth ?? preset.auth),
    credentialStorage: normalizeStorage(input.credentialStorage ?? "system"),
    credentialConfigured: Boolean(input.credential?.trim()),
    source: input.location ?? "global",
    location: input.location ?? "global",
    removable: true
  };
}

export function emailAccountLocation(workspace: string, emailId: string): ConfigLocation | undefined {
  for (const location of ["project", "global"] as const) {
    const accounts = loadRawConfig(configPath(location, workspace)).emailAccounts ?? {};
    if (configEntryByID(accounts, location, workspace, emailId)) return location;
  }
  return undefined;
}

export function defaultEmailLabel(address: string): string {
  const local = address.trim().split("@")[0]?.replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
  return normalizeLabel(local || "email");
}

async function restoreCredential(
  secrets: SecretStore,
  locator: SecretLocator,
  previous: EmailAccountInfo | undefined,
  previousCredential: string | undefined,
  destination: EmailCredentialStorage
): Promise<void> {
  const failures: string[] = [];
  if (!previous?.credentialConfigured) {
    try { await secrets.delete(locator, destination); } catch (error) { failures.push(errorMessage(error)); }
  } else {
    if (previous.credentialStorage !== destination) {
      try { await secrets.delete(locator, destination); } catch (error) { failures.push(errorMessage(error)); }
    }
    try {
      if (previousCredential === undefined) await secrets.delete(locator, previous.credentialStorage);
      else await secrets.set(locator, previousCredential, previous.credentialStorage);
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }
  if (failures.length) throw new Error([...new Set(failures)].join("; "));
}

function accountInfo(configKey: string, raw: Record<string, unknown>, location: ConfigLocation, workspace: string, secrets: SecretStore = secretStore): EmailAccountInfo {
  const provider = normalizeProvider(raw.provider);
  const preset = emailProviderPreset(provider);
  const credentialStorage = normalizeStorage(raw.credential_storage ?? raw.credentialStorage ?? "system");
  const configuredFlag = raw.credential_configured ?? raw.credentialConfigured;
  const address = normalizeEmailAddress(String(raw.address ?? raw.username ?? ""));
  const resourceId = resourceID(configKey, raw, location, address);
  const locator = emailSecretLocator(resourceId, location, workspace);
  return {
    id: resourceId,
    label: normalizeLabel(String(raw.label ?? (UUID.test(configKey) ? defaultEmailLabel(address) : configKey))),
    provider,
    address,
    username: String(raw.username ?? raw.address ?? "").trim(),
    host: normalizeHost(String(raw.host ?? preset.host)),
    port: normalizePort(raw.port ?? preset.port),
    secure: typeof raw.secure === "boolean" ? raw.secure : preset.secure,
    auth: normalizeAuth(raw.auth ?? preset.auth),
    credentialStorage,
    credentialConfigured: credentialStorage === "session" ? secrets.hasSession(locator) : configuredFlag === true,
    source: location,
    location,
    removable: true
  };
}

function configEntryByID(accounts: Record<string, Record<string, unknown>>, location: ConfigLocation, workspace: string, emailId: string): { key: string; raw: Record<string, unknown> } | undefined {
  const normalized = emailId.trim().toLowerCase();
  for (const [key, raw] of Object.entries(accounts)) {
    try {
      if (accountInfo(key, raw, location, workspace).id.toLowerCase() === normalized) return { key, raw };
    } catch {
    }
  }
  return undefined;
}

function resourceID(configKey: string, raw: Record<string, unknown>, location: ConfigLocation, address: string): string {
  const explicit = String(raw.id ?? raw.uuid ?? configKey).trim().toLowerCase();
  if (UUID.test(explicit)) return explicit;
  const digest = createHash("sha256").update(`${location}\u0000${configKey}\u0000${address}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function emailSecretLocator(id: string, location: ConfigLocation, workspace: string): SecretLocator {
  return { namespace: "email", id, location, ...(location === "project" ? { workspace } : {}) };
}

function normalizeResourceID(value: string): string {
  const id = value.trim().toLowerCase();
  if (!UUID.test(id)) throw new Error("email id must be a uuid");
  return id;
}

function normalizeLabel(value: string): string {
  const label = value.trim().replace(/\s+/g, " ");
  if (!label) throw new Error("email label is required");
  if (label.length > 80) throw new Error("email label must be at most 80 characters");
  return label;
}

function normalizeEmailAddress(value: string): string {
  const address = value.trim().toLowerCase();
  if (address.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error("email address is invalid");
  return address;
}

function normalizeHost(value: string): string {
  const host = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.includes("..")) throw new Error("imap host is invalid");
  return host;
}

function normalizePort(value: unknown): number {
  const port = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("imap port must be between 1 and 65535");
  return port;
}

function normalizeProvider(value: unknown): EmailProviderID {
  const id = String(value ?? "custom").trim().toLowerCase();
  return EMAIL_PROVIDER_PRESETS.some((preset) => preset.id === id) ? id as EmailProviderID : "custom";
}

function normalizeAuth(value: unknown): EmailAuthMode {
  return value === "oauth" ? "oauth" : "password";
}

function normalizeStorage(value: unknown): EmailCredentialStorage {
  return value === "session" ? "session" : "system";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
