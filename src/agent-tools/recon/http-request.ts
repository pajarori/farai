import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { backend } from "../shared/backend";
import { evidenceResult } from "../shared/evidence-result";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { timeoutBackgroundResult } from "../shared/background-result";
import { loadConfig, resolveProxyConfig } from "../../agent-core/config";
import { ensureMcpProxyReady, managedProxyForSession } from "../mcp-manager";
import { processOutput } from "../shared/process-output";

export const httpRequestTool: ToolDefinition = {
  name: "http_request",
  description: "Send one exact HTTP request from the managed Kali container and return raw response headers plus body. Requests use Farai's managed capture proxy by default, except HTTP/3 which stays direct; set network=direct to bypass capture in explicit mode. Use this for custom methods, headers, bodies, redirects, exact paths, or protocol tests; use internet_fetch for public-page research and browser tools for interactive state.",
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string" },
      mode: { type: "string", enum: ["protocol_test", "scripted_test"] },
      method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] },
      headers: { type: "object", additionalProperties: { type: "string" } },
      body: { type: "string" },
      followRedirects: { type: "boolean" },
      pathAsIs: { type: "boolean" },
      httpVersion: { type: "string", enum: ["auto", "1.0", "1.1", "2", "3"] },
      network: { type: "string", enum: ["proxy", "direct"] }
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 45_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const kali = backend(context);
    const configWorkspace = context.rootWorkspace ?? context.workspace;
    const proxyConfig = resolveProxyConfig(loadConfig(configWorkspace));
    const requestedNetwork = args.network === "proxy" || args.network === "direct" ? args.network : undefined;
    const network = requestedNetwork ?? (args.httpVersion === "3" || proxyConfig.mode === "off" ? "direct" : "proxy");
    if (args.httpVersion === "3" && network === "proxy") throw new Error("HTTP/3 is unavailable through Farai's HTTP capture proxy; use network=direct");
    if (proxyConfig.mode === "off" && network === "proxy") throw new Error("managed proxy capture is disabled by proxy.mode=off");
    if (proxyConfig.mode === "transparent" && network === "direct") throw new Error("direct routing is unavailable while transparent proxy mode is active");
    let proxyUrl: string | undefined;
    if (network === "proxy") {
      await ensureMcpProxyReady({
        workspace: context.workspace,
        configWorkspace,
        session: context.session,
        ...(context.rootWorkspace ? { rootWorkspace: context.rootWorkspace } : {}),
        ...(context.signal ? { signal: context.signal } : {})
      });
      const proxy = managedProxyForSession(context.session);
      if (!proxy?.running) throw new Error("managed proxy did not become ready");
      if (proxyConfig.mode === "explicit") proxyUrl = `http://127.0.0.1:${proxy.port}`;
    }
    const result = await kali.exec(httpRequestCommand(args, proxyUrl ? { proxyUrl } : {}));
    const converted = timeoutBackgroundResult("http_request", kali, result);
    if (converted) return converted;
    const output = processOutput(result.stdout, result.stderr);
    const evidence = evidenceResult(context, "http response", output, result.exitCode === 0 && !result.timedOut);
    if (upstreamTlsVerificationFailed(output)) {
      return {
        ...evidence,
        ok: false,
        summary: "upstream tls verification failed in managed proxy",
        output: "farai's managed proxy rejected the upstream certificate in strict tls mode. switch the proxy to relaxed tls or add this host to pass-through.\n\n" + (evidence.output ?? "")
      };
    }
    return evidence;
  }
};

export function httpRequestCommand(args: Record<string, unknown>, options: { proxyUrl?: string } = {}): string {
  const url = asString(args.url, "url");
  const command = ["curl", "-sS", "-i", "--max-time", "30"];
  if (options.proxyUrl) command.push("--proxy", options.proxyUrl);
  if (args.followRedirects === true) command.push("-L");
  if (args.pathAsIs === true) command.push("--path-as-is");
  if (args.httpVersion === "1.0") command.push("--http1.0");
  if (args.httpVersion === "1.1") command.push("--http1.1");
  if (args.httpVersion === "2") command.push("--http2");
  if (args.httpVersion === "3") command.push("--http3");
  if (typeof args.method === "string" && args.method !== "GET") command.push("--request", args.method);
  if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
    for (const [name, value] of Object.entries(args.headers as Record<string, unknown>)) {
      if (typeof value !== "string" || /[\r\n]/.test(name) || /[\r\n]/.test(value)) throw new Error("headers must contain single-line string names and values");
      command.push("--header", `${name}: ${value}`);
    }
  }
  if (typeof args.body === "string") command.push("--data-binary", args.body);
  command.push(url);
  return command.map(shellQuote).join(" ");
}

function upstreamTlsVerificationFailed(output: string): boolean {
  const normalized = output.toLowerCase();
  return normalized.includes("x-farai-proxy-error: upstream-tls-verification-failed")
    || normalized.includes("farai proxy: upstream tls verification failed");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
