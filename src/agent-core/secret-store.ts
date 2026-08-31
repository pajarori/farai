import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { AsyncEntry, Entry } from "@napi-rs/keyring";
import type { ConfigLocation } from "./paths";

export type SecretLocator = {
  namespace: string;
  id: string;
  location: ConfigLocation;
  workspace?: string;
};

export type SecretPersistence = "system" | "session";

export interface SecretStore {
  set(locator: SecretLocator, value: string, persistence: SecretPersistence, signal?: AbortSignal): Promise<void>;
  get(locator: SecretLocator, persistence: SecretPersistence, signal?: AbortSignal): Promise<string | undefined>;
  delete(locator: SecretLocator, persistence: SecretPersistence, signal?: AbortSignal): Promise<void>;
  setSync(locator: SecretLocator, value: string, persistence: SecretPersistence): void;
  getSync(locator: SecretLocator, persistence: SecretPersistence): string | undefined;
  deleteSync(locator: SecretLocator, persistence: SecretPersistence): void;
  hasSession(locator: SecretLocator): boolean;
}

export interface SystemSecretBackend {
  set(account: string, value: string, signal?: AbortSignal): Promise<void>;
  get(account: string, signal?: AbortSignal): Promise<string | undefined>;
  delete(account: string, signal?: AbortSignal): Promise<void>;
  setSync?(account: string, value: string): void;
  getSync?(account: string): string | undefined;
  deleteSync?(account: string): void;
}

const keyringBackend: SystemSecretBackend = {
  async set(account, value, signal) {
    await new AsyncEntry("farai", account).setPassword(value, signal);
  },
  async get(account, signal) {
    return await new AsyncEntry("farai", account).getPassword(signal) ?? undefined;
  },
  async delete(account, signal) {
    await new AsyncEntry("farai", account).deletePassword(signal);
  },
  setSync(account, value) {
    new Entry("farai", account).setPassword(value);
  },
  getSync(account) {
    return new Entry("farai", account).getPassword() ?? undefined;
  },
  deleteSync(account) {
    new Entry("farai", account).deletePassword();
  }
};

const testSecrets = new Map<string, string>();
const testBackend: SystemSecretBackend = {
  async set(account, value) { testSecrets.set(account, value); },
  async get(account) { return testSecrets.get(account); },
  async delete(account) { testSecrets.delete(account); },
  setSync(account, value) { testSecrets.set(account, value); },
  getSync(account) { return testSecrets.get(account); },
  deleteSync(account) { testSecrets.delete(account); }
};

export class FaraiSecretStore implements SecretStore {
  private readonly sessionSecrets = new Map<string, string>();

  constructor(private readonly system: SystemSecretBackend = keyringBackend) {}

  async set(locator: SecretLocator, value: string, persistence: SecretPersistence, signal?: AbortSignal): Promise<void> {
    const key = secretAccount(locator);
    if (persistence === "session") {
      this.sessionSecrets.set(key, value);
      return;
    }
    try {
      await this.system.set(key, value, signal);
      const legacy = legacySecretAccount(locator);
      if (legacy) await this.system.delete(legacy, signal).catch(() => undefined);
      this.sessionSecrets.delete(key);
    } catch (error) {
      throw secureStoreError("store", error);
    }
  }

  async get(locator: SecretLocator, persistence: SecretPersistence, signal?: AbortSignal): Promise<string | undefined> {
    const key = secretAccount(locator);
    if (persistence === "session") return this.sessionSecrets.get(key);
    try {
      const current = await this.system.get(key, signal);
      if (current !== undefined) return current;
      const legacy = legacySecretAccount(locator);
      if (!legacy) return undefined;
      const previous = await this.system.get(legacy, signal);
      if (previous === undefined) return undefined;
      try {
        await this.system.set(key, previous, signal);
        if (await this.system.get(key, signal) === previous) await this.system.delete(legacy, signal);
      } catch {
      }
      return previous;
    } catch (error) {
      throw secureStoreError("read", error);
    }
  }

  async delete(locator: SecretLocator, persistence: SecretPersistence, signal?: AbortSignal): Promise<void> {
    const key = secretAccount(locator);
    if (persistence === "session") {
      this.sessionSecrets.delete(key);
      return;
    }
    try {
      await this.system.delete(key, signal);
      const legacy = legacySecretAccount(locator);
      if (legacy) await this.system.delete(legacy, signal);
    } catch (error) {
      throw secureStoreError("delete", error);
    }
  }

  setSync(locator: SecretLocator, value: string, persistence: SecretPersistence): void {
    const key = secretAccount(locator);
    if (persistence === "session") {
      this.sessionSecrets.set(key, value);
      return;
    }
    try {
      syncOperation(this.system.setSync, "store")(key, value);
      const legacy = legacySecretAccount(locator);
      if (legacy) {
        try { syncOperation(this.system.deleteSync, "delete")(legacy); } catch {
        }
      }
      this.sessionSecrets.delete(key);
    } catch (error) {
      throw secureStoreError("store", error);
    }
  }

  getSync(locator: SecretLocator, persistence: SecretPersistence): string | undefined {
    const key = secretAccount(locator);
    if (persistence === "session") return this.sessionSecrets.get(key);
    try {
      const current = syncOperation(this.system.getSync, "read")(key);
      if (current !== undefined) return current;
      const legacy = legacySecretAccount(locator);
      if (!legacy) return undefined;
      const previous = syncOperation(this.system.getSync, "read")(legacy);
      if (previous === undefined) return undefined;
      try {
        syncOperation(this.system.setSync, "store")(key, previous);
        if (syncOperation(this.system.getSync, "read")(key) === previous) syncOperation(this.system.deleteSync, "delete")(legacy);
      } catch {
      }
      return previous;
    } catch (error) {
      throw secureStoreError("read", error);
    }
  }

  deleteSync(locator: SecretLocator, persistence: SecretPersistence): void {
    const key = secretAccount(locator);
    if (persistence === "session") {
      this.sessionSecrets.delete(key);
      return;
    }
    try {
      syncOperation(this.system.deleteSync, "delete")(key);
      const legacy = legacySecretAccount(locator);
      if (legacy) syncOperation(this.system.deleteSync, "delete")(legacy);
    } catch (error) {
      throw secureStoreError("delete", error);
    }
  }

  hasSession(locator: SecretLocator): boolean {
    return this.sessionSecrets.has(secretAccount(locator));
  }
}

export const secretStore = new FaraiSecretStore(process.env.NODE_ENV === "test" ? testBackend : keyringBackend);

export function secretAccount(locator: SecretLocator): string {
  const scope = locator.location === "project"
    ? `project:${workspaceDigest(locator.workspace)}`
    : `global:${globalScopeDigest()}`;
  return `${locator.namespace}/${scope}/${locator.id}`;
}

function legacySecretAccount(locator: SecretLocator): string | undefined {
  if (locator.location !== "global" || process.env.FARAI_HOME?.trim()) return undefined;
  return `${locator.namespace}/global/${locator.id}`;
}

function workspaceDigest(workspace: string | undefined): string {
  if (!workspace) throw new Error("workspace is required for project-scoped secrets");
  return createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 24);
}

function globalScopeDigest(): string {
  const explicit = process.env.FARAI_HOME?.trim();
  if (explicit && !isAbsolute(explicit)) throw new Error("farai_home must be an absolute path");
  const root = explicit ?? join(process.env.HOME?.trim() || homedir(), ".local", "pajarori", "farai");
  return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 24);
}

function secureStoreError(action: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`unable to ${action} credential in the system keyring: ${detail}. choose session-only storage if this host has no usable secure store`);
}

function syncOperation<T extends (...args: never[]) => unknown>(operation: T | undefined, action: string): T {
  if (!operation) throw new Error(`synchronous system keyring ${action} is unavailable`);
  return operation.bind(undefined) as T;
}
