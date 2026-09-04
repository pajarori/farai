import { dirname, join } from "node:path";
import { globalDataDir } from "../agent-core/config";
import { discardResponseBody, readBoundedResponseJson } from "../http-response";
import { readBoundedFileTextSync, readBoundedFileTextSyncNoFollow } from "../file-read";
import { atomicWriteFile } from "../agent-core/atomic-file";
import { ensurePrivateDirectory, ensurePrivateRegularFileIfExists } from "../agent-core/private-path";
import { compareSemver, isSemver } from "../agent-core/semver";

export { compareSemver } from "../agent-core/semver";

export const UPDATE_CACHE_TTL_MS = 20 * 60 * 60 * 1_000;
export const UPDATE_CHECK_TIMEOUT_MS = 4_000;
export const UPDATE_REGISTRY_URL = "https://registry.npmjs.org/farai/latest";
const UPDATE_RESPONSE_MAX_BYTES = 64 * 1024;

export type UpdateNotice = {
  currentVersion: string;
  latestVersion: string;
  updateCommand: string;
};

export type PreparedUpdateCheck = {
  cachedNotice: UpdateNotice | undefined;
  refresh: Promise<UpdateNotice | undefined> | undefined;
};

type UpdateCache = {
  checkedAt: number;
  latestVersion: string;
};

type PrepareUpdateCheckOptions = {
  cachePath?: string;
  currentVersion?: string;
  fetcher?: UpdateFetcher;
  now?: number;
  timeoutMs?: number;
};

type UpdateFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function prepareUpdateCheck(options: PrepareUpdateCheckOptions = {}): PreparedUpdateCheck {
  if (updateCheckDisabled()) return { cachedNotice: undefined, refresh: undefined };
  const currentVersion = options.currentVersion ?? readCurrentVersion();
  if (!currentVersion) return { cachedNotice: undefined, refresh: undefined };

  const now = options.now ?? Date.now();
  const cachePath = options.cachePath ?? updateCachePath();
  const cache = readUpdateCache(cachePath);
  const cachedNotice = cache ? createUpdateNotice(currentVersion, cache.latestVersion) : undefined;
  if (cache && isFreshCache(cache, now)) return { cachedNotice, refresh: undefined };

  return {
    cachedNotice,
    refresh: refreshUpdateNotice({
      cachePath,
      currentVersion,
      fetcher: options.fetcher ?? fetch,
      now,
      timeoutMs: options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS,
      fallback: cachedNotice
    })
  };
}

export function createUpdateNotice(currentVersion: string, latestVersion: string): UpdateNotice | undefined {
  if (compareSemver(latestVersion, currentVersion) <= 0) return undefined;
  return {
    currentVersion,
    latestVersion,
    updateCommand: "npm install -g farai@latest"
  };
}

export function readUpdateCache(path = updateCachePath()): UpdateCache | undefined {
  try {
    ensurePrivateDirectory(dirname(path), "update cache directory");
    ensurePrivateRegularFileIfExists(path, "update cache");
    const parsed: unknown = JSON.parse(readBoundedFileTextSyncNoFollow(path, UPDATE_RESPONSE_MAX_BYTES, "update cache"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    if (typeof value.checkedAt !== "number" || !Number.isFinite(value.checkedAt)) return undefined;
    if (typeof value.latestVersion !== "string" || !isSemver(value.latestVersion)) return undefined;
    return { checkedAt: value.checkedAt, latestVersion: value.latestVersion };
  } catch {
    return undefined;
  }
}

export function updateCachePath(): string {
  return join(globalDataDir(), "update.json");
}

function readCurrentVersion(): string | undefined {
  try {
    const packagePath = join(import.meta.dir, "..", "..", "package.json");
    const parsed = JSON.parse(readBoundedFileTextSync(packagePath, 1024 * 1024, "package metadata")) as { version?: unknown };
    return typeof parsed.version === "string" && isSemver(parsed.version) ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

async function refreshUpdateNotice(input: {
  cachePath: string;
  currentVersion: string;
  fetcher: UpdateFetcher;
  now: number;
  timeoutMs: number;
  fallback: UpdateNotice | undefined;
}): Promise<UpdateNotice | undefined> {
  try {
    const latestVersion = await fetchLatestVersion(input.fetcher, input.timeoutMs);
    writeUpdateCache(input.cachePath, { checkedAt: input.now, latestVersion });
    return createUpdateNotice(input.currentVersion, latestVersion);
  } catch {
    return input.fallback;
  }
}

async function fetchLatestVersion(fetcher: UpdateFetcher, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  try {
    const response = await fetcher(UPDATE_REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      await discardResponseBody(response);
      throw new Error(`npm registry returned ${response.status}`);
    }
    const parsed: unknown = await readBoundedResponseJson(response, UPDATE_RESPONSE_MAX_BYTES, "npm registry response");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid npm registry response");
    const version = (parsed as Record<string, unknown>).version;
    if (typeof version !== "string" || !isSemver(version)) throw new Error("invalid npm package version");
    return version;
  } finally {
    clearTimeout(timer);
  }
}

function writeUpdateCache(path: string, cache: UpdateCache): void {
  try {
    ensurePrivateDirectory(dirname(path), "update cache directory");
    ensurePrivateRegularFileIfExists(path, "update cache");
    atomicWriteFile(path, `${JSON.stringify(cache)}\n`, 0o600);
  } catch {
  }
}

function isFreshCache(cache: UpdateCache, now: number): boolean {
  const age = now - cache.checkedAt;
  return age >= 0 && age < UPDATE_CACHE_TTL_MS;
}

function updateCheckDisabled(): boolean {
  return envEnabled(process.env.FARAI_DISABLE_UPDATE_CHECK) || envEnabled(process.env.NO_UPDATE_NOTIFIER);
}

function envEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}
