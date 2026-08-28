import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { backend } from "../shared/backend";
import { backgroundToolResult, timeoutBackgroundResult } from "../shared/background-result";
import { clampYieldMs, sessionManager } from "../shared/session-manager";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { processOutput } from "../shared/process-output";

export const execTool: ToolDefinition = {
  name: "shell_exec",
  description: "execute a command directly inside the managed Kali container; security-task context already contains the exact curated command map, so do not probe with which or command -v first; set background=true or let a slow command exceed yieldMs to continue with session_poll",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string" },
      background: { type: "boolean" },
      yieldMs: { type: "number" }
    }
  },
  mutates: true,
  timeoutMs: 120_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const command = asString(args.command, "command");
    if (args.background === true || shouldAutoBackgroundShellCommand(command)) {
      const yieldMs = args.background === true ? clampYieldMs(args.yieldMs) : clampYieldMs(args.yieldMs ?? 1_000);
      const kind = shouldAutoBackgroundShellCommand(command) ? "shell" : "generic";
      const started = await sessionManager.start(backend(context), "shell_exec", command, yieldMs, context.signal, {
        kind,
        pty: kind === "shell"
      });
      return backgroundToolResult("shell_exec", started, kind);
    }
    const kali = backend(context);
    const result = await kali.exec(command);
    const converted = timeoutBackgroundResult("shell_exec", kali, result);
    if (converted) return converted;
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      summary: `exit=${result.exitCode} duration=${result.durationMs}ms timedOut=${result.timedOut}`,
      output: processOutput(result.stdout, result.stderr)
    };
  }
};

export function shouldAutoBackgroundShellCommand(command: string): boolean {
  const normalized = stripHeredocBodies(command).toLowerCase();
  return [
    /\/dev\/tcp\//,
    /\bbash\s+-i\b/,
    /\bsh\s+-i\b/,
    /\b(?:nc|ncat|netcat|socat)\b.*\s-[a-z]*l[a-z]*\b/,
    /\b(?:python3?|ruby|perl)\b.*pty\.spawn/,
    /\btail\s+-f\b/,
    /\bwhile\s+true\b/,
    /\bsleep\s+([3-9]\d{2,}|\d{4,})\b/
  ].some((pattern) => pattern.test(normalized));
}

export function stripHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  let delimiter: string | null = null;
  let stripLeadingTabs = false;
  for (const line of lines) {
    if (delimiter !== null) {
      const candidate = stripLeadingTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === delimiter) delimiter = null;
      continue;
    }
    const match = line.match(/<<(-)?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
    if (match) {
      stripLeadingTabs = match[1] === "-";
      delimiter = match[3] ?? null;
    }
    out.push(line);
  }
  return out.join("\n");
}
