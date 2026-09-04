import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { globalDataDir } from "../agent-core/paths";
import { ensurePrivateDirectory, ensurePrivateRegularFileIfExists } from "../agent-core/private-path";
import { readBoundedFileTextSyncNoFollow } from "../file-read";
import type { ActiveContent } from "./types";

const POINTER_MAX_BYTES = 64 * 1024;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function contentRoot(): string {
  const configured = process.env.FARAI_CONTENT_DIR?.trim();
  if (!configured) return join(globalDataDir(), "content");
  if (!isAbsolute(configured)) throw new Error("farai_content_dir must be an absolute path");
  return resolve(configured);
}

export function contentVersionsDir(): string {
  return join(contentRoot(), "versions");
}

export function contentActivePath(): string {
  return join(contentRoot(), "active.json");
}

export function contentManifestCachePath(): string {
  return join(contentRoot(), "manifest-cache.json");
}

export function contentPreferencesPath(): string {
  return join(contentRoot(), "preferences.json");
}

export function contentLockPath(): string {
  return join(contentRoot(), "update.lock");
}

export function contentVersionDir(version: string): string {
  if (!VERSION_PATTERN.test(version)) throw new Error(`invalid content version: ${version}`);
  return join(contentVersionsDir(), version);
}

export function readActiveContent(): ActiveContent | undefined {
  const path = contentActivePath();
  try {
    if (!existsSync(path)) return undefined;
    ensurePrivateRegularFileIfExists(path, "active content pointer");
    const parsed: unknown = JSON.parse(readBoundedFileTextSyncNoFollow(path, POINTER_MAX_BYTES, "active content pointer"));
    return parseActiveContent(parsed);
  } catch {
    return undefined;
  }
}

export function activeContentVersionDir(): string | undefined {
  const active = readActiveContent();
  if (!active) return undefined;
  const path = contentVersionDir(active.version);
  return existsSync(path) ? path : undefined;
}

export function activeContentKnowledgePath(): string | undefined {
  const active = readActiveContent();
  if (!active?.knowledge) return undefined;
  const path = join(contentVersionDir(active.version), "knowledge.db");
  return existsSync(path) ? path : undefined;
}

export function activeContentSkillsDir(): string | undefined {
  const active = readActiveContent();
  if (!active?.skills) return undefined;
  const path = join(contentVersionDir(active.version), "skills");
  return existsSync(path) ? path : undefined;
}

export function ensureContentDirectories(): void {
  ensurePrivateDirectory(contentRoot(), "farai content directory");
  ensurePrivateDirectory(contentVersionsDir(), "farai content versions directory");
}

function parseActiveContent(value: unknown): ActiveContent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return undefined;
  if (typeof record.version !== "string" || !VERSION_PATTERN.test(record.version)) return undefined;
  if (!validDate(record.generatedAt) || !validDate(record.activatedAt)) return undefined;
  if (typeof record.manifestUrl !== "string" || !record.manifestUrl) return undefined;
  if (typeof record.knowledge !== "boolean" || typeof record.skills !== "boolean") return undefined;
  const previousVersion = typeof record.previousVersion === "string" && VERSION_PATTERN.test(record.previousVersion)
    ? record.previousVersion
    : undefined;
  return {
    schemaVersion: 1,
    version: record.version,
    generatedAt: record.generatedAt,
    activatedAt: record.activatedAt,
    manifestUrl: record.manifestUrl,
    ...(previousVersion ? { previousVersion } : {}),
    knowledge: record.knowledge,
    skills: record.skills
  };
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}
