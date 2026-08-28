import type { ToolDefinition, ToolResult } from "../../types";
import { callMcpCapabilityTool, isMcpErrorResult, renderMcpToolResult } from "../mcp-manager";
import { browserHumanOutput, browserObservationSignature, browserProtocolWarning } from "./observation";

export { browserHumanOutput, browserObservationSignature } from "./observation";

type BrowserCapabilityCall = typeof callMcpCapabilityTool;

export async function executeBrowserOperation(input: {
  operation: string;
  workspace: string;
  session: Parameters<BrowserCapabilityCall>[0]["session"];
  args: Record<string, unknown>;
  signal?: AbortSignal;
}, call: BrowserCapabilityCall = callMcpCapabilityTool): Promise<ToolResult> {
  const invoke = async (tool: string, args: Record<string, unknown>): Promise<unknown> => await call({
    workspace: input.workspace,
    ...(input.session ? { session: input.session } : {}),
    preferredServer: "playwright",
    tool,
    args,
    ...(input.signal ? { signal: input.signal } : {})
  });
  const result = await invoke(input.operation, input.args);
  let output = renderBrowserResult(result);
  if (isMcpErrorResult(result)) {
    const normalized = normalizeBrowserOutput(output);
    return {
      ok: false,
      summary: `${input.operation} failed`,
      output: normalized,
      metadata: {
        browserBackend: "mcp",
        browserOperation: input.operation,
        observationSignature: browserObservationSignature(input.operation, normalized)
      }
    };
  }

  let snapshotInlined = false;
  let snapshotError: string | undefined;
  if (input.operation === "browser_navigate" && hasInternalBrowserArtifact(output)) {
    output = normalizeBrowserOutput(output);
    try {
      const snapshot = await invoke("browser_snapshot", {});
      const snapshotOutput = normalizeBrowserOutput(renderBrowserResult(snapshot));
      if (isMcpErrorResult(snapshot)) snapshotError = snapshotOutput;
      else {
        output = `${output}\n\n### Inline Snapshot\n${snapshotOutput}`;
        snapshotInlined = true;
      }
    } catch (error) {
      snapshotError = error instanceof Error ? error.message : String(error);
    }
    if (snapshotError) output = `${output}\n\n### Snapshot Status\nStructured snapshot retrieval failed: ${snapshotError}`;
  } else {
    output = normalizeBrowserOutput(output);
  }

  const protocolWarning = browserProtocolWarning(input.operation, input.args, output);
  if (protocolWarning) output = `${output}\n\n### Protocol Verification Required\n${protocolWarning}`;

  return {
    ok: true,
    summary: `${input.operation} completed`,
    output,
    metadata: {
      browserBackend: "mcp",
      browserOperation: input.operation,
      observationSignature: browserObservationSignature(input.operation, output),
      ...(input.operation === "browser_navigate" ? { snapshotInlined } : {}),
      ...(protocolWarning ? { exactProtocolVerificationRequired: true } : {}),
      ...(snapshotError ? { snapshotError } : {})
    }
  };
}

function browserTool(input: {
  name: string;
  operation: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutates: boolean;
}): ToolDefinition {
  return {
    name: input.name,
    description: `${input.description} Uses the session's persistent Playwright-compatible browser backend.`,
    inputSchema: input.inputSchema,
    mutates: input.mutates,
    timeoutMs: 120_000,
    parallel: false,
    concurrencyScope: "session",
    renderHuman: (result) => browserHumanOutput(result.output ?? "") || (result.ok ? "" : result.summary),
    renderModel: (result) => result.output ?? result.summary,
    run: async (args, context): Promise<ToolResult> => {
      try {
        const browserArgs = args && typeof args === "object" && !Array.isArray(args)
          ? args as Record<string, unknown>
          : {};
        const result = await executeBrowserOperation({
          operation: input.operation,
          workspace: context.workspace,
          session: context.session,
          args: browserArgs,
          ...(context.signal ? { signal: context.signal } : {})
        });
        return {
          ...result,
          summary: result.ok ? `${input.name} completed` : `${input.name} failed`
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          summary: `browser backend unavailable: ${message}`,
          output: "Repair or enable a Playwright-compatible browser MCP server, then retry this browser tool. Do not silently fall back to raw HTTP."
        };
      }
    }
  };
}

function renderBrowserResult(result: unknown): string {
  return renderMcpToolResult(result);
}

function hasInternalBrowserArtifact(output: string): boolean {
  return output.includes(".playwright-mcp/") || output.includes("/.farai/mcp-runtime/");
}

function normalizeBrowserOutput(output: string): string {
  return output
    .replace(/- \[Snapshot\]\([^\n)]*\.playwright-mcp\/[^\n)]+\)/gi, "- Snapshot is managed internally by the browser backend.")
    .replace(/(?:\/workspace\/\.farai\/mcp-runtime\/[^\s)\]]+|(?:\.\/)?\.playwright-mcp\/[^\s)\]]+)/g, "[internal browser artifact]");
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false
});

export const browserTools: ToolDefinition[] = [
  browserTool({
    name: "browser_navigate",
    operation: "browser_navigate",
    description: "Navigate the browser to a URL and return the loaded page snapshot. Consume that snapshot directly instead of immediately calling browser_snapshot.",
    inputSchema: objectSchema({ url: { type: "string", description: "URL to open." } }, ["url"]),
    mutates: true
  }),
  browserTool({
    name: "browser_snapshot",
    operation: "browser_snapshot",
    description: "Capture the current page's structured accessibility snapshot when navigation output is missing, truncated, stale, or page state changed after interaction.",
    inputSchema: objectSchema({
      target: { type: "string", description: "Optional exact target reference or unique selector." },
      filename: { type: "string", description: "Optional file to save the snapshot instead of returning it." },
      depth: { type: "integer", minimum: 0, description: "Optional maximum snapshot depth." },
      boxes: { type: "boolean", description: "Include viewport-relative element bounding boxes." }
    }),
    mutates: false
  }),
  browserTool({
    name: "browser_find",
    operation: "browser_find",
    description: "Search the current accessibility snapshot for text or a regular expression.",
    inputSchema: objectSchema({
      text: { type: "string", description: "Case-insensitive text to find." },
      regex: { type: "string", description: "Regular expression to find; use either text or regex." }
    }),
    mutates: false
  }),
  browserTool({
    name: "browser_click",
    operation: "browser_click",
    description: "Click an element identified from a browser snapshot.",
    inputSchema: objectSchema({
      element: { type: "string", description: "Human-readable description of the element." },
      target: { type: "string", description: "Exact snapshot target reference or unique selector." },
      doubleClick: { type: "boolean" },
      button: { type: "string", enum: ["left", "right", "middle"] },
      modifiers: { type: "array", items: { type: "string" } }
    }, ["target"]),
    mutates: true
  }),
  browserTool({
    name: "browser_fill_form",
    operation: "browser_fill_form",
    description: "Fill multiple browser form fields in one operation.",
    inputSchema: objectSchema({
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["textbox", "checkbox", "radio", "combobox", "slider"] },
            ref: { type: "string" },
            value: { type: ["string", "boolean"] }
          },
          required: ["name", "type", "ref", "value"],
          additionalProperties: false
        }
      }
    }, ["fields"]),
    mutates: true
  }),
  browserTool({
    name: "browser_type",
    operation: "browser_type",
    description: "Type text into an editable browser element.",
    inputSchema: objectSchema({
      element: { type: "string", description: "Human-readable description of the element." },
      target: { type: "string", description: "Exact snapshot target reference or unique selector." },
      text: { type: "string" },
      submit: { type: "boolean" },
      slowly: { type: "boolean" }
    }, ["target", "text"]),
    mutates: true
  }),
  browserTool({
    name: "browser_press_key",
    operation: "browser_press_key",
    description: "Press a key in the active browser page.",
    inputSchema: objectSchema({ key: { type: "string", description: "Key name or character, such as Enter or ArrowLeft." } }, ["key"]),
    mutates: true
  }),
  browserTool({
    name: "browser_wait_for",
    operation: "browser_wait_for",
    description: "Wait for browser text to appear, disappear, or for a bounded time.",
    inputSchema: objectSchema({
      time: { type: "number", minimum: 0, description: "Seconds to wait." },
      text: { type: "string", description: "Text to wait for." },
      textGone: { type: "string", description: "Text to wait for disappearance." }
    }),
    mutates: true
  }),
  browserTool({
    name: "browser_tabs",
    operation: "browser_tabs",
    description: "List, create, close, or select persistent browser tabs.",
    inputSchema: objectSchema({
      action: { type: "string", enum: ["list", "new", "close", "select"] },
      index: { type: "integer", minimum: 0 },
      url: { type: "string", description: "Optional URL for a new tab." }
    }, ["action"]),
    mutates: true
  }),
  browserTool({
    name: "browser_network_requests",
    operation: "browser_network_requests",
    description: "List requests observed by the browser since page navigation.",
    inputSchema: objectSchema({
      static: { type: "boolean", description: "Include successful static resources." },
      filter: { type: "string", description: "Optional URL regular expression." },
      filename: { type: "string", description: "Optional output file." }
    }),
    mutates: false
  }),
  browserTool({
    name: "browser_network_request",
    operation: "browser_network_request",
    description: "Read headers and body details for one browser-observed network request.",
    inputSchema: objectSchema({
      index: { type: "integer", minimum: 1, description: "One-based request index from browser_network_requests." },
      part: { type: "string", enum: ["request-headers", "request-body", "response-headers", "response-body"], description: "Optional request part to return." },
      filename: { type: "string", description: "Optional output file." }
    }, ["index"]),
    mutates: false
  })
];
