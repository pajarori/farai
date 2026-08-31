import { existsSync, lstatSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { cacheDir } from "../paths";
import { runCapturedProcess } from "../../agent-tools/backends/captured-process";
import { INTERNAL_PROCESS_OUTPUT_MAX_BYTES } from "../../agent-tools/backends/output-buffer";
import { ensurePrivateDirectory } from "../../agent-core/private-path";

const GIT_TIMEOUT_MS = 10 * 60 * 1000;

export type GitSource = {
  id: string;
  url: string;
  branch: string;
  sparse?: string[];
};

export type FetchedSource = {
  dir: string;
  pin: string;
  signed: boolean;
  signer?: string;
};

export async function fetchGitSource(source: GitSource): Promise<FetchedSource> {
  assertSource(source);
  const root = cacheDir();
  ensurePrivateDirectory(root, "knowledge cache directory");
  const dir = join(root, source.id);
  const cached = cachedRepositoryExists(dir);
  if (!cached) {
    const staging = join(root, `.${source.id}-clone-${randomUUID()}`);
    try {
      const args = ["clone", "--depth", "1", "--branch", source.branch];
      if (source.sparse?.length) args.push("--filter=blob:none", "--sparse");
      args.push("--", source.url, staging);
      await run("git", args);
      if (source.sparse?.length) await run("git", ["-C", staging, "sparse-checkout", "set", "--no-cone", "--", ...source.sparse]);
      renameSync(staging, dir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  } else {
    await run("git", ["-C", dir, "fetch", "--depth", "1", "origin", source.branch]);
    if (source.sparse?.length) await run("git", ["-C", dir, "sparse-checkout", "set", "--no-cone", "--", ...source.sparse]);
    await run("git", ["-C", dir, "checkout", "-f", `origin/${source.branch}`]);
    await run("git", ["-C", dir, "clean", "-ffd"]);
  }
  const pin = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).trim();
  const verification = await verifySignature(dir);
  return { dir, pin, ...verification };
}

async function verifySignature(dir: string): Promise<{ signed: boolean; signer?: string }> {
  try {
    const status = (await run("git", ["-C", dir, "log", "-1", "--format=%G?"])).trim();
    const signer = (await run("git", ["-C", dir, "log", "-1", "--format=%GK"])).trim();
    const signed = status === "G" || status === "U";
    return signed ? { signed: true, ...(signer ? { signer } : {}) } : { signed: false };
  } catch {
    return { signed: false };
  }
}

async function run(command: string, args: string[]): Promise<string> {
  const result = await runCapturedProcess(command, args, {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never"
    },
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: INTERNAL_PROCESS_OUTPUT_MAX_BYTES
  });
  if (result.timedOut) throw new Error(`git ${args[0] ?? "command"} timed out`);
  if (result.aborted) throw new Error(`git ${args[0] ?? "command"} was cancelled`);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed with exit code ${result.exitCode}`);
  return result.stdout;
}

function assertSource(source: GitSource): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(source.id)) throw new Error(`invalid git source id: ${source.id}`);
  if (!source.url.trim() || /[\r\n\0]/.test(source.url)) throw new Error(`invalid git source url: ${source.id}`);
  if (!source.branch.trim() || /[\r\n\0]/.test(source.branch)) throw new Error(`invalid git source branch: ${source.id}`);
  if (source.sparse?.some((entry) => !entry.trim() || /[\r\n\0]/.test(entry))) throw new Error(`invalid sparse path for git source: ${source.id}`);
}

function cachedRepositoryExists(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const directory = lstatSync(dir);
  if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error(`git source cache must be a real directory: ${dir}`);
  const git = join(dir, ".git");
  if (!existsSync(git)) throw new Error(`git source cache is not a repository: ${dir}`);
  const metadata = lstatSync(git);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`git source metadata must be a real directory: ${dir}`);
  return true;
}
