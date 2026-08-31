import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { atomicWriteFile } from "./atomic-file";
import { authPath, type ConfigLocation } from "./paths";
import { readBoundedFileTextSyncNoFollow } from "../file-read";
import { dirname } from "node:path";
import { ensurePrivateDirectory, ensurePrivateRegularFileIfExists } from "./private-path";

const LEGACY_AUTH_MAX_BYTES = 1024 * 1024;

export type AuthEntry = { apiKey?: string; token?: string };
export type FaraiAuth = Record<string, AuthEntry>;

export function loadAuth(workspace?: string): FaraiAuth {
  const global = shouldReadGlobal() ? readAuth(authPath("global")) : {};
  const project = workspace ? readAuth(authPath("project", workspace)) : {};
  return { ...global, ...project };
}

export function readAuth(path: string): FaraiAuth {
  try {
    if (!existsSync(path)) return {};
    ensurePrivateRegularFileIfExists(path, "legacy auth file");
    const parsed = JSON.parse(readBoundedFileTextSyncNoFollow(path, LEGACY_AUTH_MAX_BYTES, "legacy auth file")) as unknown;
    if (!isRecord(parsed)) return {};
    const out: FaraiAuth = {};
    for (const [name, entry] of Object.entries(parsed)) {
      if (!isRecord(entry)) continue;
      out[name] = {
        ...(typeof entry.apiKey === "string" ? { apiKey: entry.apiKey } : {}),
        ...(typeof entry.token === "string" ? { token: entry.token } : {})
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeAuthEntry(name: string, entry: AuthEntry, location: ConfigLocation = "global", workspace?: string): string {
  const path = authPath(location, workspace);
  const current = existsSync(path) ? readAuth(path) : {};
  current[name] = { ...current[name], ...entry };
  writeAuth(path, current);
  return path;
}

export function removeAuthEntry(name: string, location: ConfigLocation = "global", workspace?: string): string {
  const path = authPath(location, workspace);
  const current = existsSync(path) ? readAuth(path) : {};
  if (!(name in current)) return path;
  delete current[name];
  if (Object.keys(current).length) writeAuth(path, current);
  else unlinkSync(path);
  return path;
}

function writeAuth(path: string, auth: FaraiAuth): void {
  ensurePrivateDirectory(dirname(path), "farai auth directory");
  ensurePrivateRegularFileIfExists(path, "legacy auth file");
  atomicWriteFile(path, `${JSON.stringify(auth, null, 2)}\n`, 0o600);
}

function shouldReadGlobal(): boolean {
  if (process.env.NODE_ENV !== "test") return true;
  return (process.env.HOME ?? "").startsWith(tmpdir());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
