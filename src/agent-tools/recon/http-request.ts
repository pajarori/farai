import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { backend } from "../shared/backend";
import { evidenceResult } from "../shared/evidence-result";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { timeoutBackgroundResult } from "../shared/background-result";

export const httpRequestTool: ToolDefinition = {
  name: "http_request",
  description: "Send one explicit HTTP request from the managed Kali container and return raw response headers plus body. Use this for custom methods, headers, bodies, redirect behavior, exact paths, or HTTP-version tests; use internet_fetch for readable public-page research and browser tools for interactive application state.",
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
      httpVersion: { type: "string", enum: ["auto", "1.0", "1.1", "2", "3"] }
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
    const result = await kali.exec(httpRequestCommand(args));
    const converted = timeoutBackgroundResult("http_request", kali, result);
    if (converted) return converted;
    return evidenceResult(context, "http response", result.stdout, result.exitCode === 0 && !result.timedOut);
  }
};

export function httpRequestCommand(args: Record<string, unknown>): string {
  const url = asString(args.url, "url");
  const command = ["curl", "-sS", "-i", "--max-time", "30"];
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
