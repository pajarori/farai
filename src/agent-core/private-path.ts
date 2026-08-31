import { chmodSync, lstatSync, mkdirSync } from "node:fs";

export function ensurePrivateDirectory(path: string, label = "private directory"): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory, not a symlink or special file`);
  chmodSync(path, 0o700);
}

export function ensurePrivateRegularFileIfExists(path: string, label = "private file"): void {
  const stat = lstatIfExists(path);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file, not a symlink or special file`);
  chmodSync(path, 0o600);
}

export function ensurePrivateSqlitePath(path: string, label = "sqlite database"): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    ensurePrivateRegularFileIfExists(candidate, label);
  }
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
