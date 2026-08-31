import { createHash } from "node:crypto";
import { lstatSync, readlinkSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { BoundedOutputBuffer } from "../agent-tools/backends/output-buffer";
import { isolatedProcessGroup, terminateProcessTree } from "../agent-tools/backends/process-tree";
import { hashFile, sha256 } from "./hash";

const GIT_COMMAND_TIMEOUT_MS = 30_000;
const GIT_ERROR_MAX_BYTES = 64 * 1024;
const GIT_TEXT_MAX_BYTES = 8 * 1024;
const GIT_UNTRACKED_PATH_MAX_BYTES = 1024 * 1024;
const GIT_UNTRACKED_FILE_MAX_COUNT = 1_000_000;

export type GitSourceState = {
  commit?: string;
  dirtyStateHash: string;
  algorithm: "git-worktree-v2";
};

export async function freezeGitSourceState(root: string): Promise<GitSourceState> {
  if (!await isGitWorktree(root)) return unavailableState();
  const commitBefore = await readGitCommit(root);
  const first = await hashGitWorktree(root, Boolean(commitBefore));
  const commitBetween = await readGitCommit(root);
  const second = await hashGitWorktree(root, Boolean(commitBetween));
  const commitAfter = await readGitCommit(root);
  if (commitBetween !== commitBefore || commitAfter !== commitBefore || second !== first) {
    throw new Error("farai source changed while benchmark provenance was being frozen");
  }
  return { ...(commitBefore ? { commit: commitBefore } : {}), dirtyStateHash: first, algorithm: "git-worktree-v2" };
}

async function isGitWorktree(root: string): Promise<boolean> {
  const output = new BoundedOutputBuffer(GIT_TEXT_MAX_BYTES, 1);
  const exitCode = await runGit(root, ["rev-parse", "--is-inside-work-tree"], (chunk) => output.push(chunk), true);
  return exitCode === 0 && output.text().trim() === "true";
}

async function readGitCommit(root: string): Promise<string | undefined> {
  const output = new BoundedOutputBuffer(GIT_TEXT_MAX_BYTES, 1);
  const exitCode = await runGit(root, ["rev-parse", "--verify", "HEAD"], (chunk) => output.push(chunk), true);
  if (exitCode !== 0) return undefined;
  const commit = output.text().trim();
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error("git returned an invalid HEAD object id");
  return commit.toLowerCase();
}

async function hashGitWorktree(root: string, hasCommit: boolean): Promise<string> {
  const hash = createHash("sha256");
  hash.update("farai-git-worktree-v2\0");
  await hashCommand(root, ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=none"], hash, "status");
  await hashCommand(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--submodule=diff", "--"], hash, "unstaged");
  await hashCommand(root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--submodule=diff", ...(hasCommit ? ["HEAD"] : ["--root"]), "--"], hash, "staged");
  await hashUntrackedPaths(root, hash);
  return hash.digest("hex");
}

async function hashCommand(root: string, args: string[], hash: ReturnType<typeof createHash>, label: string): Promise<void> {
  hash.update(`${label}\0`);
  await runGit(root, args, (chunk) => hash.update(chunk));
  hash.update("\0");
}

async function hashUntrackedPaths(root: string, hash: ReturnType<typeof createHash>): Promise<void> {
  let pending = Buffer.alloc(0);
  let count = 0;
  hash.update("untracked\0");
  await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], (chunk) => {
    pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
    if (pending.length > GIT_UNTRACKED_PATH_MAX_BYTES && pending.indexOf(0) === -1) throw new Error("git returned an oversized untracked path");
    for (;;) {
      const end = pending.indexOf(0);
      if (end === -1) break;
      if (end > GIT_UNTRACKED_PATH_MAX_BYTES) throw new Error("git returned an oversized untracked path");
      count += 1;
      if (count > GIT_UNTRACKED_FILE_MAX_COUNT) throw new Error(`git returned more than ${GIT_UNTRACKED_FILE_MAX_COUNT} untracked files`);
      hashUntrackedPath(root, pending.subarray(0, end), hash);
      pending = pending.subarray(end + 1);
    }
  });
  if (pending.length !== 0) throw new Error("git returned an unterminated untracked path");
  hash.update(`count\0${count}\0`);
}

function hashUntrackedPath(root: string, encodedPath: Buffer, hash: ReturnType<typeof createHash>): void {
  const path = encodedPath.toString("utf8");
  if (!Buffer.from(path, "utf8").equals(encodedPath)) throw new Error("git returned an untracked path that is not valid utf-8");
  const absolute = resolve(root, path);
  const local = relative(resolve(root), absolute);
  if (!path || isAbsolute(path) || local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(local)) {
    throw new Error(`git returned an unsafe untracked path: ${path}`);
  }
  const stat = lstatSync(absolute);
  hash.update("path\0");
  hash.update(encodedPath);
  hash.update("\0");
  if (stat.isFile()) {
    hash.update(`file\0${stat.mode & 0o777}\0${stat.size}\0${hashFile(absolute)}\0`);
    return;
  }
  if (stat.isSymbolicLink()) {
    hash.update("symlink\0");
    hash.update(readlinkSync(absolute, "buffer"));
    hash.update("\0");
    return;
  }
  throw new Error(`benchmark provenance cannot freeze untracked special file: ${path}`);
}

async function runGit(root: string, args: string[], consume: (chunk: Buffer) => void, allowNonZero = false): Promise<number | null> {
  const child = spawn("git", ["-C", root, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: isolatedProcessGroup()
  });
  const stderr = new BoundedOutputBuffer(GIT_ERROR_MAX_BYTES, 0);
  let settled = false;
  let terminating = false;
  let failure: Error | undefined;
  let close!: () => void;
  let resolveRun!: (exitCode: number | null) => void;
  let rejectRun!: (error: Error) => void;
  const exited = new Promise<void>((resolveExit) => { close = resolveExit; });
  const timer = setTimeout(() => abort(new Error(`git ${args[0] ?? "command"} timed out`)), GIT_COMMAND_TIMEOUT_MS);
  timer.unref?.();

  const finish = (exitCode: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (failure) rejectRun(failure);
    else if (exitCode !== 0 && !allowNonZero) rejectRun(new Error(`git ${args[0] ?? "command"} failed${stderr.text().trim() ? `: ${stderr.text().trim()}` : ""}`));
    else resolveRun(exitCode);
  };
  const abort = (error: Error) => {
    if (settled || terminating) return;
    terminating = true;
    failure ??= error;
    void terminateProcessTree(child, exited).finally(() => {
      close();
      finish(null);
    });
  };

  return await new Promise<number | null>((resolvePromise, rejectPromise) => {
    resolveRun = resolvePromise;
    rejectRun = rejectPromise;
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      try { consume(chunk); } catch (error) { abort(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      failure ??= error;
      close();
      finish(127);
    });
    child.once("close", (code) => {
      close();
      finish(code);
    });
    void exited.then(() => {
      if (failure) finish(null);
    });
  });
}

function unavailableState(): GitSourceState {
  return {
    dirtyStateHash: sha256("farai-git-worktree-v2\0unavailable"),
    algorithm: "git-worktree-v2"
  };
}
