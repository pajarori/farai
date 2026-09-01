import type { ToolDefinition, ToolResult } from "../../types";
import { assertObject, asString } from "../../utils";
import { callMcpServerTool, isMcpErrorResult, renderMcpToolResult, updateManagedProxyPolicy } from "../mcp-manager";
import { takeBytes } from "../shared/output-bound";
import { proxyFlowDetailFromMcpInspect, proxyFlowsFromMcpTrafficSummary, type ProxyFlowDetail, type ProxyFlowKind, type ProxyFlowSummary } from "../services/mitmproxy/flows";

const SERVER = "mitmproxy-mcp";
const render = (result: ToolResult): string => result.output ?? result.summary;

async function call(context: Parameters<ToolDefinition["run"]>[1], tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await callMcpServerTool({
    workspace: context.workspace,
    ...(context.rootWorkspace ? { configWorkspace: context.rootWorkspace } : {}),
    session: context.session,
    server: SERVER,
    tool,
    args,
    ...(context.signal ? { signal: context.signal } : {})
  });
  if (isMcpErrorResult(result)) throw new Error(`${SERVER}.${tool} failed: ${renderMcpToolResult(result)}`);
  return result;
}

export const proxyScopeTool: ToolDefinition = {
  name: "proxy_scope",
  description: "Read or replace the recording scope of Farai's managed proxy. allowedDomains only controls which flows are saved and displayed; it does not route, bypass, or pass traffic through. An empty list records every domain.",
  inputSchema: { type: "object", properties: { allowedDomains: { type: "array", items: { type: "string" } } }, additionalProperties: false },
  mutates: true,
  timeoutMs: 90_000,
  parallel: false,
  renderHuman: render,
  renderModel: render,
  run: async (args, context) => {
    assertObject(args, "args");
    if (Array.isArray(args.allowedDomains)) {
      const domains = [...new Set(args.allowedDomains.map((item) => asString(item, "allowedDomains[]").trim().toLowerCase()).filter(Boolean))];
      await call(context, "set_scope", { allowed_domains: domains });
    }
    const raw = await call(context, "proxy_scope_get");
    const state = parseTextJson(raw) as { allowedDomains?: unknown } | undefined;
    const domains = Array.isArray(state?.allowedDomains) ? state.allowedDomains.map(String) : [];
    return { ok: true, summary: domains.length ? `proxy scope: ${domains.join(", ")}` : "proxy scope: all traffic", output: domains.length ? domains.join("\n") : "all domains", metadata: { allowedDomains: domains } };
  }
};

export const proxyPolicyTool: ToolDefinition = {
  name: "proxy_policy",
  description: "Read or update the live managed proxy TLS and pass-through policy. tls=strict verifies upstream certificates; tls=relaxed accepts invalid lab certificates. passThroughHosts tunnels matching hosts without HTTP decryption or full flow contents. Routing mode is configured in Farai config and is not changed by this tool.",
  inputSchema: {
    type: "object",
    properties: {
      tls: { type: "string", enum: ["strict", "relaxed"] },
      passThroughHosts: { type: "array", items: { type: "string" } }
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 90_000,
  parallel: false,
  renderHuman: render,
  renderModel: render,
  run: async (args, context) => {
    assertObject(args, "args");
    const tls = args.tls === "strict" || args.tls === "relaxed" ? args.tls : undefined;
    const passThroughHosts = Array.isArray(args.passThroughHosts)
      ? [...new Set(args.passThroughHosts.map((item) => asString(item, "passThroughHosts[]").trim().toLowerCase()).filter(Boolean))]
      : undefined;
    if (tls || passThroughHosts) {
      await call(context, "proxy_policy_set", {
        ...(tls ? { tls_mode: tls } : {}),
        ...(passThroughHosts ? { pass_through_hosts: passThroughHosts } : {})
      });
    }
    const raw = await call(context, "proxy_policy_get");
    const policy = parseTextJson(raw) as { tls?: unknown; passThroughHosts?: unknown } | undefined;
    const resolvedTls = policy?.tls === "strict" ? "strict" : "relaxed";
    const resolvedHosts = Array.isArray(policy?.passThroughHosts) ? policy.passThroughHosts.map(String) : [];
    updateManagedProxyPolicy(context.session, { tls: resolvedTls, passThroughHosts: resolvedHosts });
    const output = [`tls: ${resolvedTls}`, `pass-through: ${resolvedHosts.length ? resolvedHosts.join(", ") : "none"}`].join("\n");
    return { ok: true, summary: `proxy policy: tls ${resolvedTls} · ${resolvedHosts.length} pass-through hosts`, output, metadata: { tls: resolvedTls, passThroughHosts: resolvedHosts } };
  }
};

export const proxyFlowsTool: ToolDefinition = {
  name: "proxy_flows",
  description: "List bounded summaries of HTTP, WebSocket, TCP, UDP, or DNS flows captured by Farai's managed mitmproxy, with optional kind, text, method, and status-class filters. Use the returned flow ids with proxy_flow_get, proxy_replay, or proxy_intercept.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", minimum: 1, maximum: 1000 },
      kind: { type: "string", enum: ["http", "websocket", "tcp", "udp", "dns"] },
      filter: { type: "string" },
      method: { type: "string" },
      statusClass: { type: "number", minimum: 1, maximum: 5 }
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 90_000,
  parallel: true,
  renderHuman: render,
  renderModel: render,
  run: async (args, context) => {
    assertObject(args, "args");
    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(1000, Math.floor(args.limit))) : 100;
    const kind = typeof args.kind === "string" ? args.kind as ProxyFlowKind : undefined;
    const raw = await call(context, "proxy_flow_summaries", { limit, ...(kind ? { kind } : {}) });
    const flows = proxyFlowsFromMcpTrafficSummary(raw, {
      limit,
      ...(kind ? { kind } : {}),
      ...(typeof args.filter === "string" ? { filter: args.filter } : {}),
      ...(typeof args.method === "string" ? { method: args.method } : {}),
      ...(typeof args.statusClass === "number" ? { statusClass: Math.floor(args.statusClass) } : {})
    });
    return { ok: true, summary: `${flows.length} captured proxy flows`, output: flows.length ? flows.map(flowLine).join("\n") : "no matching flows", metadata: proxyFlowCollectionMetadata(flows) };
  }
};

export const proxyFlowGetTool: ToolDefinition = {
  name: "proxy_flow_get",
  description: "Inspect one captured proxy flow by exact flowId, including HTTP request and response data, WebSocket or raw stream messages, or DNS questions and answers. Use proxy_flows to discover ids and browser_network_request for browser-only request records not captured by the proxy.",
  inputSchema: { type: "object", required: ["flowId"], properties: { flowId: { type: "string" } }, additionalProperties: false },
  mutates: false,
  timeoutMs: 90_000,
  parallel: true,
  renderHuman: render,
  renderModel: render,
  run: async (args, context) => {
    assertObject(args, "args");
    const flowId = asString(args.flowId, "flowId");
    const raw = await call(context, "proxy_flow_inspect", { flow_id: flowId });
    const flow = proxyFlowDetailFromMcpInspect(raw);
    if (!flow) throw new Error(`captured proxy flow not found: ${flowId}`);
    return { ok: true, summary: flowLine(flow), output: formatFlowDetail(flow), metadata: proxyFlowMetadata(flow) };
  }
};

export const proxySitemapTool: ToolDefinition = {
  name: "proxy_sitemap",
  description: "Build a compact sitemap from captured HTTP and WebSocket traffic, grouped by host and path with observed methods and status codes. Use this to map routes from existing proxy traffic; it does not crawl the target or generate new requests.",
  inputSchema: { type: "object", properties: { limit: { type: "number", minimum: 1, maximum: 1000 }, host: { type: "string" } }, additionalProperties: false },
  mutates: false,
  timeoutMs: 90_000,
  parallel: true,
  renderHuman: render,
  renderModel: render,
  run: async (args, context) => {
    assertObject(args, "args");
    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(1000, Math.floor(args.limit))) : 1000;
    const raw = await call(context, "proxy_flow_summaries", { limit });
    const hostFilter = typeof args.host === "string" ? args.host.toLowerCase() : undefined;
    const flows = proxyFlowsFromMcpTrafficSummary(raw, { limit }).filter((flow) => (flow.kind === "http" || flow.kind === "websocket") && (!hostFilter || flow.host.toLowerCase().includes(hostFilter)));
    const hosts = new Map<string, Map<string, Set<string>>>();
    for (const flow of flows) {
      const paths = hosts.get(flow.host) ?? new Map<string, Set<string>>();
      const statuses = paths.get(flow.path) ?? new Set<string>();
      statuses.add(`${flow.method}${flow.status ? ` ${flow.status}` : ""}`);
      paths.set(flow.path, statuses);
      hosts.set(flow.host, paths);
    }
    const lines = [...hosts.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([host, paths]) => [host, ...[...paths.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, methods]) => `  ${path} · ${[...methods].sort().join(", ")}`)]);
    return { ok: true, summary: `${hosts.size} hosts and ${flows.length} captured web flows`, output: lines.length ? lines.join("\n") : "no captured web routes", metadata: { hosts: hosts.size, flows: flows.length } };
  }
};

export const proxyReplayTool: ToolDefinition = {
  name: "proxy_replay",
  description: "Replay one captured HTTP request through the managed proxy, optionally replacing its method, headers, or body. The replay is linked to the original as a descendant flow for differential testing; use http_request when no captured parent request is needed.",
  inputSchema: {
    type: "object",
    required: ["flowId"],
    properties: {
      flowId: { type: "string" },
      method: { type: "string" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      body: { type: "string" },
      omitBody: { type: "boolean" },
      timeoutSeconds: { type: "number", minimum: 1, maximum: 120 }
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 150_000,
  parallel: false,
  renderHuman: render,
  renderModel: render,
  run: async (args, context) => {
    assertObject(args, "args");
    const flowId = asString(args.flowId, "flowId");
    const headers = args.headers && typeof args.headers === "object" && !Array.isArray(args.headers) ? args.headers as Record<string, unknown> : undefined;
    const normalizedHeaders = headers ? Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, asString(value, `headers.${key}`)])) : undefined;
    const mutations = {
      ...(typeof args.method === "string" ? { method: args.method } : {}),
      ...(normalizedHeaders ? { headers: normalizedHeaders } : {}),
      ...(args.omitBody === true ? { body: "omitted" } : typeof args.body === "string" ? { body: "replaced" } : {})
    };
    const raw = await call(context, "proxy_replay_correlated", {
      flow_id: flowId,
      ...(typeof args.method === "string" ? { method: args.method } : {}),
      ...(normalizedHeaders ? { headers_json: JSON.stringify(normalizedHeaders) } : {}),
      ...(args.omitBody === true ? { body: "__omit__" } : typeof args.body === "string" ? { body: args.body } : {}),
      ...(typeof args.timeoutSeconds === "number" ? { timeout: args.timeoutSeconds } : {})
    });
    const result = parseTextJson(raw) as { ok?: unknown; parentFlowId?: unknown; descendantFlowId?: unknown; message?: unknown; error?: unknown } | undefined;
    if (!result || typeof result.ok !== "boolean") throw new Error(`invalid correlated replay response: ${renderMcpToolResult(raw)}`);
    const descendantFlowId = typeof result.descendantFlowId === "string" ? result.descendantFlowId : undefined;
    const output = typeof result.message === "string" ? result.message : typeof result.error === "string" ? result.error : renderMcpToolResult(raw);
    return {
      ok: result.ok,
      summary: descendantFlowId ? `replayed ${flowId} as ${descendantFlowId}` : `replay ${result.ok ? "completed" : "failed"} for ${flowId}`,
      output,
      metadata: { parentFlowId: flowId, ...(descendantFlowId ? { descendantFlowId } : {}), mutations }
    };
  }
};

export const proxyInterceptTool: ToolDefinition = {
  name: "proxy_intercept",
  description: "Control manual request interception in Farai's managed proxy: inspect status, configure host/path/method rules, list paused requests, or forward, edit, and drop one paused flow. Configure interception before generating traffic; resolve paused requests by exact flowId.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["status", "configure", "list", "forward", "edit", "drop"] },
      enabled: { type: "boolean" },
      hostPattern: { type: "string" },
      pathPattern: { type: "string" },
      methods: { type: "array", items: { type: "string" } },
      flowId: { type: "string" },
      method: { type: "string" },
      url: { type: "string" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      body: { type: "string" }
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 90_000,
  parallel: false,
  renderHuman: render,
  renderModel: render,
  run: async (args, context) => {
    assertObject(args, "args");
    const action = asString(args.action, "action");
    if (!["status", "configure", "list", "forward", "edit", "drop"].includes(action)) throw new Error(`unsupported proxy interception action: ${action}`);
    validateInterceptArguments(action, args);
    if (action === "configure" || action === "status") {
      const raw = action === "status"
        ? await call(context, "proxy_intercept_get")
        : await call(context, "proxy_intercept_configure", {
        enabled: args.enabled,
        ...(typeof args.hostPattern === "string" ? { host_pattern: args.hostPattern } : {}),
        ...(typeof args.pathPattern === "string" ? { path_pattern: args.pathPattern } : {}),
        ...(Array.isArray(args.methods) ? { methods: args.methods.map((item) => asString(item, "methods[]")) } : {})
      });
      const output = renderMcpToolResult(raw);
      return { ok: true, summary: action === "status" ? "checked manual interception" : `manual interception ${args.enabled === true ? "enabled" : "disabled"}`, output };
    }
    if (action === "list") {
      const raw = await call(context, "proxy_intercept_list");
      const flows = proxyFlowsFromMcpTrafficSummary(raw, { limit: 100 });
      return { ok: true, summary: `${flows.length} paused requests`, output: flows.length ? flows.map(flowLine).join("\n") : "no paused requests", metadata: proxyFlowCollectionMetadata(flows) };
    }
    const flowId = asString(args.flowId, "flowId");
    const headers = args.headers && typeof args.headers === "object" && !Array.isArray(args.headers) ? args.headers as Record<string, unknown> : undefined;
    const normalizedHeaders = headers ? Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, asString(value, `headers.${key}`)])) : undefined;
    const raw = await call(context, "proxy_intercept_resolve", {
      flow_id: flowId,
      action,
      ...(typeof args.method === "string" ? { method: args.method } : {}),
      ...(typeof args.url === "string" ? { url: args.url } : {}),
      ...(normalizedHeaders ? { headers_json: JSON.stringify(normalizedHeaders) } : {}),
      ...(typeof args.body === "string" ? { body: args.body } : {})
    });
    const output = renderMcpToolResult(raw);
    return { ok: true, summary: `${action} intercepted request ${flowId}`, output };
  }
};

export const proxyClearTool: ToolDefinition = {
  name: "proxy_clear",
  description: "Delete all currently captured proxy flows after confirm=true while preserving proxy scope and interception configuration. Use this to start a clean capture window; the removed traffic cannot be inspected afterward.",
  inputSchema: { type: "object", required: ["confirm"], properties: { confirm: { type: "boolean" } }, additionalProperties: false },
  mutates: true,
  timeoutMs: 90_000,
  parallel: false,
  renderHuman: render,
  renderModel: render,
  run: async (args, context) => {
    assertObject(args, "args");
    if (args.confirm !== true) throw new Error("proxy_clear requires confirm=true");
    const raw = await call(context, "clear_traffic");
    return { ok: true, summary: "cleared captured proxy traffic", output: renderMcpToolResult(raw) };
  }
};

function flowLine(flow: ProxyFlowSummary): string {
  const status = flow.status ? ` ${flow.status}` : "";
  const size = [flow.requestBytes, flow.responseBytes].some((value) => typeof value === "number") ? ` · ${flow.requestBytes ?? 0}/${flow.responseBytes ?? 0} bytes` : "";
  return `${flow.id} · ${flow.kind.toUpperCase()} · ${flow.method}${status} ${flow.url}${size}${flow.error ? ` · ${flow.error}` : ""}`;
}

function formatFlowDetail(flow: ProxyFlowDetail): string {
  const lines = [flowLine(flow)];
  if (flow.kind === "http") {
    lines.push("", "request headers:", ...flow.request.headers.map((header) => `${header.name}: ${header.value}`));
    if (flow.request.bodyText) lines.push("", "request body:", flow.request.bodyText);
    if (flow.response) {
      lines.push("", `response${flow.response.status ? ` ${flow.response.status}` : ""}:`, ...flow.response.headers.map((header) => `${header.name}: ${header.value}`));
      if (flow.response.bodyText) lines.push("", flow.response.bodyText);
    }
  } else if (flow.kind === "websocket") {
    lines.push("", `${flow.messages.length} websocket messages`, ...flow.messages.map((message, index) => `${index + 1}. ${message.direction} · ${message.contentBytes} bytes · ${message.contentText ?? (message.contentBase64 ? "base64" : "")}`));
  } else if (flow.kind === "tcp" || flow.kind === "udp") {
    lines.push("", `${flow.messages.length} stream messages`, ...flow.messages.map((message, index) => `${index + 1}. ${message.direction} · ${message.contentBytes} bytes · ${message.contentText ?? (message.contentBase64 ? "base64" : "")}`));
  } else {
    lines.push("", ...flow.request.questions.map((question) => `query: ${question.name} ${question.type ?? ""}`));
    if (flow.response) lines.push(...flow.response.answers.map((answer) => `answer: ${answer.name} ${answer.type ?? ""} ${answer.data ?? ""}`));
  }
  return takeBytes(lines.join("\n"), 128 * 1024, "head");
}

function validateInterceptArguments(action: string, args: Record<string, unknown>): void {
  const configureFields = ["enabled", "hostPattern", "pathPattern", "methods"];
  const editFields = ["method", "url", "headers", "body"];
  if (action === "configure" && typeof args.enabled !== "boolean") throw new Error("proxy_intercept configure requires enabled");
  if (["forward", "edit", "drop"].includes(action) && typeof args.flowId !== "string") throw new Error(`proxy_intercept ${action} requires flowId`);
  if (action !== "configure" && configureFields.some((field) => args[field] !== undefined)) {
    throw new Error(`${configureFields.filter((field) => args[field] !== undefined).join(", ")} only apply to configure`);
  }
  if (action !== "edit" && editFields.some((field) => args[field] !== undefined)) {
    throw new Error(`${editFields.filter((field) => args[field] !== undefined).join(", ")} only apply to edit`);
  }
  if (!["forward", "edit", "drop"].includes(action) && args.flowId !== undefined) throw new Error("flowId only applies to forward, edit, or drop");
}

function proxyFlowCollectionMetadata(flows: ProxyFlowSummary[]): Record<string, unknown> {
  const kinds: Record<string, number> = {};
  for (const flow of flows) kinds[flow.kind] = (kinds[flow.kind] ?? 0) + 1;
  return { count: flows.length, kinds };
}

function proxyFlowMetadata(flow: ProxyFlowSummary): Record<string, unknown> {
  return {
    flowId: takeBytes(flow.id, 256, "head"),
    kind: flow.kind,
    method: takeBytes(flow.method, 64, "head"),
    host: takeBytes(flow.host, 1_000, "head"),
    path: takeBytes(flow.path, 4_000, "head"),
    ...(flow.status !== undefined ? { status: flow.status } : {})
  };
}

function parseTextJson(raw: unknown): unknown {
  const text = renderMcpToolResult(raw);
  try { return JSON.parse(text); } catch { return undefined; }
}

export const proxyTools: ToolDefinition[] = [proxyScopeTool, proxyPolicyTool, proxyFlowsTool, proxyFlowGetTool, proxySitemapTool, proxyReplayTool, proxyInterceptTool, proxyClearTool];
