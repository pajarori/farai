import type { ToolDefinition, ToolResult } from "../../types";
import { callMcpCapabilityTool, isMcpErrorResult, renderMcpToolResult } from "../mcp-manager";
import { browserContextManager, type BrowserContextActivity } from "./context-manager";
import { browserHumanOutput, browserObservationSignature, browserProtocolWarning } from "./observation";

export { browserHumanOutput, browserObservationSignature } from "./observation";

type BrowserCapabilityCall = typeof callMcpCapabilityTool;

export async function executeBrowserOperation(input: {
  operation: string;
  workspace: string;
  configWorkspace?: string;
  session: Parameters<BrowserCapabilityCall>[0]["session"];
  args: Record<string, unknown>;
  signal?: AbortSignal;
}, call?: BrowserCapabilityCall): Promise<ToolResult> {
  const browserArgs = { ...input.args };
  const browserSelector = typeof browserArgs.browser === "string" ? browserArgs.browser : undefined;
  delete browserArgs.browser;
  if (call || !input.session) {
    const capabilityCall = call ?? callMcpCapabilityTool;
    const invoke = async (tool: string, args: Record<string, unknown>): Promise<unknown> => await capabilityCall({
      workspace: input.workspace,
      ...(input.configWorkspace ? { configWorkspace: input.configWorkspace } : {}),
      ...(input.session ? { session: input.session } : {}),
      preferredServer: "playwright",
      tool,
      args,
      ...(input.signal ? { signal: input.signal } : {})
    });
    return await performBrowserOperation(input.operation, browserArgs, invoke);
  }
  const routed = await browserContextManager.runOperation({
    workspace: input.workspace,
    ...(input.configWorkspace ? { configWorkspace: input.configWorkspace } : {}),
    session: input.session,
    ...(browserSelector !== undefined ? { browser: browserSelector } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  }, async (invoke, context) => await performBrowserOperation(input.operation, browserArgs, invoke, context));
  return routed.value;
}

async function performBrowserOperation(
  operation: string,
  args: Record<string, unknown>,
  invoke: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  context?: BrowserContextActivity
): Promise<ToolResult> {
  const result = await invoke(operation, args);
  let output = renderBrowserResult(result);
  if (isMcpErrorResult(result)) {
    const normalized = normalizeBrowserOutput(output);
    return {
      ok: false,
      summary: `${operation} failed`,
      output: normalized,
      metadata: {
        browserBackend: "mcp",
        browserOperation: operation,
        ...(context ? { browserContextId: context.id, browserContextName: context.name } : {}),
        observationSignature: browserObservationSignature(operation, normalized, context?.id)
      }
    };
  }

  let snapshotInlined = false;
  let snapshotError: string | undefined;
  if (operation === "browser_navigate" && hasInternalBrowserArtifact(output)) {
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

  const protocolWarning = browserProtocolWarning(operation, args, output);
  if (protocolWarning) output = `${output}\n\n### Protocol Verification Required\n${protocolWarning}`;

  return {
    ok: true,
    summary: `${operation} completed`,
    output,
    metadata: {
      browserBackend: "mcp",
      browserOperation: operation,
      ...(context ? { browserContextId: context.id, browserContextName: context.name } : {}),
      observationSignature: browserObservationSignature(operation, output, context?.id),
      ...(operation === "browser_navigate" ? { snapshotInlined } : {}),
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
    description: `${input.description} Optionally target a named browser context.`,
    inputSchema: withBrowserSelector(input.inputSchema),
    mutates: input.mutates,
    timeoutMs: 120_000,
    parallel: true,
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
          ...(context.rootWorkspace ? { configWorkspace: context.rootWorkspace } : {}),
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

function withBrowserSelector(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {};
  return {
    ...schema,
    properties: {
      browser: { type: "string", description: "Context name or UUID." },
      ...properties
    }
  };
}

const browserContextTool: ToolDefinition = {
  name: "browser_context",
  description: "Create, list, or close isolated browser contexts with independent cookies, storage, tabs, and navigation state. Create multiple named contexts for separate users or sessions, then pass the context name or id through the browser field of every other browser tool.",
  inputSchema: objectSchema({
    action: { type: "string", enum: ["create", "list", "close"] },
    name: { type: "string", description: "Unique context name." },
    browser: { type: "string", description: "Context name or UUID." }
  }, ["action"]),
  mutates: true,
  timeoutMs: 120_000,
  parallel: true,
  concurrencyScope: "session",
  renderHuman: browserContextHumanOutput,
  renderModel: (result) => result.output ?? result.summary,
  run: async (args, context): Promise<ToolResult> => {
    const input = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
    const action = String(input.action ?? "");
    try {
      if (action === "list") {
        const contexts = browserContextManager.list(context.session);
        return {
          ok: true,
          summary: `listed ${contexts.length} browser context${contexts.length === 1 ? "" : "s"}`,
          output: contexts.length > 0 ? contexts.map((item) => formatBrowserContext(item)).join("\n") : "No browser contexts are active.",
          metadata: { browserContextAction: "list", browserContexts: contexts }
        };
      }
      if (action === "create") {
        if (typeof input.name !== "string") throw new Error("browser_context create requires name");
        const created = await browserContextManager.create({
          workspace: context.workspace,
          ...(context.rootWorkspace ? { configWorkspace: context.rootWorkspace } : {}),
          session: context.session,
          name: input.name,
          ...(context.signal ? { signal: context.signal } : {})
        });
        return {
          ok: true,
          summary: `browser ${created.name} ready`,
          output: formatBrowserContext(created),
          metadata: { browserContextAction: "create", browserContext: created, browserContextId: created.id, browserContextName: created.name }
        };
      }
      if (action === "close") {
        if (typeof input.browser !== "string") throw new Error("browser_context close requires browser");
        const closed = await browserContextManager.close({
          session: context.session,
          browser: input.browser,
          ...(context.signal ? { signal: context.signal } : {})
        });
        return {
          ok: true,
          summary: `browser ${closed.name} closed`,
          output: `Closed browser ${closed.name} (${closed.id}).`,
          metadata: { browserContextAction: "close", browserContext: closed, browserContextId: closed.id, browserContextName: closed.name }
        };
      }
      throw new Error(`Unsupported browser_context action: ${action || "(missing)"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, summary: `browser_context ${action || "operation"} failed`, output: message };
    }
  }
};

function browserContextHumanOutput(result: ToolResult): string {
  if (!result.ok) return result.output ?? result.summary;
  const action = result.metadata?.browserContextAction;
  if (action === "list") {
    const contexts = Array.isArray(result.metadata?.browserContexts)
      ? result.metadata.browserContexts as BrowserContextActivity[]
      : [];
    if (contexts.length === 0) return "No browsers active.";
    return contexts.map((context) => formatBrowserContext(context)).join("\n");
  }
  const context = result.metadata?.browserContext;
  if (context && typeof context === "object" && !Array.isArray(context)) {
    const activity = context as BrowserContextActivity;
    return formatBrowserContext(activity, action === "close" ? "closed" : undefined);
  }
  return result.summary;
}

function formatBrowserContext(context: BrowserContextActivity, status: string = context.status): string {
  return `${context.name} · ${status} · ${context.id}`;
}

export const browserTools: ToolDefinition[] = [
  browserContextTool,
  browserTool({
    name: "browser_navigate",
    operation: "browser_navigate",
    description: "Navigate one browser context to a URL, wait for the page to load, and return its structured accessibility snapshot. Use the returned snapshot for immediate interaction instead of calling browser_snapshot again unless page state later changes.",
    inputSchema: objectSchema({ url: { type: "string", description: "URL to open." } }, ["url"]),
    mutates: true
  }),
  browserTool({
    name: "browser_snapshot",
    operation: "browser_snapshot",
    description: "Capture the current page's structured accessibility tree and target references without navigating. Use this after dynamic page changes or when the last snapshot is missing, stale, or truncated; optionally bound depth, include element boxes, or save the snapshot to a file.",
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
    description: "Search the current browser accessibility snapshot by case-insensitive text or regular expression and return matching target references. Use this to locate elements in a large snapshot before browser_click or browser_type; it does not perform an internet search.",
    inputSchema: objectSchema({
      text: { type: "string", description: "Case-insensitive text to find." },
      regex: { type: "string", description: "Regular expression to find; use either text or regex." }
    }),
    mutates: false
  }),
  browserTool({
    name: "browser_click",
    operation: "browser_click",
    description: "Click an element using the exact target reference or unique selector from a current browser snapshot, with optional mouse button, modifiers, or double-click. Refresh the snapshot first if the reference may be stale.",
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
    description: "Fill several browser form controls in one atomic operation using names, control types, snapshot refs, and values. Prefer this for complete forms; use browser_type for one editable field or when keystroke behavior matters.",
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
    description: "Enter text into one editable element identified by a current snapshot target, optionally typing slowly or submitting afterward. Use browser_fill_form for multiple fields and browser_press_key for standalone keyboard actions.",
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
    description: "Send one keyboard key or character, such as Enter, Escape, Tab, or ArrowLeft, to the active page in a browser context. Use this for keyboard-driven interactions after focusing the appropriate element.",
    inputSchema: objectSchema({ key: { type: "string", description: "Key name or character, such as Enter or ArrowLeft." } }, ["key"]),
    mutates: true
  }),
  browserTool({
    name: "browser_wait_for",
    operation: "browser_wait_for",
    description: "Wait in a browser context until specified text appears, specified text disappears, or a bounded number of seconds elapses. Use this for asynchronous UI state rather than repeatedly taking snapshots or inserting shell sleeps.",
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
    description: "List, create, close, or select persistent tabs within one browser context. Tab indexes are context-local; use separate browser_context instances when cookies or storage must also be isolated.",
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
    description: "List network requests observed by one browser context since navigation, with optional URL filtering, static-resource inclusion, or file output. Use this to discover application requests and then inspect one entry with browser_network_request.",
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
    description: "Read request headers, request body, response headers, or response body for one one-based entry returned by browser_network_requests. Use proxy_flow_get instead when investigating traffic captured outside the browser or requiring proxy correlation.",
    inputSchema: objectSchema({
      index: { type: "integer", minimum: 1, description: "One-based request index from browser_network_requests." },
      part: { type: "string", enum: ["request-headers", "request-body", "response-headers", "response-body"], description: "Optional request part to return." },
      filename: { type: "string", description: "Optional output file." }
    }, ["index"]),
    mutates: false
  })
];
