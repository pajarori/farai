import { readFileSync } from "node:fs";

declare const __FARAI_VERSION__: string;

export const FARAI_VERSION = resolveFaraiVersion();

function resolveFaraiVersion(): string {
  if (typeof __FARAI_VERSION__ === "string" && __FARAI_VERSION__) return __FARAI_VERSION__;
  try {
    const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version) return parsed.version;
  } catch {}
  return "0.0.0";
}
