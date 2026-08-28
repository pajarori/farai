import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { cacheDir } from "../paths";

export async function fetchZippedXml(id: string, url: string, pattern: RegExp): Promise<{ xml: string; path: string }> {
  const dir = join(cacheDir(), id);
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, "download.zip");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed ${response.status}: ${url}`);
  writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
  execFileSync("unzip", ["-o", "-q", zipPath, "-d", dir], { stdio: ["ignore", "ignore", "pipe"] });
  const xmlFile = readdirSync(dir).find((entry) => pattern.test(entry));
  if (!xmlFile) throw new Error(`no xml matching ${pattern} in ${dir}`);
  const path = join(dir, xmlFile);
  return { xml: readFileSync(path, "utf8"), path };
}

export function hasUnzip(): boolean {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function cachedXml(id: string, pattern: RegExp): string | undefined {
  const dir = join(cacheDir(), id);
  if (!existsSync(dir)) return undefined;
  const xmlFile = readdirSync(dir).find((entry) => pattern.test(entry));
  return xmlFile ? readFileSync(join(dir, xmlFile), "utf8") : undefined;
}
