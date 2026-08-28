import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { cacheDir } from "../paths";

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

export function fetchGitSource(source: GitSource): FetchedSource {
  const root = cacheDir();
  mkdirSync(root, { recursive: true });
  const dir = join(root, source.id);
  if (!existsSync(join(dir, ".git"))) {
    const args = ["clone", "--depth", "1", "--branch", source.branch];
    if (source.sparse?.length) args.push("--filter=blob:none", "--sparse");
    args.push(source.url, dir);
    run("git", args);
    if (source.sparse?.length) run("git", ["-C", dir, "sparse-checkout", "set", "--no-cone", ...source.sparse]);
  } else {
    run("git", ["-C", dir, "fetch", "--depth", "1", "origin", source.branch]);
    run("git", ["-C", dir, "checkout", "-f", `origin/${source.branch}`]);
  }
  const pin = run("git", ["-C", dir, "rev-parse", "HEAD"]).trim();
  const verification = verifySignature(dir);
  return { dir, pin, ...verification };
}

function verifySignature(dir: string): { signed: boolean; signer?: string } {
  try {
    const status = run("git", ["-C", dir, "log", "-1", "--format=%G?"]).trim();
    const signer = run("git", ["-C", dir, "log", "-1", "--format=%GK"]).trim();
    const signed = status === "G" || status === "U";
    return signed ? { signed: true, ...(signer ? { signer } : {}) } : { signed: false };
  } catch {
    return { signed: false };
  }
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}
