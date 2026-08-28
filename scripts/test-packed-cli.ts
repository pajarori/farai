#!/usr/bin/env bun
import { mkdtempSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "farai-package-smoke-"));

try {
  const pack = await run(["npm", "pack", "--json", "--pack-destination", scratch], root);
  const jsonStart = pack.lastIndexOf("\n[");
  const records = JSON.parse(jsonStart >= 0 ? pack.slice(jsonStart + 1) : pack) as Array<{ filename?: string }>;
  const filename = records[0]?.filename;
  if (!filename) throw new Error("npm pack did not report a tarball filename");
  const tarball = resolve(scratch, filename);

  await run(["npm", "init", "-y"], scratch);
  await run(["npm", "install", "--no-audit", "--no-fund", tarball], scratch);

  const packageRoot = join(scratch, "node_modules", "farai");
  const bin = join(scratch, "node_modules", ".bin", process.platform === "win32" ? "farai.cmd" : "farai");
  if (process.platform !== "win32") {
    const target = realpathSync(resolve(dirname(bin), readlinkSync(bin)));
    const expected = realpathSync(join(packageRoot, "dist", "cli", "index.js"));
    if (target !== expected) {
      throw new Error(`packed CLI points to ${relative(scratch, target)}, expected ${relative(scratch, expected)}`);
    }
  }

  const version = (await run([bin, "--version"], scratch)).trim();
  const manifest = await Bun.file(join(root, "package.json")).json() as { version: string };
  if (version !== manifest.version) throw new Error(`packed CLI reported ${version}, expected ${manifest.version}`);
  console.log(`packed CLI smoke passed (${version})`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

async function run(cmd: string[], cwd: string): Promise<string> {
  const process = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ]);
  if (exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${exitCode})\n${stderr || stdout}`);
  return stdout;
}
