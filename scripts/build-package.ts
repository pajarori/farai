#!/usr/bin/env bun
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

const root = join(import.meta.dir, "..");
const outfile = join(root, "dist", "cli", "index.js");
const openTuiSolidEntry = join(dirname(fileURLToPath(import.meta.resolve("@opentui/solid"))), "index.js");
const openTuiSolidClientPlugin: BunPlugin = {
  name: "opentui-solid-client-runtime",
  setup(build) {
    build.onResolve({ filter: /^@opentui\/solid$/ }, () => ({ path: openTuiSolidEntry }));
  }
};
const solidPlugin = createSolidTransformPlugin({
  resolvePath(specifier) {
    if (specifier === "solid-js") return "solid-js/dist/solid.js";
    if (specifier === "solid-js/store") return "solid-js/store/dist/store.js";
    return specifier;
  }
});

rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(dirname(outfile), { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src", "cli", "index.ts")],
  outdir: dirname(outfile),
  target: "bun",
  packages: "external",
  naming: "index.js",
  plugins: [openTuiSolidClientPlugin, solidPlugin],
  sourcemap: "linked"
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const bundle = await Bun.file(outfile).text();
if (/from\s+["']solid-js(?:\/store)?["']/.test(bundle)) {
  throw new Error("production bundle contains a bare Solid import that may resolve to the server runtime");
}
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
const dependencies = packageJson.dependencies ?? {};
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const importSpecifiers = [...bundle.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((match) => match[1]!);
for (const specifier of new Set(importSpecifiers)) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("bun:") || builtins.has(specifier)) continue;
  const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
  if (!dependencies[packageName]) throw new Error(`production bundle imports undeclared runtime dependency: ${packageName}`);
}

chmodSync(outfile, 0o755);
console.log(`built ${outfile}`);
