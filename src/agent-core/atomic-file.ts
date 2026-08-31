import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function atomicWriteFile(path: string, content: string | Uint8Array, mode: number): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", mode);
    if (typeof content === "string") writeFileSync(descriptor, content, "utf8");
    else writeFileSync(descriptor, content);
    chmodSync(temporary, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {
      }
    }
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {
    }
    throw error;
  }
}

export function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {
      }
    }
  }
}
