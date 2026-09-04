import { readBoundedResponseJson, discardResponseBody } from "../http-response";
import { readBoundedFileText } from "../file-read";
import { isSemver } from "../agent-core/semver";
import type { ContentArtifact, ContentManifest } from "./types";

export const CONTENT_MANIFEST_SCHEMA_VERSION = 1;
export const CONTENT_MANIFEST_MAX_BYTES = 256 * 1024;
export const DEFAULT_CONTENT_MANIFEST_URL = "https://github.com/pajarori/farai-data/releases/latest/download/manifest.json";
const CONTENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export async function fetchContentManifest(
  manifestUrl: string,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {}
): Promise<ContentManifest> {
  const resolved = new URL(manifestUrl);
  let parsed: unknown;
  if (resolved.protocol === "file:") {
    parsed = JSON.parse(await readBoundedFileText(resolved, CONTENT_MANIFEST_MAX_BYTES, "content manifest"));
  } else {
    if (resolved.protocol !== "https:") throw new Error("content manifest must use https or file");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs ?? 5_000));
    timer.unref?.();
    try {
      const response = await (options.fetcher ?? fetch)(resolved, {
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) {
        await discardResponseBody(response);
        throw new Error(`content manifest returned ${response.status}`);
      }
      parsed = await readBoundedResponseJson(response, CONTENT_MANIFEST_MAX_BYTES, "content manifest");
    } finally {
      clearTimeout(timer);
    }
  }
  return parseContentManifest(parsed, resolved);
}

export function parseContentManifest(value: unknown, baseUrl: URL): ContentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("content manifest must be an object");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== CONTENT_MANIFEST_SCHEMA_VERSION) throw new Error(`unsupported content manifest schema: ${String(record.schemaVersion)}`);
  if (typeof record.contentVersion !== "string" || !CONTENT_VERSION_PATTERN.test(record.contentVersion)) throw new Error("invalid content version");
  if (typeof record.generatedAt !== "string" || !Number.isFinite(Date.parse(record.generatedAt))) throw new Error("invalid content generatedAt");
  const minFaraiVersion = optionalString(record.minFaraiVersion, 128, "minFaraiVersion");
  if (minFaraiVersion && !isSemver(minFaraiVersion)) throw new Error("invalid content minFaraiVersion");
  const releaseNotes = optionalString(record.releaseNotes, 4_096, "releaseNotes");
  const knowledge = artifact(record.knowledge, baseUrl, "knowledge");
  const skills = artifact(record.skills, baseUrl, "skills");
  return {
    schemaVersion: 1,
    contentVersion: record.contentVersion,
    generatedAt: new Date(record.generatedAt).toISOString(),
    ...(minFaraiVersion ? { minFaraiVersion } : {}),
    ...(releaseNotes ? { releaseNotes } : {}),
    ...(knowledge ? { knowledge } : {}),
    ...(skills ? { skills } : {})
  };
}

function artifact(value: unknown, baseUrl: URL, label: string): ContentArtifact | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} artifact must be an object`);
  const record = value as Record<string, unknown>;
  if (typeof record.url !== "string" || !record.url || record.url.length > 2_048) throw new Error(`${label} artifact has an invalid url`);
  const url = new URL(record.url, baseUrl);
  if (baseUrl.protocol === "https:" && url.protocol !== "https:") throw new Error(`${label} artifact must use https when the manifest is remote`);
  if (url.protocol !== "https:" && url.protocol !== "file:") throw new Error(`${label} artifact must use https or file`);
  if (typeof record.sha256 !== "string" || !SHA256_PATTERN.test(record.sha256)) throw new Error(`${label} artifact has an invalid sha256`);
  if (!Number.isSafeInteger(record.size) || Number(record.size) < 1 || Number(record.size) > 2_147_483_648) throw new Error(`${label} artifact has an invalid size`);
  const schemaVersion = record.schemaVersion === undefined
    ? undefined
    : Number.isSafeInteger(record.schemaVersion) && Number(record.schemaVersion) > 0
      ? Number(record.schemaVersion)
      : undefined;
  if (record.schemaVersion !== undefined && schemaVersion === undefined) throw new Error(`${label} artifact has an invalid schemaVersion`);
  return {
    url: url.href,
    sha256: record.sha256,
    size: Number(record.size),
    ...(schemaVersion ? { schemaVersion } : {})
  };
}

function optionalString(value: unknown, maxLength: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`invalid content ${label}`);
  return value.trim();
}
