import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const docsRoot = resolve(process.argv[2] ?? "");
const sourceVersion = process.argv[3] ?? "unknown";
const outputPath = resolve(process.argv[4] ?? "src/agent-core/kali-command-catalog.generated.ts");

const commands = new Set<string>();
for (const directory of readdirSync(docsRoot).sort()) {
  let content: string;
  try {
    content = readFileSync(join(docsRoot, directory, "index.md"), "utf8");
  } catch {
    continue;
  }
  const metapackages = content.match(/^Metapackages:\s*(.+)$/m)?.[1]?.trim().split(/\s+/) ?? [];
  if (!metapackages.includes("kali-linux-everything")) continue;
  for (const match of content.matchAll(/^ ##### ([^\s#]+)\s*$/gm)) {
    const command = match[1];
    if (!command) continue;
    commands.add(command);
  }
}

const grouped = new Map<string, string[]>();
for (const command of commands) {
  const initial = command[0]?.toLowerCase() ?? "";
  const prefix = /^[a-z]$/.test(initial) ? initial : /^[0-9]$/.test(initial) ? "0-9" : "symbols";
  const entries = grouped.get(prefix) ?? [];
  entries.push(command);
  grouped.set(prefix, entries);
}

const rows = ["0-9", ..."abcdefghijklmnopqrstuvwxyz", "symbols"]
  .map((name) => [name, [...(grouped.get(name) ?? [])].sort((a, b) => a.localeCompare(b))] as const)
  .filter(([, commands]) => commands.length > 0);
const renderedRows = rows.map(([name, commands]) => `  [${JSON.stringify(name)}, ${JSON.stringify(commands)}]`).join(",\n");
const output = [
  `export const KALI_CATALOG_SOURCE_VERSION = ${JSON.stringify(sourceVersion)};`,
  `export const KALI_OFFICIAL_COMMAND_COUNT = ${commands.size};`,
  "export const KALI_COMMANDS_BY_PREFIX = [",
  renderedRows,
  "] as const;",
  ""
].join("\n");

writeFileSync(outputPath, output);
