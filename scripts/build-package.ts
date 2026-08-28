#!/usr/bin/env bun
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const outfile = join(root, "dist", "cli", "index.js");

rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(dirname(outfile), { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src", "cli", "index.ts")],
  outdir: dirname(outfile),
  target: "bun",
  packages: "external",
  naming: "index.js"
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

chmodSync(outfile, 0o755);
console.log(`built ${outfile}`);
