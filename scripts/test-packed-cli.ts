#!/usr/bin/env bun
import { existsSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { readBoundedFileText, readFileTextPrefixSync } from "../src/file-read";
import { runCapturedProcess } from "../src/agent-tools/backends/captured-process";

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
  const manifest = JSON.parse(await readBoundedFileText(join(root, "package.json"), 1024 * 1024, "package metadata")) as { version: string; engines?: Record<string, string> };
  if (version !== manifest.version) throw new Error(`packed CLI reported ${version}, expected ${manifest.version}`);
  const packedManifest = JSON.parse(await readBoundedFileText(join(packageRoot, "package.json"), 1024 * 1024, "packed package metadata")) as { engines?: Record<string, string> };
  if (packedManifest.engines?.bun !== ">=1.1.0" || packedManifest.engines?.node) throw new Error("packed CLI must declare Bun, not Node, as its runtime");
  if (!readFileTextPrefixSync(join(packageRoot, "dist", "cli", "index.js"), 64, "packed CLI").text.startsWith("#!/usr/bin/env bun\n")) throw new Error("packed CLI is missing its Bun shebang");
  const help = await run([bin, "--help"], scratch);
  if (!help.includes("farai setup") || !help.includes("farai resume")) throw new Error("packed CLI help is incomplete");
  for (const skill of ["ctf-solving", "web-assessment", "binary-reversing", "packet-analysis", "source-security-review"]) {
    const path = join(packageRoot, "src", "agent-skills", "library", skill, "SKILL.md");
    if (!existsSync(path)) throw new Error(`packed CLI is missing built-in skill: ${skill}`);
  }
  console.log(`packed CLI smoke passed (${version})`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

async function run(cmd: string[], cwd: string): Promise<string> {
  const result = await runCapturedProcess(cmd[0]!, cmd.slice(1), { cwd, timeoutMs: 10 * 60_000, maxOutputBytes: 2 * 1024 * 1024 });
  if (result.timedOut) throw new Error(`${cmd.join(" ")} timed out`);
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${result.exitCode})\n${result.stderr || result.stdout}`);
  return result.stdout;
}
