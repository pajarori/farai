import type { ToolContext } from "../../types";
import { backend } from "../shared/backend";
import { CONTAINER_WORKSPACE_MOUNT } from "../../agent-container/kali";

export function containerWorkspace(context: ToolContext): string {
  return backend(context).workspacePath ?? CONTAINER_WORKSPACE_MOUNT;
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
  const workspace = containerWorkspace(context);
  assertNotProtectedPath(path, workspace, "read");
  return runInContainer(context, `cat -- ${shQuote(resolveContainerPath(path, workspace))}`, 10_000, FULL_FILE_MAX_CHARS);
}

export async function containerStatMtime(context: ToolContext, path: string): Promise<number | undefined> {
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
  const workspace = containerWorkspace(context);
  assertNotProtectedPath(path, workspace, "write");
  const p = resolveContainerPath(path, workspace);
  await runInContainer(
    context,
    `mkdir -p -- "$(dirname ${shQuote(p)})" && base64 -d > ${shQuote(p)} << 'FARAI_FS_B64_EOF'\n${base64Heredoc(content)}\nFARAI_FS_B64_EOF`
  );
}

export async function containerListFilesRecursive(context: ToolContext, path: string, limit: number): Promise<string[]> {
  const root = resolveContainerPath(path, containerWorkspace(context));
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
  const root = resolveContainerPath(path, containerWorkspace(context));
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
  const workspace = containerWorkspace(context);
  assertNotProtectedPath(path, workspace, "write");
  await runInContainer(context, `rm -f -- ${shQuote(resolveContainerPath(path, workspace))}`);
}

export async function containerApplySimplePatch(context: ToolContext, patch: string): Promise<string[]> {
  const lines = patch.split(/\r?\n/);
  if (!lines[0]?.startsWith("*** Begin Patch")) throw new Error("patch must start with *** Begin Patch");
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
      const minus: string[] = [];
      const plus: string[] = [];
      while (++i < lines.length && !lines[i]?.startsWith("***")) {
        const next = lines[i] ?? "";
        if (next.startsWith("-")) minus.push(next.slice(1));
        if (next.startsWith("+")) plus.push(next.slice(1));
      }
      i--;
      const oldText = minus.join("\n");
      const newText = plus.join("\n");
      if (!oldText) throw new Error(`update patch for ${rel} has no removal lines`);
      if (!current.includes(oldText)) throw new Error(`update patch did not match ${rel}`);
      current = current.replace(oldText, newText);
      await containerWriteFile(context, rel, current);
      applied.push(`M ${rel}`);
      continue;
    }
    if (line.trim()) throw new Error(`unsupported patch line: ${line}`);
  }
  return applied;
}
