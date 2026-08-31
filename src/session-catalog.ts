import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { localFaraiDir } from "./agent-core/config";
import type { Session } from "./types";
import { readBoundedFileTextSyncNoFollow } from "./file-read";
import { atomicWriteFile } from "./agent-core/atomic-file";
import { ensurePrivateDirectory, ensurePrivateRegularFileIfExists } from "./agent-core/private-path";

const SESSION_CATALOG_ENTRY_MAX_BYTES = 64 * 1024;

export type SessionCatalogEntry = Pick<Session, "id" | "workspace" | "title" | "parentId" | "updatedAt">;

export function recordSessionLocation(session: Session): void {
  const directory = catalogDirectory();
  ensurePrivateDirectory(directory, "session catalog directory");
  const entry: SessionCatalogEntry = {
    id: session.id,
    workspace: resolve(session.workspace),
    ...(session.title ? { title: session.title } : {}),
    ...(session.parentId ? { parentId: session.parentId } : {}),
    updatedAt: session.updatedAt
  };
  const path = join(directory, `${session.id}.json`);
  ensurePrivateRegularFileIfExists(path, "session catalog entry");
  atomicWriteFile(path, `${JSON.stringify(entry)}\n`, 0o600);
}

export function removeSessionLocation(sessionId: string): void {
  rmSync(join(catalogDirectory(), `${sessionId}.json`), { force: true });
}

export function resolveSessionLocation(query: string): SessionCatalogEntry | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  const entries = listSessionLocations().filter((entry) => sessionDatabaseExists(entry.workspace));
  const exactId = entries.find((entry) => entry.id.toLowerCase() === needle);
  if (exactId) return exactId;
  const idPrefix = entries.filter((entry) => entry.id.toLowerCase().startsWith(needle));
  if (idPrefix.length === 1) return idPrefix[0];
  const exactTitle = entries.filter((entry) => entry.title?.trim().toLowerCase() === needle);
  return exactTitle.length === 1 ? exactTitle[0] : undefined;
}

export function listSessionLocations(): SessionCatalogEntry[] {
  const directory = catalogDirectory();
  if (!existsSync(directory)) return [];
  try { ensurePrivateDirectory(directory, "session catalog directory"); } catch { return []; }
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        const path = join(directory, name);
        ensurePrivateRegularFileIfExists(path, "session catalog entry");
        const value = JSON.parse(readBoundedFileTextSyncNoFollow(path, SESSION_CATALOG_ENTRY_MAX_BYTES, "session catalog entry")) as Partial<SessionCatalogEntry>;
        if (typeof value.id !== "string" || typeof value.workspace !== "string" || typeof value.updatedAt !== "string") return [];
        return [{
          id: value.id,
          workspace: value.workspace,
          ...(typeof value.title === "string" ? { title: value.title } : {}),
          ...(typeof value.parentId === "string" ? { parentId: value.parentId } : {}),
          updatedAt: value.updatedAt
        }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function catalogDirectory(): string {
  return join(localFaraiDir(), "sessions");
}

function sessionDatabaseExists(workspace: string): boolean {
  return existsSync(join(workspace, ".farai", "farai.db"));
}
