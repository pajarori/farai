import { readAuth, removeAuthEntry } from "./legacy-auth";
import { authPath, type ConfigLocation } from "./paths";
import { secretStore, type SecretLocator, type SecretStore } from "./secret-store";

export type CredentialKind = "model-provider" | "mcp-bearer" | "mcp-oauth" | "mcp-fields";

export type LocatedCredential = {
  value: string;
  location: ConfigLocation;
};

export async function readCredential(
  kind: CredentialKind,
  id: string,
  location: ConfigLocation,
  workspace?: string,
  secrets: SecretStore = secretStore
): Promise<string | undefined> {
  const locator = credentialLocator(kind, id, location, workspace);
  let secureError: unknown;
  try {
    const stored = await secrets.get(locator, "system");
    if (stored) return stored;
  } catch (error) {
    secureError = error;
  }
  const legacy = readLegacyCredential(kind, id, location, workspace);
  if (!legacy) {
    if (secureError) throw secureError;
    return undefined;
  }
  if (!secureError) {
    try { await migrateLegacyCredential(kind, id, location, workspace, legacy, secrets); } catch {
    }
  }
  return legacy;
}

export function readCredentialSync(
  kind: CredentialKind,
  id: string,
  location: ConfigLocation,
  workspace?: string,
  secrets: SecretStore = secretStore
): string | undefined {
  const locator = credentialLocator(kind, id, location, workspace);
  let secureError: unknown;
  try {
    const stored = secrets.getSync(locator, "system");
    if (stored) return stored;
  } catch (error) {
    secureError = error;
  }
  const legacy = readLegacyCredential(kind, id, location, workspace);
  if (!legacy) {
    if (secureError) throw secureError;
    return undefined;
  }
  if (!secureError) {
    try { migrateLegacyCredentialSync(kind, id, location, workspace, legacy, secrets); } catch {
    }
  }
  return legacy;
}

export async function readCredentialForWorkspace(
  kind: CredentialKind,
  id: string,
  workspace?: string,
  secrets: SecretStore = secretStore
): Promise<LocatedCredential | undefined> {
  for (const location of credentialLocations(workspace)) {
    const value = await readCredential(kind, id, location, workspace, secrets);
    if (value) return { value, location };
  }
  return undefined;
}

export function readCredentialForWorkspaceSync(
  kind: CredentialKind,
  id: string,
  workspace?: string,
  secrets: SecretStore = secretStore
): LocatedCredential | undefined {
  for (const location of credentialLocations(workspace)) {
    const value = readCredentialSync(kind, id, location, workspace, secrets);
    if (value) return { value, location };
  }
  return undefined;
}

export async function writeCredential(
  kind: CredentialKind,
  id: string,
  value: string,
  location: ConfigLocation,
  workspace?: string,
  secrets: SecretStore = secretStore
): Promise<void> {
  const normalized = normalizeCredential(value);
  const locator = credentialLocator(kind, id, location, workspace);
  const previous = await secrets.get(locator, "system");
  await secrets.set(locator, normalized, "system");
  try {
    const verified = await secrets.get(locator, "system");
    if (verified !== normalized) throw new Error("system keyring verification failed");
    removeLegacyCredential(kind, id, location, workspace);
  } catch (error) {
    try {
      if (previous === undefined) await secrets.delete(locator, "system");
      else await secrets.set(locator, previous, "system");
    } catch {
    }
    throw error;
  }
}

export function writeCredentialSync(
  kind: CredentialKind,
  id: string,
  value: string,
  location: ConfigLocation,
  workspace?: string,
  secrets: SecretStore = secretStore
): void {
  const normalized = normalizeCredential(value);
  const locator = credentialLocator(kind, id, location, workspace);
  const previous = secrets.getSync(locator, "system");
  secrets.setSync(locator, normalized, "system");
  try {
    const verified = secrets.getSync(locator, "system");
    if (verified !== normalized) throw new Error("system keyring verification failed");
    removeLegacyCredential(kind, id, location, workspace);
  } catch (error) {
    try {
      if (previous === undefined) secrets.deleteSync(locator, "system");
      else secrets.setSync(locator, previous, "system");
    } catch {
    }
    throw error;
  }
}

export async function deleteCredential(
  kind: CredentialKind,
  id: string,
  location: ConfigLocation,
  workspace?: string,
  secrets: SecretStore = secretStore
): Promise<void> {
  const locator = credentialLocator(kind, id, location, workspace);
  const previous = await secrets.get(locator, "system");
  await secrets.delete(locator, "system");
  try {
    removeLegacyCredential(kind, id, location, workspace);
  } catch (error) {
    if (previous !== undefined) await secrets.set(locator, previous, "system");
    throw error;
  }
}

export function deleteCredentialSync(
  kind: CredentialKind,
  id: string,
  location: ConfigLocation,
  workspace?: string,
  secrets: SecretStore = secretStore
): void {
  const locator = credentialLocator(kind, id, location, workspace);
  const previous = secrets.getSync(locator, "system");
  secrets.deleteSync(locator, "system");
  try {
    removeLegacyCredential(kind, id, location, workspace);
  } catch (error) {
    if (previous !== undefined) secrets.setSync(locator, previous, "system");
    throw error;
  }
}

export function credentialLocator(kind: CredentialKind, id: string, location: ConfigLocation, workspace?: string): SecretLocator {
  return {
    namespace: kind,
    id: id.trim().toLowerCase(),
    location,
    ...(location === "project" && workspace ? { workspace } : {})
  };
}

export function legacyCredentialConfigured(kind: CredentialKind, id: string, location: ConfigLocation, workspace?: string): boolean {
  return readLegacyCredential(kind, id, location, workspace) !== undefined;
}

async function migrateLegacyCredential(
  kind: CredentialKind,
  id: string,
  location: ConfigLocation,
  workspace: string | undefined,
  value: string,
  secrets: SecretStore
): Promise<void> {
  await writeCredential(kind, id, value, location, workspace, secrets);
}

function migrateLegacyCredentialSync(
  kind: CredentialKind,
  id: string,
  location: ConfigLocation,
  workspace: string | undefined,
  value: string,
  secrets: SecretStore
): void {
  writeCredentialSync(kind, id, value, location, workspace, secrets);
}

function readLegacyCredential(kind: CredentialKind, id: string, location: ConfigLocation, workspace?: string): string | undefined {
  const name = legacyAuthName(kind, id);
  if (!name) return undefined;
  const entry = readAuth(authPath(location, workspace))[name];
  return kind === "model-provider" ? entry?.apiKey : entry?.token;
}

function removeLegacyCredential(kind: CredentialKind, id: string, location: ConfigLocation, workspace?: string): void {
  const name = legacyAuthName(kind, id);
  if (name) removeAuthEntry(name, location, workspace);
}

function legacyAuthName(kind: CredentialKind, id: string): string | undefined {
  if (kind === "model-provider") return id;
  if (kind === "mcp-bearer") return `mcp:${id}`;
  if (kind === "mcp-oauth") return `mcp:${id}:oauth`;
  return undefined;
}

function credentialLocations(workspace: string | undefined): ConfigLocation[] {
  return workspace ? ["project", "global"] : ["global"];
}

function normalizeCredential(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("credential cannot be empty");
  return normalized;
}
