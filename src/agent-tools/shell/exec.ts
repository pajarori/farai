import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { backend } from "../shared/backend";
import { backgroundToolResult, timeoutBackgroundResult } from "../shared/background-result";
import { clampYieldMs, sessionManager } from "../shared/session-manager";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { processOutput } from "../shared/process-output";
import { loadConfig, resolveProxyConfig } from "../../agent-core/config";
import { ensureMcpProxyReady, managedProxyForSession } from "../mcp-manager";

export const execTool: ToolDefinition = {
  name: "shell_exec",
  description: "Run an exact shell command inside the managed Kali container and return stdout, stderr, and exit status. Shell traffic stays direct in explicit proxy mode; set network=proxy for proxy-aware HTTP clients when their traffic should be captured. Use this for workflows not covered by a purpose-built tool; use background=true for interactive or long-running work, then continue with session_poll.",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string" },
      background: { type: "boolean" },
      yieldMs: { type: "number" },
      network: { type: "string", enum: ["direct", "proxy"] }
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
    const configWorkspace = context.rootWorkspace ?? context.workspace;
    const proxyConfig = resolveProxyConfig(loadConfig(configWorkspace));
    const requestedNetwork = args.network === "proxy" || args.network === "direct" ? args.network : undefined;
    if (proxyConfig.mode === "off" && requestedNetwork === "proxy") throw new Error("managed proxy capture is disabled by proxy.mode=off");
    if (proxyConfig.mode === "transparent" && requestedNetwork === "direct") throw new Error("direct routing is unavailable while transparent proxy mode is active");
    let routedCommand = command;
    if (proxyConfig.mode === "transparent" || requestedNetwork === "proxy") {
      await ensureMcpProxyReady({
        workspace: context.workspace,
        configWorkspace,
        session: context.session,
        ...(context.rootWorkspace ? { rootWorkspace: context.rootWorkspace } : {}),
        ...(context.signal ? { signal: context.signal } : {})
      });
      const proxy = managedProxyForSession(context.session);
      if (!proxy?.running) throw new Error("managed proxy did not become ready");
      if (proxyConfig.mode === "explicit" && requestedNetwork === "proxy") {
        routedCommand = proxiedShellCommand(command, `http://127.0.0.1:${proxy.port}`);
      }
    }
    if (args.background === true || shouldAutoBackgroundShellCommand(command)) {
      const yieldMs = args.background === true ? clampYieldMs(args.yieldMs) : clampYieldMs(args.yieldMs ?? 1_000);
      const kind = shouldAutoBackgroundShellCommand(command) ? "shell" : "generic";
      const started = await sessionManager.start(backend(context), "shell_exec", routedCommand, yieldMs, context.signal, {
        kind,
        pty: kind === "shell"
      });
      return backgroundToolResult("shell_exec", started, kind);
    }
    const kali = backend(context);
    const result = await kali.exec(routedCommand);
    const converted = timeoutBackgroundResult("shell_exec", kali, result);
    if (converted) return converted;
    const output = processOutput(result.stdout, result.stderr);
    if (requestedNetwork === "proxy" && upstreamTlsVerificationFailed(output)) {
      return {
        ok: false,
        summary: "upstream tls verification failed in managed proxy",
        output: "farai's managed proxy rejected the upstream certificate in strict tls mode. switch the proxy to relaxed tls or add this host to pass-through.\n\n" + output
      };
    }
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      summary: `exit=${result.exitCode} duration=${result.durationMs}ms timedOut=${result.timedOut}`,
      output
    };
  }
};

export function proxiedShellCommand(command: string, proxyUrl: string): string {
  const quoted = shellQuote(proxyUrl);
  return `export http_proxy=${quoted} https_proxy=${quoted}; unset HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy; ${command}`;
}

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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function upstreamTlsVerificationFailed(output: string): boolean {
  const normalized = output.toLowerCase();
  return normalized.includes("x-farai-proxy-error: upstream-tls-verification-failed")
    || normalized.includes("farai proxy: upstream tls verification failed");
}
