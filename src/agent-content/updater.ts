import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FARAI_VERSION } from "../version";
import { loadConfig } from "../agent-core/config";
import { atomicWriteFile, syncDirectory } from "../agent-core/atomic-file";
import { ensurePrivateDirectory, ensurePrivateRegularFileIfExists, ensurePrivateSqlitePath } from "../agent-core/private-path";
import { readBoundedFileTextSyncNoFollow } from "../file-read";
import { KnowledgeStore } from "../agent-knowledge/store";
import { KNOWLEDGE_SCHEMA_VERSION } from "../agent-knowledge/schema";
import { compareSemver, isSemver } from "../agent-core/semver";
import {
  activeContentKnowledgePath,
  activeContentSkillsDir,
  contentActivePath,
  contentLockPath,
  contentManifestCachePath,
  contentPreferencesPath,
  contentVersionDir,
  contentVersionsDir,
  ensureContentDirectories,
  readActiveContent
} from "./paths";
import { CONTENT_MANIFEST_MAX_BYTES, DEFAULT_CONTENT_MANIFEST_URL, fetchContentManifest, parseContentManifest } from "./manifest";
import type { ActiveContent, AppliedContentUpdate, ContentArtifact, ContentManifest, ContentUpdateStatus } from "./types";

export const CONTENT_MANIFEST_CACHE_TTL_MS = 20 * 60 * 60 * 1_000;
export const CONTENT_UPDATE_TIMEOUT_MS = 8_000;
const CONTENT_ARTIFACT_MAX_BYTES = 2_147_483_648;
const CONTENT_SKILLS_MAX_BYTES = 256 * 1024 * 1024;
const CONTENT_SKILLS_MAX_ENTRIES = 8_192;
const CONTENT_SKILLS_LISTING_MAX_BYTES = 4 * 1024 * 1024;
const CONTENT_LOCK_STALE_MS = 15 * 60 * 1_000;
const CONTENT_PREFERENCES_MAX_BYTES = 32 * 1024;

type ManifestCache = { checkedAt: number; manifestUrl: string; manifest?: ContentManifest; error?: string };
type ContentPreferences = { dismissedVersion?: string };

export type ContentUpdateOptions = {
  workspace?: string;
  manifestUrl?: string;
  fetcher?: typeof fetch;
  now?: number;
  timeoutMs?: number;
  force?: boolean;
};

export async function checkContentUpdate(options: ContentUpdateOptions = {}): Promise<ContentUpdateStatus> {
  const config = loadConfig(options.workspace);
  const manifestUrl = options.manifestUrl ?? process.env.FARAI_CONTENT_MANIFEST_URL ?? config.updates?.contentManifestUrl ?? DEFAULT_CONTENT_MANIFEST_URL;
  if (contentUpdateDisabled(config.updates?.contentEnabled)) return { state: "disabled", manifestUrl, fromCache: false };
  const now = options.now ?? Date.now();
  const cached = readManifestCache();
  const cacheMatches = cached?.manifestUrl === manifestUrl;
  let manifest: ContentManifest | undefined;
  let fromCache = false;
  if (!options.force && cacheMatches && cached && isFresh(cached.checkedAt, now)) {
    if (!cached.manifest) return { state: "error", manifestUrl, fromCache: true, ...(cached.error ? { error: cached.error } : {}) };
    manifest = cached.manifest;
    fromCache = true;
  } else {
    try {
      manifest = await fetchContentManifest(manifestUrl, {
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        timeoutMs: options.timeoutMs ?? CONTENT_UPDATE_TIMEOUT_MS
      });
      writeManifestCache({ checkedAt: now, manifestUrl, manifest });
    } catch (error) {
      const message = errorMessage(error);
      if (cacheMatches && cached?.manifest) {
        manifest = cached.manifest;
        fromCache = true;
        writeManifestCache({ checkedAt: now, manifestUrl, manifest, error: message });
      } else {
        writeManifestCache({ checkedAt: now, manifestUrl, error: message });
        return { state: "error", manifestUrl, fromCache: false, error: message };
      }
    }
  }
  const active = readActiveContent();
  if (!manifest || (!manifest.knowledge && !manifest.skills)) return { state: "unavailable", manifestUrl, fromCache, ...(active ? { active } : {}), ...(manifest ? { manifest } : {}) };
  if (manifest.minFaraiVersion && isSemver(manifest.minFaraiVersion) && compareSemver(FARAI_VERSION, manifest.minFaraiVersion) < 0) {
    return { state: "incompatible", manifestUrl, fromCache, manifest, ...(active ? { active } : {}) };
  }
  if (!isNewerManifest(manifest, active)) return { state: "up_to_date", manifestUrl, fromCache, manifest, ...(active ? { active } : {}) };
  return { state: "update_available", manifestUrl, fromCache, manifest, ...(active ? { active } : {}) };
}

export async function applyContentUpdate(manifest: ContentManifest, manifestUrl: string, options: { fetcher?: typeof fetch; timeoutMs?: number } = {}): Promise<AppliedContentUpdate> {
  if (!manifest.knowledge && !manifest.skills) throw new Error("content manifest has no artifacts");
  ensureContentDirectories();
  const release = acquireLock();
  const stage = join(contentVersionsDir(), `.staging-${process.pid}-${randomUUID()}`);
  const finalPath = contentVersionDir(manifest.contentVersion);
  try {
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    ensurePrivateDirectory(stage, "content staging directory");
    let knowledge = false;
    let skills = false;
    if (manifest.knowledge) {
      const path = join(stage, "knowledge.db");
      await downloadArtifact(manifest.knowledge, path, options);
      validateKnowledge(path, manifest.knowledge.schemaVersion);
      knowledge = true;
    }
    if (manifest.skills) {
      if (manifest.skills.size > CONTENT_SKILLS_MAX_BYTES) throw new Error("skills artifact is too large");
      const archive = join(stage, "skills.tar.gz");
      await downloadArtifact(manifest.skills, archive, options);
      await extractSkills(archive, join(stage, "skills"));
      rmSync(archive, { force: true });
      skills = true;
    }
    atomicWriteFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    ensurePrivateRegularFileIfExists(join(stage, "manifest.json"), "staged content manifest");
    if (existsSync(finalPath)) {
      const existing = join(finalPath, "manifest.json");
      if (existsSync(existing)) {
        const current = parseStoredManifest(existing);
        if (JSON.stringify(current) !== JSON.stringify(manifest)) throw new Error(`content version already exists with different metadata: ${manifest.contentVersion}`);
        rmSync(stage, { recursive: true, force: true });
      } else {
        rmSync(finalPath, { recursive: true, force: true });
        renameSync(stage, finalPath);
      }
    } else {
      renameSync(stage, finalPath);
    }
    ensurePrivateDirectory(finalPath, "content version directory");
    const previous = readActiveContent();
    const pointer: ActiveContent = {
      schemaVersion: 1,
      version: manifest.contentVersion,
      generatedAt: manifest.generatedAt,
      activatedAt: new Date().toISOString(),
      manifestUrl,
      ...(previous && previous.version !== manifest.contentVersion ? { previousVersion: previous.version } : {}),
      knowledge,
      skills
    };
    atomicWriteFile(contentActivePath(), `${JSON.stringify(pointer, null, 2)}\n`, 0o600);
    syncDirectory(contentVersionsDir());
    pruneVersions(pointer);
    return {
      version: pointer.version,
      ...(pointer.previousVersion ? { previousVersion: pointer.previousVersion } : {}),
      knowledge,
      skills,
      path: finalPath
    };
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    release();
  }
}

export function rollbackContentUpdate(): AppliedContentUpdate {
  ensureContentDirectories();
  const release = acquireLock();
  try {
    const active = readActiveContent();
    if (!active?.previousVersion) throw new Error("no previous content version is available");
    const previousPath = contentVersionDir(active.previousVersion);
    if (!existsSync(previousPath)) throw new Error(`previous content version is missing: ${active.previousVersion}`);
    const manifest = parseStoredManifest(join(previousPath, "manifest.json"));
    const next: ActiveContent = {
      schemaVersion: 1,
      version: active.previousVersion,
      generatedAt: manifest.generatedAt,
      activatedAt: new Date().toISOString(),
      manifestUrl: active.manifestUrl,
      previousVersion: active.version,
      knowledge: Boolean(manifest.knowledge && existsSync(join(previousPath, "knowledge.db"))),
      skills: Boolean(manifest.skills && existsSync(join(previousPath, "skills")))
    };
    atomicWriteFile(contentActivePath(), `${JSON.stringify(next, null, 2)}\n`, 0o600);
    return { version: next.version, previousVersion: next.previousVersion!, knowledge: next.knowledge, skills: next.skills, path: previousPath };
  } finally {
    release();
  }
}

export function contentStatus(): { active?: ActiveContent; knowledgePath?: string; skillsPath?: string; versions: string[] } {
  ensureContentDirectories();
  const active = readActiveContent();
  const versions = readdirVersions();
  const knowledgePath = activeContentKnowledgePath();
  const skillsPath = activeContentSkillsDir();
  return { ...(active ? { active } : {}), ...(knowledgePath ? { knowledgePath } : {}), ...(skillsPath ? { skillsPath } : {}), versions };
}

export function isContentVersionDismissed(version: string): boolean {
  try {
    const value = JSON.parse(readBoundedFileTextSyncNoFollow(contentPreferencesPath(), CONTENT_PREFERENCES_MAX_BYTES, "content preferences")) as ContentPreferences;
    return value.dismissedVersion === version;
  } catch {
    return false;
  }
}

export function dismissContentVersion(version: string): void {
  ensureContentDirectories();
  atomicWriteFile(contentPreferencesPath(), `${JSON.stringify({ dismissedVersion: version } satisfies ContentPreferences)}\n`, 0o600);
}

function contentUpdateDisabled(configured: boolean | undefined): boolean {
  if (configured === false) return true;
  return [process.env.FARAI_DISABLE_CONTENT_UPDATE, process.env.FARAI_DISABLE_UPDATE_CHECK].some((value) => value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes");
}

function isNewerManifest(manifest: ContentManifest, active: ActiveContent | undefined): boolean {
  if (!active) return true;
  if (manifest.contentVersion === active.version) return false;
  const generated = Date.parse(manifest.generatedAt);
  const activeGenerated = Date.parse(active.generatedAt);
  if (Number.isFinite(generated) && Number.isFinite(activeGenerated)) return generated > activeGenerated;
  return manifest.contentVersion > active.version;
}

function readManifestCache(): ManifestCache | undefined {
  try {
    ensureContentDirectories();
    const parsed = JSON.parse(readBoundedFileTextSyncNoFollow(contentManifestCachePath(), CONTENT_MANIFEST_MAX_BYTES * 2, "content manifest cache")) as Record<string, unknown>;
    if (typeof parsed.checkedAt !== "number" || !Number.isFinite(parsed.checkedAt) || typeof parsed.manifestUrl !== "string" || !parsed.manifestUrl) return undefined;
    const manifest = parsed.manifest ? parseContentManifest(parsed.manifest, new URL(parsed.manifestUrl)) : undefined;
    const error = typeof parsed.error === "string" && parsed.error ? parsed.error : undefined;
    if (!manifest && !error) return undefined;
    return { checkedAt: parsed.checkedAt, manifestUrl: parsed.manifestUrl, ...(manifest ? { manifest } : {}), ...(error ? { error } : {}) };
  } catch {
    return undefined;
  }
}

function writeManifestCache(cache: ManifestCache): void {
  try {
    ensureContentDirectories();
    atomicWriteFile(contentManifestCachePath(), `${JSON.stringify(cache)}\n`, 0o600);
  } catch {}
}

function isFresh(checkedAt: number, now: number): boolean {
  const age = now - checkedAt;
  return age >= 0 && age < CONTENT_MANIFEST_CACHE_TTL_MS;
}

function acquireLock(): () => void {
  const path = contentLockPath();
  ensureContentDirectories();
  try {
    const descriptor = openSync(path, "wx", 0o600);
    try { writeSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() })); } finally { closeSync(descriptor); }
    cleanupStagingDirectories();
    return () => { try { unlinkSync(path); } catch {} };
  } catch (error) {
    if (!isAlreadyExists(error) || !staleLock(path)) throw new Error("another farai content update is already running");
    try { unlinkSync(path); } catch { throw new Error("another farai content update is already running"); }
    return acquireLock();
  }
}

function staleLock(path: string): boolean {
  try {
    const stats = statSync(path);
    const parsed = JSON.parse(readBoundedFileTextSyncNoFollow(path, 4 * 1024, "content update lock")) as { pid?: unknown };
    if (typeof parsed.pid === "number" && parsed.pid > 0) {
      try { process.kill(parsed.pid, 0); return false; } catch (error) { if (!isNoSuchProcess(error)) return false; }
    }
    return Date.now() - stats.mtimeMs >= CONTENT_LOCK_STALE_MS || typeof parsed.pid === "number";
  } catch {
    return true;
  }
}

function cleanupStagingDirectories(): void {
  for (const entry of readdirSync(contentVersionsDir())) {
    if (!entry.startsWith(".staging-")) continue;
    try { rmSync(join(contentVersionsDir(), entry), { recursive: true, force: true }); } catch {}
  }
}

async function downloadArtifact(artifact: ContentArtifact, destination: string, options: { fetcher?: typeof fetch; timeoutMs?: number }): Promise<void> {
  if (artifact.size > CONTENT_ARTIFACT_MAX_BYTES) throw new Error("content artifact is too large");
  const url = new URL(artifact.url);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  let bytes: number;
  if (url.protocol === "file:") {
    const source = Bun.file(url);
    const sourcePath = fileURLToPath(url);
    const stats = lstatSync(sourcePath);
    if (!stats.isFile()) throw new Error("content artifact file must be a regular file");
    if (stats.size !== artifact.size) throw new Error(`content artifact size mismatch: expected ${artifact.size}, received ${stats.size}`);
    await Bun.write(destination, source);
    bytes = stats.size;
  } else {
    if (url.protocol !== "https:") throw new Error("content artifact must use https or file");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs ?? CONTENT_UPDATE_TIMEOUT_MS));
    timer.unref?.();
    let descriptor: number | undefined;
    try {
      const response = await (options.fetcher ?? fetch)(url, { signal: controller.signal });
      if (!response.ok || !response.body) {
        try { await response.body?.cancel(); } catch {}
        throw new Error(`content artifact returned ${response.status}`);
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isSafeInteger(declared) && declared !== artifact.size) throw new Error(`content artifact size mismatch: expected ${artifact.size}, received ${declared}`);
      descriptor = openSync(destination, "wx", 0o600);
      const reader = response.body.getReader();
      bytes = 0;
      let completed = false;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) { completed = true; break; }
          bytes += next.value.byteLength;
          if (bytes > artifact.size) throw new Error("content artifact exceeded declared size");
          writeSync(descriptor, next.value);
        }
      } finally {
        if (!completed) void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      closeSync(descriptor);
      descriptor = undefined;
    } finally {
      clearTimeout(timer);
      if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
    }
  }
  if (bytes !== artifact.size) throw new Error(`content artifact size mismatch: expected ${artifact.size}, received ${bytes}`);
  const digest = hashFile(destination);
  if (digest !== artifact.sha256) throw new Error(`content artifact checksum mismatch for ${url.href}`);
  ensurePrivateRegularFileIfExists(destination, "downloaded content artifact");
}

function validateKnowledge(path: string, schemaVersion: number | undefined): void {
  ensurePrivateSqlitePath(path, "staged knowledge database");
  if (schemaVersion !== undefined && schemaVersion !== KNOWLEDGE_SCHEMA_VERSION) throw new Error(`unsupported knowledge schema: ${schemaVersion}`);
  const store = KnowledgeStore.openIfExists(path);
  if (!store) throw new Error("staged knowledge database could not be opened");
  try {
    const integrity = store.verifyIntegrity();
    if (!integrity.ok) throw new Error(`staged knowledge database failed integrity: ${integrity.issues.map((issue) => `${issue.kind}=${issue.count}`).join(", ")}`);
  } finally {
    store.close();
  }
}

async function extractSkills(archive: string, destination: string): Promise<void> {
  const listing = await spawnTar(["-tzf", archive]);
  if (Buffer.byteLength(listing, "utf8") > CONTENT_SKILLS_LISTING_MAX_BYTES) throw new Error("skills archive listing is too large");
  const listingEntries = listing.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (listingEntries.length > CONTENT_SKILLS_MAX_ENTRIES) throw new Error("skills archive contains too many entries");
  for (const entry of listingEntries) {
    if (entry.startsWith("/") || entry.split("/").includes("..") || entry.includes("\\")) throw new Error("skills archive contains an unsafe path");
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  await spawnTar(["-xzf", archive, "-C", destination]);
  const extractedEntries = [...walk(destination)];
  if (extractedEntries.some((path) => lstatSync(path).isSymbolicLink())) throw new Error("skills archive contains a symbolic link");
  if (!extractedEntries.some((path) => path.endsWith("/SKILL.md"))) throw new Error("skills archive contains no skills");
}

async function spawnTar(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`skills archive operation failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  return stdout;
}

function* walk(root: string): Generator<string> {
  const entries = readdirSync(root).sort();
  for (const entry of entries) {
    const path = join(root, entry);
    const stat = lstatSync(path);
    yield path;
    if (stat.isDirectory()) yield* walk(path);
  }
}

function hashFile(path: string): string {
  const descriptor = openSync(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function parseStoredManifest(path: string): ContentManifest {
  ensurePrivateRegularFileIfExists(path, "stored content manifest");
  const raw = JSON.parse(readBoundedFileTextSyncNoFollow(path, CONTENT_MANIFEST_MAX_BYTES, "stored content manifest"));
  return parseContentManifest(raw, new URL("file:///stored/manifest.json"));
}

function pruneVersions(active: ActiveContent): void {
  const keep = new Set([active.version, active.previousVersion].filter((value): value is string => Boolean(value)));
  for (const version of readdirVersions()) {
    if (keep.has(version)) continue;
    try { rmSync(contentVersionDir(version), { recursive: true, force: true }); } catch {}
  }
}

function readdirVersions(): string[] {
  try {
    return readdirSync(contentVersionsDir()).sort().filter((entry) => !entry.startsWith(".") && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry));
  } catch {
    return [];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function isNoSuchProcess(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
}
