import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localFaraiDir } from "../global-config";
import { sanitizeToolOutput } from "../../agent-tools/shared/output-sanitize";
import { spotlightUntrusted } from "../context-builder";
import type { HookDefinition, HookEvent, HookPayload } from "./types";

const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
const HOOK_OUTPUT_MAX_BYTES = 8 * 1024;

const HOOK_EVENTS: HookEvent[] = ["session.start", "user.prompt", "tool.pre", "tool.post", "finding.created", "job.completed", "turn.stop"];

export function hookConfigPaths(workspace: string): string[] {
  if (process.env.NODE_ENV === "test") return [join(workspace, ".farai", "hooks.json")];
  return [join(localFaraiDir(), "hooks.json"), join(workspace, ".farai", "hooks.json")];
}

export function loadHooks(workspace: string): HookDefinition[] {
  const hooks: HookDefinition[] = [];
  for (const path of hookConfigPaths(workspace)) {
    if (!existsSync(path)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        const hook = normalizeHook(entry);
        if (hook) hooks.push(hook);
      }
    } catch {
      continue;
    }
  }
  return hooks;
}

function normalizeHook(value: unknown): HookDefinition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.event !== "string" || !HOOK_EVENTS.includes(candidate.event as HookEvent)) return undefined;
  const hasCommand = typeof candidate.command === "string" && candidate.command.trim().length > 0;
  const mcp = candidate.mcp && typeof candidate.mcp === "object" ? candidate.mcp as { server?: unknown; tool?: unknown } : undefined;
  const hasMcp = mcp && typeof mcp.server === "string" && typeof mcp.tool === "string";
  if (!hasCommand && !hasMcp) return undefined;
  return {
    event: candidate.event as HookEvent,
    ...(typeof candidate.matcher === "string" ? { matcher: candidate.matcher } : {}),
    ...(hasCommand ? { command: candidate.command as string } : {}),
    ...(hasMcp ? { mcp: { server: mcp!.server as string, tool: mcp!.tool as string } } : {}),
    ...(typeof candidate.timeoutMs === "number" && candidate.timeoutMs > 0 ? { timeoutMs: candidate.timeoutMs } : {})
  };
}

export function matchesHook(hook: HookDefinition, subject: string | undefined): boolean {
  if (!hook.matcher || hook.matcher === "*") return true;
  if (!subject) return false;
  return globToRegExp(hook.matcher).test(subject);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export type HookRunResult = { additionalContext?: string; error?: string; hookEvent: HookEvent };

export async function runHooks(
  hooks: HookDefinition[],
  event: HookEvent,
  subject: string | undefined,
  payload: HookPayload,
  runner: HookRunner
): Promise<HookRunResult[]> {
  const matching = hooks.filter((hook) => hook.event === event && matchesHook(hook, subject));
  if (matching.length === 0) return [];
  const results: HookRunResult[] = [];
  for (const hook of matching) {
    try {
      const raw = hook.command
        ? await runCommandHook(hook, payload)
        : await runner.mcp(hook, payload);
      const trimmed = raw.trim();
      if (trimmed) results.push({ hookEvent: event, additionalContext: spotlightUntrusted(sanitizeToolOutput(trimmed).slice(0, HOOK_OUTPUT_MAX_BYTES)) });
    } catch (error) {
      results.push({ hookEvent: event, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export type HookRunner = {
  mcp(hook: HookDefinition, payload: HookPayload): Promise<string>;
};

function runCommandHook(hook: HookDefinition, payload: HookPayload): Promise<string> {
  const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", hook.command!], {
      env: { ...process.env, FARAI_HOOK_EVENT: hook.event, FARAI_HOOK_SESSION: payload.sessionId },
      stdio: ["pipe", "pipe", "ignore"]
    });
    let stdout = "";
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {  } finish(() => reject(new Error(`hook timed out after ${timeoutMs}ms`))); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); if (stdout.length > HOOK_OUTPUT_MAX_BYTES * 2) stdout = stdout.slice(0, HOOK_OUTPUT_MAX_BYTES * 2); });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", () => finish(() => resolve(stdout)));
    try { child.stdin.write(JSON.stringify(payload)); child.stdin.end(); } catch {  }
  });
}
