import { readBoundedFileTextSync } from "./file-read";

declare const __FARAI_VERSION__: string;

export const FARAI_VERSION = resolveFaraiVersion();

function resolveFaraiVersion(): string {
  if (typeof __FARAI_VERSION__ === "string" && __FARAI_VERSION__) return __FARAI_VERSION__;
  try {
    const parsed = JSON.parse(readBoundedFileTextSync(new URL("../package.json", import.meta.url), 1024 * 1024, "package metadata")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version) return parsed.version;
  } catch {}
  return "0.0.0";
}
