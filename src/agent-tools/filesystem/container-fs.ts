import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { ToolContext } from "../../types";
import { backend } from "../shared/backend";
import { CONTAINER_WORKSPACE_MOUNT } from "../../agent-container/kali";
import { atomicWriteFile } from "../../agent-core/atomic-file";
import { safeExistingWorkspacePath, safeWorkspacePath } from "./shared";

export function containerWorkspace(context: ToolContext): string {
  return context.executionBackend?.workspacePath ?? CONTAINER_WORKSPACE_MOUNT;
}

export function resolveContainerPath(path: string, workspace = CONTAINER_WORKSPACE_MOUNT): string {
  if (path === CONTAINER_WORKSPACE_MOUNT) return workspace;
  if (path.startsWith(`${CONTAINER_WORKSPACE_MOUNT}/`)) return `${workspace}${path.slice(CONTAINER_WORKSPACE_MOUNT.length)}`;
  if (path.startsWith("/")) return path;
  return `${workspace}/${path}`.replace(/\/{2,}/g, "/");
}

export function containerRelativePath(path: string, workspace = CONTAINER_WORKSPACE_MOUNT): string {
  const resolved = resolveContainerPath(path, workspace);
  const prefix = `${workspace}/`;
  if (resolved === workspace) return ".";
  return resolved.startsWith(prefix) ? resolved.slice(prefix.length) : resolved;
}

function assertNotProtectedPath(path: string, workspace: string, _intent: "read" | "write"): void {
  const rel = containerRelativePath(path, workspace);
  if (rel === ".farai" || rel.startsWith(".farai/")) throw new Error("path is protected: .farai");
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const FULL_FILE_MAX_CHARS = 4_000_000;

async function runInContainer(context: ToolContext, command: string, timeoutMs = 10_000, maxOutputChars?: number): Promise<string> {
  const result = await backend(context).exec(command, timeoutMs, undefined, maxOutputChars);
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || `command failed (exit ${result.exitCode})`);
  }
  return result.stdout;
}

function base64Heredoc(content: string): string {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  return (encoded.match(/.{1,4000}/g) ?? [""]).join("\n");
}

export async function containerPathKind(context: ToolContext, path: string): Promise<"dir" | "file" | "missing"> {
  const hostPath = hostWorkspacePath(context, path, "read");
  if (hostPath) {
    if (!existsSync(hostPath)) return "missing";
    const resolved = existingHostWorkspacePath(context, path, "read");
    return statSync(resolved).isDirectory() ? "dir" : "file";
  }
  const workspace = containerWorkspace(context);
  assertNotProtectedPath(path, workspace, "read");
  const p = resolveContainerPath(path, workspace);
  const out = await runInContainer(
    context,
    `if [ -d ${shQuote(p)} ]; then echo dir; elif [ -e ${shQuote(p)} ]; then echo file; else echo missing; fi`
  );
  const kind = out.trim();
  return kind === "dir" || kind === "file" ? kind : "missing";
}

export async function containerReadFile(context: ToolContext, path: string): Promise<string> {
  const hostPath = hostWorkspacePath(context, path, "read");
  if (hostPath) return readFileSync(existingHostWorkspacePath(context, path, "read"), "utf8");
  const workspace = containerWorkspace(context);
  assertNotProtectedPath(path, workspace, "read");
  return runInContainer(context, `cat -- ${shQuote(resolveContainerPath(path, workspace))}`, 10_000, FULL_FILE_MAX_CHARS);
}

export async function containerStatMtime(context: ToolContext, path: string): Promise<number | undefined> {
  const hostPath = hostWorkspacePath(context, path, "read");
  if (hostPath) {
    try { return Math.floor(statSync(existingHostWorkspacePath(context, path, "read")).mtimeMs / 1_000); }
    catch { return undefined; }
  }
  const workspace = containerWorkspace(context);
  assertNotProtectedPath(path, workspace, "read");
  const p = resolveContainerPath(path, workspace);
  try {
    const out = await runInContainer(context, `stat -c %Y -- ${shQuote(p)} 2>/dev/null || stat -f %m -- ${shQuote(p)}`, 5_000);
    const value = Number.parseInt(out.trim(), 10);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function containerListDir(context: ToolContext, path: string): Promise<string[]> {
  const hostPath = hostWorkspacePath(context, path, "read");
  if (hostPath) {
    const root = existingHostWorkspacePath(context, path, "read");
    return readdirSync(root, { withFileTypes: true })
      .sort((left, right) => Number(!left.isDirectory()) - Number(!right.isDirectory()) || left.name.localeCompare(right.name))
      .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${workspaceRelative(context.workspace, resolve(root, entry.name))}`);
  }
  const workspace = containerWorkspace(context);
  assertNotProtectedPath(path, workspace, "read");
  const target = resolveContainerPath(path, workspace);
  const script = `
import os
target = ${JSON.stringify(target)}
workspace = ${JSON.stringify(workspace)}
entries = sorted(os.listdir(target), key=lambda n: (not os.path.isdir(os.path.join(target, n)), n))
for n in entries:
    p = os.path.join(target, n)
    kind = "dir " if os.path.isdir(p) else "file"
    print(f"{kind} {os.path.relpath(p, workspace)}")
`.trim();
  const out = await runInContainer(context, `python3 - << 'FARAI_PY_EOF'\n${script}\nFARAI_PY_EOF`);
  return out.split("\n").filter(Boolean);
}

export async function containerWriteFile(context: ToolContext, path: string, content: string): Promise<void> {
  const hostPath = hostWorkspacePath(context, path, "write");
  if (hostPath) {
    mkdirSync(dirname(hostPath), { recursive: true });
    assertHostParent(context, hostPath);
    if (existsSync(hostPath)) existingHostWorkspacePath(context, path, "write");
    const mode = existsSync(hostPath) ? statSync(hostPath).mode & 0o777 : 0o644;
    atomicWriteFile(hostPath, content, mode);
    return;
  }
  const workspace = containerWorkspace(context);
  assertNotProtectedPath(path, workspace, "write");
  const p = resolveContainerPath(path, workspace);
  const tmp = `${p}.farai-tmp-${context.toolCallId}`;
  try {
    await runInContainer(context, `mkdir -p -- "$(dirname ${shQuote(p)})" && base64 -d > ${shQuote(tmp)} << 'FARAI_FS_B64_EOF'\n${base64Heredoc(content)}\nFARAI_FS_B64_EOF\n mv -f -- ${shQuote(tmp)} ${shQuote(p)}`);
  } finally {
    try { await runInContainer(context, `rm -f -- ${shQuote(tmp)}`); } catch { }
  }
}

export async function containerListFilesRecursive(context: ToolContext, path: string, limit: number): Promise<string[]> {
  const hostPath = hostWorkspacePath(context, path, "read");
  if (hostPath) return hostListFilesRecursive(context, path, limit);
  const workspace = containerWorkspace(context);
  assertNotProtectedPath(path, workspace, "read");
  const root = resolveContainerPath(path, workspace);
  const script = `
import os
root = ${JSON.stringify(root)}
limit = ${Math.max(1, Math.floor(limit))}
exclude = {".farai", "node_modules"}
out = []
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = sorted(d for d in dirnames if d not in exclude)
    for fname in sorted(filenames):
        out.append(os.path.relpath(os.path.join(dirpath, fname), root))
        if len(out) >= limit:
            break
    if len(out) >= limit:
        break
print("\\n".join(out))
`.trim();
  const out = await runInContainer(context, `python3 - << 'FARAI_PY_EOF'\n${script}\nFARAI_PY_EOF`, 15_000, FULL_FILE_MAX_CHARS);
  return out.split("\n").filter(Boolean);
}

export async function containerGrep(
  context: ToolContext,
  path: string,
  pattern: string,
  include: string | undefined,
  limit: number
): Promise<string[]> {
  const hostPath = hostWorkspacePath(context, path, "read");
  if (hostPath) return hostGrep(context, path, pattern, include, limit);
  const workspace = containerWorkspace(context);
  assertNotProtectedPath(path, workspace, "read");
  const root = resolveContainerPath(path, workspace);
  const script = `
import os, re, base64
root = ${JSON.stringify(root)}
pattern = re.compile(base64.b64decode(${JSON.stringify(Buffer.from(pattern, "utf8").toString("base64"))}).decode())
include = ${include === undefined ? "None" : JSON.stringify(include)}
limit = ${Math.max(1, Math.floor(limit))}
exclude = {".farai", "node_modules"}
matches = []
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = sorted(d for d in dirnames if d not in exclude)
    for fname in sorted(filenames):
        full = os.path.join(dirpath, fname)
        rel = os.path.relpath(full, root)
        if include and include.replace("*", "") not in rel:
            continue
        try:
            with open(full, "r", errors="ignore") as fh:
                for i, line in enumerate(fh, start=1):
                    if len(matches) >= limit:
                        break
                    if pattern.search(line):
                        matches.append(f"{rel}:{i}: {line.rstrip()[:240]}")
        except OSError:
            continue
        if len(matches) >= limit:
            break
    if len(matches) >= limit:
        break
print("\\n".join(matches))
`.trim();
  const out = await runInContainer(context, `python3 - << 'FARAI_PY_EOF'\n${script}\nFARAI_PY_EOF`, 15_000, FULL_FILE_MAX_CHARS);
  return out.split("\n").filter(Boolean);
}

export async function containerRemove(context: ToolContext, path: string): Promise<void> {
  const hostPath = hostWorkspacePath(context, path, "write");
  if (hostPath) {
    if (existsSync(hostPath)) rmSync(existingHostWorkspacePath(context, path, "write"), { force: true });
    return;
  }
  const workspace = containerWorkspace(context);
  assertNotProtectedPath(path, workspace, "write");
  await runInContainer(context, `rm -f -- ${shQuote(resolveContainerPath(path, workspace))}`);
}

export async function containerApplySimplePatch(context: ToolContext, patch: string): Promise<string[]> {
  const lines = patch.split(/\r?\n/);
  if (!lines[0]?.startsWith("*** Begin Patch")) throw new Error("patch must start with *** Begin Patch");
  if (!lines.some((line) => line.startsWith("*** End Patch"))) throw new Error("patch must end with *** End Patch");
  const applied: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("*** End Patch")) break;
    if (line.startsWith("*** Add File: ")) {
      const rel = line.slice("*** Add File: ".length).trim();
      const content: string[] = [];
      while (++i < lines.length && !lines[i]?.startsWith("***")) {
        const next = lines[i] ?? "";
        if (!next.startsWith("+")) throw new Error(`invalid add line for ${rel}`);
        content.push(next.slice(1));
      }
      i--;
      if ((await containerPathKind(context, rel)) !== "missing") throw new Error(`file already exists: ${rel}`);
      await containerWriteFile(context, rel, `${content.join("\n")}\n`);
      applied.push(`A ${rel}`);
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      const rel = line.slice("*** Delete File: ".length).trim();
      await containerRemove(context, rel);
      applied.push(`D ${rel}`);
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const rel = line.slice("*** Update File: ".length).trim();
      let current = await containerReadFile(context, rel);
      const oldLines: string[] = [];
      const newLines: string[] = [];
      while (++i < lines.length && !lines[i]?.startsWith("***")) {
        const next = lines[i] ?? "";
        if (next.startsWith("-")) { oldLines.push(next.slice(1)); continue; }
        if (next.startsWith("+")) { newLines.push(next.slice(1)); continue; }
        if (next.startsWith(" ")) { const value = next.slice(1); oldLines.push(value); newLines.push(value); continue; }
        if (next.trim()) throw new Error(`invalid update line for ${rel}`);
      }
      i--;
      const oldText = oldLines.join("\n");
      const newText = newLines.join("\n");
      if (!oldText) throw new Error(`update patch for ${rel} has no removal lines`);
      const first = current.indexOf(oldText);
      if (first < 0) throw new Error(`update patch did not match ${rel}`);
      if (current.indexOf(oldText, first + 1) >= 0) throw new Error(`update patch is ambiguous for ${rel}`);
      current = current.replace(oldText, newText);
      await containerWriteFile(context, rel, current);
      applied.push(`M ${rel}`);
      continue;
    }
    if (line.trim()) throw new Error(`unsupported patch line: ${line}`);
  }
  return applied;
}

function hostWorkspacePath(context: ToolContext, path: string, intent: "read" | "write"): string | undefined {
  if (path.startsWith("/") && path !== CONTAINER_WORKSPACE_MOUNT && !path.startsWith(`${CONTAINER_WORKSPACE_MOUNT}/`)) return undefined;
  return safeWorkspacePath(context.workspace, path, intent);
}

function existingHostWorkspacePath(context: ToolContext, path: string, intent: "read" | "write"): string {
  const lexical = safeWorkspacePath(context.workspace, path, intent);
  if (lexical === resolve(context.workspace)) return lexical;
  return safeExistingWorkspacePath(context.workspace, path, intent);
}

function assertHostParent(context: ToolContext, path: string): void {
  const root = resolve(context.workspace);
  const parent = dirname(path);
  if (parent === root) return;
  safeExistingWorkspacePath(context.workspace, relative(root, parent), "write");
}

function workspaceRelative(workspace: string, path: string): string {
  return relative(resolve(workspace), path).split(/[\\/]+/).join("/") || ".";
}

function hostListFilesRecursive(context: ToolContext, path: string, limit: number): string[] {
  const root = existingHostWorkspacePath(context, path, "read");
  if (!statSync(root).isDirectory()) throw new Error(`not a directory: ${path}`);
  const boundedLimit = Math.max(1, Math.floor(limit));
  const files: string[] = [];
  const visit = (directory: string): void => {
    if (files.length >= boundedLimit) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".farai" || entry.name === "node_modules") continue;
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(workspaceRelative(root, fullPath));
      if (files.length >= boundedLimit) return;
    }
  };
  visit(root);
  return files;
}

function hostGrep(
  context: ToolContext,
  path: string,
  pattern: string,
  include: string | undefined,
  limit: number
): string[] {
  const root = existingHostWorkspacePath(context, path, "read");
  const expression = new RegExp(pattern);
  const matches: string[] = [];
  const visit = (target: string): void => {
    if (matches.length >= limit) return;
    const info = lstatSync(target);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const entry of readdirSync(target, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.name === ".farai" || entry.name === "node_modules") continue;
        visit(resolve(target, entry.name));
        if (matches.length >= limit) return;
      }
      return;
    }
    if (!info.isFile()) return;
    const rel = workspaceRelative(root, target);
    if (include && !globMatches(rel, include)) return;
    let text: string;
    try { text = readFileSync(target, "utf8"); }
    catch { return; }
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      expression.lastIndex = 0;
      if (!expression.test(line)) continue;
      matches.push(`${rel}:${index + 1}: ${line.slice(0, 240)}`);
      if (matches.length >= limit) return;
    }
  };
  visit(root);
  return matches;
}

function globMatches(path: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\0").replaceAll("*", "[^/]*").replaceAll("\0", ".*").replaceAll("?", "[^/]");
  return new RegExp(`^${escaped}$`).test(path) || new RegExp(`(?:^|/)${escaped}$`).test(path);
}
