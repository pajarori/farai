import type { ToolContext, ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { backend } from "../shared/backend";
import { sessionManager, clampYieldMs } from "../shared/session-manager";
import { backgroundToolResult } from "../shared/background-result";
import { outputTokenLimit, processOutput } from "../shared/process-output";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { loadConfig, resolveProxyConfig } from "../../agent-core/config";
import { ensureMcpProxyReady, managedProxyForSession } from "../mcp-manager";
import { proxiedShellCommand, upstreamTlsVerificationFailed } from "./exec";

export const execCommandTool: ToolDefinition = {
  name: "command_run_legacy", description: "Execute a shell command in the managed workspace with bounded output; use command_input with the returned processId for long-running sessions.",
  inputSchema: { type: "object", required: ["cmd"], properties: { cmd: { type: "string" }, workdir: { type: "string" }, yield_time_ms: { type: "number" }, tty: { type: "boolean" }, max_output_tokens: { type: "number" }, network: { type: "string", enum: ["direct", "proxy"] } } },
  mutates: true, timeoutMs: Number.POSITIVE_INFINITY, parallel: false, renderHuman: defaultHumanRenderer, renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args"); const cmd = asString(args.cmd, "cmd");
    const yieldMs = clampYieldMs(args.yield_time_ms);
    const maxOutputTokens = outputTokenLimit(args.max_output_tokens);
    const requestedNetwork = args.network === "proxy" || args.network === "direct" ? args.network : undefined;
    const routed = await routeCommand(cmd, requestedNetwork, context);
    const command = commandInWorkdir(routed, args.workdir);
    const result = await sessionManager.start(backend(context), "command_run", command, yieldMs, context.signal, { kind: "shell", pty: args.tty === true });
    if (result.session.status === "running") return backgroundToolResult("command_run", result, "shell", maxOutputTokens);
    const output = processOutput(result.output, "", maxOutputTokens);
    if (requestedNetwork === "proxy" && upstreamTlsVerificationFailed(output)) {
      return {
        ok: false,
        summary: "upstream tls verification failed in managed proxy",
        output: "farai's managed proxy rejected the upstream certificate in strict tls mode. switch the proxy to relaxed tls or add this host to pass-through.\n\n" + output,
        processId: result.sessionId
      };
    }
    return {
      ok: result.session.exitCode === 0,
      summary: `exit=${result.session.exitCode ?? 0}`,
      output,
      processId: result.sessionId
    };
  }
};

async function routeCommand(command: string, requestedNetwork: "direct" | "proxy" | undefined, context: ToolContext): Promise<string> {
  const configWorkspace = context.rootWorkspace ?? context.workspace;
  const proxyConfig = resolveProxyConfig(loadConfig(configWorkspace));
  if (proxyConfig.mode === "off" && requestedNetwork === "proxy") throw new Error("managed proxy capture is disabled by proxy.mode=off");
  if (proxyConfig.mode === "transparent" && requestedNetwork === "direct") throw new Error("direct routing is unavailable while transparent proxy mode is active");
  if (proxyConfig.mode !== "transparent" && requestedNetwork !== "proxy") return command;
  await ensureMcpProxyReady({
    workspace: context.workspace,
    configWorkspace,
    session: context.session,
    ...(context.rootWorkspace ? { rootWorkspace: context.rootWorkspace } : {}),
    ...(context.signal ? { signal: context.signal } : {})
  });
  const proxy = managedProxyForSession(context.session);
  if (!proxy?.running) throw new Error("managed proxy did not become ready");
  return proxyConfig.mode === "explicit" ? proxiedShellCommand(command, `http://127.0.0.1:${proxy.port}`) : command;
}

export function commandInWorkdir(command: string, workdir: unknown): string {
  if (workdir === undefined) return command;
  const directory = asString(workdir, "workdir");
  return `cd -- ${shellQuote(directory)} && ${command}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
