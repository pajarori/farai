import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type ConfigLocation = "global" | "project";

function homeDir(): string {
  const configured = process.env.HOME?.trim();
  if (configured) return configured;
  const systemHome = homedir().trim();
  if (!systemHome) throw new Error("unable to resolve the user home directory.");
  return systemHome;
}

export function localFaraiDir(): string {
  const explicit = process.env.FARAI_HOME?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error("farai_home must be an absolute path.");
    return explicit;
  }
  return join(homeDir(), ".local", "pajarori", "farai");
}

export function globalDataDir(): string {
  return localFaraiDir();
}

export function debugLogPath(): string {
  return join(globalDataDir(), "debug.jsonl");
}

export function configPath(location: ConfigLocation, workspace?: string): string {
  return location === "project" ? join(workspace ?? process.cwd(), ".farai", "config.toml") : join(localFaraiDir(), "config.toml");
}

export function authPath(location: ConfigLocation, workspace?: string): string {
  return location === "project" ? join(workspace ?? process.cwd(), ".farai", "auth.json") : join(localFaraiDir(), "auth.json");
}
