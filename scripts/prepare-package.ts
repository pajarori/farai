#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";

const builtCli = join(import.meta.dir, "..", "dist", "cli", "index.js");
if (existsSync(builtCli)) {
  console.log("dist already built");
  process.exit(0);
}

const proc = Bun.spawn({
  cmd: ["bun", "run", "build"],
  cwd: join(import.meta.dir, ".."),
  stdout: "inherit",
  stderr: "inherit"
});

process.exit(await proc.exited);
