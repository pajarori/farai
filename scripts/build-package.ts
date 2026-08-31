#!/usr/bin/env bun
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";
import { readBoundedFileText, readBoundedFileTextSync } from "../src/file-read";

const root = join(import.meta.dir, "..");
const outfile = join(root, "dist", "cli", "index.js");
const packageJson = JSON.parse(readBoundedFileTextSync(join(root, "package.json"), 1024 * 1024, "package metadata")) as {
  version?: string;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
};
if (!packageJson.version) throw new Error("package version is required");
const declaredBin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.farai;
if (declaredBin !== "dist/cli/index.js") {
  throw new Error(`package bin must point to dist/cli/index.js, received ${declaredBin ?? "nothing"}`);
}
const openTuiSolidEntry = join(dirname(fileURLToPath(import.meta.resolve("@opentui/solid"))), "index.js");
const solidClientEntry = fileURLToPath(import.meta.resolve("solid-js/dist/solid.js"));
const solidStoreClientEntry = fileURLToPath(import.meta.resolve("solid-js/store/dist/store.js"));
const solidClientRuntimePlugin: BunPlugin = {
  name: "solid-client-runtime",
  setup(build) {
    build.onResolve({ filter: /^solid-js(?:\/dist\/solid\.js)?$/ }, () => ({ path: solidClientEntry }));
    build.onResolve({ filter: /^solid-js\/store(?:\/dist\/store\.js)?$/ }, () => ({ path: solidStoreClientEntry }));
  }
};
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
  define: { __FARAI_VERSION__: JSON.stringify(packageJson.version) },
  plugins: [solidClientRuntimePlugin, openTuiSolidClientPlugin, solidPlugin],
  sourcemap: "linked"
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const bundle = await readBoundedFileText(outfile, 64 * 1024 * 1024, "production bundle");
if (/from\s+["']solid-js(?:\/store)?(?:\/dist\/(?:solid|store)\.js)?["']/.test(bundle)) {
  throw new Error("production bundle externalizes Solid and may split the reactive runtime");
}
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
