import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ClipboardResult =
  | { ok: true; method: string }
  | { ok: false; error: string };

export function writeClipboard(text: string): ClipboardResult {
  if (!text) return { ok: false, error: "clipboard text is empty" };
  for (const command of clipboardCommands()) {
    const result = runClipboardCommand(command, text);
    if (result.ok) return result;
  }
  return { ok: false, error: "no clipboard command succeeded" };
}

export function clipboardCommands(platform = process.platform): string[][] {
  if (platform === "darwin") return [["pbcopy"], ["osascript"]];
  if (platform === "win32") return [["clip"]];
  return [
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"]
  ];
}

function runClipboardCommand(command: string[], text: string): ClipboardResult {
  const [bin, ...args] = command;
  if (!bin) return { ok: false, error: "empty clipboard command" };
  if (bin === "osascript") return writeClipboardWithAppleScript(text);
  const result = spawnSync(bin, args, { input: Buffer.from(text), stdio: ["pipe", "ignore", "pipe"] });
  if (result.status === 0) return { ok: true, method: bin };
  const detail = result.error?.message || result.stderr?.toString().trim() || `exit ${result.status ?? "unknown"}`;
  return { ok: false, error: `${bin}: ${detail}` };
}

function writeClipboardWithAppleScript(text: string): ClipboardResult {
  const dir = mkdtempSync(join(tmpdir(), "farai-clipboard-"));
  const path = join(dir, "clipboard.txt");
  try {
    writeFileSync(path, text);
    const script = `set the clipboard to (do shell script "cat " & quoted form of ${JSON.stringify(path)})`;
    const result = spawnSync("osascript", ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    if (result.status === 0) return { ok: true, method: "osascript" };
    const detail = result.error?.message || result.stderr?.toString().trim() || `exit ${result.status ?? "unknown"}`;
    return { ok: false, error: `osascript: ${detail}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
