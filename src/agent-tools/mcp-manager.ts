import type { Session, ToolContext, ToolDefinition, ToolResult } from "../types";
import { containerNameForSession, KaliContainerBackend } from "../agent-container/kali";
import { DEFAULT_MITMPROXY_PORT, McpStdioClient, loadExternalMcpConfig, mcpServersFromConfig, type ExternalMcpServer, type McpResourceDescriptor, type McpResourceTemplateDescriptor, type McpToolDescriptor } from "./mcp-adapter";
import { configPath, loadConfig, resolveProxyConfig } from "../agent-core/config";
import { defaultHumanRenderer, defaultModelRenderer } from "./shared/renderers";
import { TOOL_NAME_MAX_LENGTH } from "../tool-names";

export type McpRefreshInput = {
  workspace: string;
  configWorkspace?: string;
  session?: Session;
  signal?: AbortSignal;
  portOffset?: number;
  background?: boolean;
  force?: boolean;
  includeResources?: boolean;
  onStartupEvent?: (event: McpStartupEvent) => void;
};

export type McpStartupStatus =
  | { state: "starting" }
  | { state: "ready" }
  | { state: "failed"; error: string }
  | { state: "cancelled" };

export type McpStartupEvent =
  | { type: "mcp_startup_update"; server: string; status: McpStartupStatus }
  | { type: "mcp_startup_complete"; ready: string[]; failed: Array<{ server: string; error: string }>; cancelled: string[] };

export type McpServerRuntimeStatus = {
  name: string;
  enabled: boolean;
  running: boolean;
  startupState?: "idle" | "starting" | "ready" | "failed" | "cancelled";
  runInContainer: boolean;
  command: string;
  toolCount: number;
  tools: string[];
  authStatus: "unsupported" | "not_logged_in" | "bearer_token" | "oauth";
  resources: Array<{ name: string; title?: string; uri: string }>;
  resourceTemplates: Array<{ name: string; title?: string; uriTemplate: string }>;
  proxy?: {
    running: boolean;
    port: number;
  };
  error?: string;
};

export type McpToolCallMetadata = {
  kind: "mcp_tool_call";
  server: string;
  tool: string;
  result: unknown;
  durationMs: number;
};

type ManagedMcpServer = {
  config: ExternalMcpServer;
  client: McpStdioClient;
  toolNames: Set<string>;
  resources: McpResourceDescriptor[];
  resourceTemplates: McpResourceTemplateDescriptor[];
  resourcesLoaded: boolean;
  proxyStarted: boolean;
  proxyStartTask?: Promise<void>;
};

type McpRefreshPlan = {
  scope: string;
  signature: string;
  resolvedConfigs: ExternalMcpServer[];
  configs: ExternalMcpServer[];
  active: Set<string>;
};

type ServerRefreshOutcome =
  | { status: "ready"; server: string }
  | { status: "failed"; server: string; error: string; required: boolean }
  | { status: "cancelled"; server: string };

type McpRefreshEntry = {
  sessionId: string;
  scope: string;
  epoch: number;
  task: Promise<ToolDefinition[]>;
};

export class McpServerManager {
  private readonly servers = new Map<string, ManagedMcpServer>();
  private readonly toolsByScope = new Map<string, Map<string, ToolDefinition>>();
  private readonly originalsByScope = new Map<string, Map<string, { server: string; tool: string }>>();
  private readonly statusesByScope = new Map<string, Map<string, McpServerRuntimeStatus>>();
  private readonly backgroundRefreshes = new Map<string, McpRefreshEntry>();
  private readonly completedRefreshes = new Map<string, string>();
  private readonly failedRefreshes = new Map<string, { sessionId: string; attempts: number; nextRetryAt: number }>();
  private readonly lastConfigPathByScope = new Map<string, string>();
  private readonly refreshEpochs = new Map<string, number>();
  private nextRefreshEpoch = 0;

  constructor(private readonly options: { reservedServers?: readonly string[]; reserveServer?: (config: ExternalMcpServer) => boolean } = {}) {}

  listTools(session?: Session | string): ToolDefinition[] {
    return [...(this.toolsByScope.get(mcpScope(session))?.values() ?? [])];
  }

  getTool(name: string, session?: Session | string): ToolDefinition | undefined {
    return this.toolsByScope.get(mcpScope(session))?.get(name);
  }

  listStatuses(session?: Session | string): McpServerRuntimeStatus[] {
    const scope = mcpScope(session);
    return [...(this.statusesByScope.get(scope)?.values() ?? [])].map((status) => {
      if (!status.running) return status;
      const managed = this.servers.get(scopedServerKey(scope, status.name));
      if (managed?.client.isRunning()) return status;
      return {
        ...status,
        running: false,
        startupState: "failed",
        error: managed?.client.lastError() ?? "MCP process is not running"
      };
    });
  }

  async stopAll(): Promise<void> {
    const scopes = new Set([
      ...this.toolsByScope.keys(),
      ...this.originalsByScope.keys(),
      ...this.statusesByScope.keys(),
      ...[...this.backgroundRefreshes.values()].map((entry) => entry.scope)
    ]);
    for (const scope of scopes) this.invalidateRefresh(scope);
    this.backgroundRefreshes.clear();
    const servers = [...this.servers.values()];
    this.servers.clear();
    this.toolsByScope.clear();
    this.originalsByScope.clear();
    this.statusesByScope.clear();
    this.lastConfigPathByScope.clear();
    this.completedRefreshes.clear();
    this.failedRefreshes.clear();
    await Promise.allSettled(servers.map((server) => server.client.stop()));
  }

  async stopSession(sessionId: string): Promise<void> {
    this.invalidateRefresh(sessionId);
    for (const [signature, entry] of this.backgroundRefreshes) {
      if (entry.sessionId === sessionId) this.backgroundRefreshes.delete(signature);
    }
    const prefix = `${sessionId}:`;
    const servers: ManagedMcpServer[] = [];
    for (const [key, server] of this.servers) {
      if (!key.startsWith(prefix)) continue;
      this.servers.delete(key);
      servers.push(server);
    }
    for (const [signature, owner] of this.completedRefreshes) {
      if (owner === sessionId) this.completedRefreshes.delete(signature);
    }
    for (const [signature, failure] of this.failedRefreshes) {
      if (failure.sessionId === sessionId) this.failedRefreshes.delete(signature);
    }
    this.toolsByScope.delete(sessionId);
    this.originalsByScope.delete(sessionId);
    this.statusesByScope.delete(sessionId);
    this.lastConfigPathByScope.delete(sessionId);
    await Promise.allSettled(servers.map((server) => server.client.stop()));
  }

  hasServer(name: string, session?: Session): boolean {
    return this.servers.has(scopedServerKey(session, name));
  }

  async ensureProxyReady(input: McpRefreshInput, expectedPort?: number): Promise<void> {
    await this.refresh({ ...input, background: false, includeResources: false });
    const scope = mcpScope(input.session);
    const managed = [...this.servers.entries()]
      .filter(([key]) => key.startsWith(`${scope}:`))
      .map(([, server]) => server)
      .find((server) => server.config.mitmproxy?.autoStartProxy
        && (expectedPort === undefined || server.config.mitmproxy.port === expectedPort));
    if (!managed) {
      const port = expectedPort === undefined ? "" : ` on port ${expectedPort}`;
      throw new Error(`No enabled managed mitmproxy server is configured${port}`);
    }
    await this.ensureInitialized(managed);
    if (!managed.toolNames.has("start_proxy")) {
      throw new Error(`MCP server ${managed.config.name} does not provide start_proxy`);
    }
    await this.autostartServer(input, managed);
    this.updateProxyStatus(input, scope, managed.config.name, managed);
  }

  async refresh(input: McpRefreshInput): Promise<ToolDefinition[]> {
    const plan = this.prepareRefreshPlan(input);
    this.applyStatusPlaceholders(plan);

    if (!input.force && this.completedRefreshes.has(plan.signature)) {
      if (this.refreshPlanHealthy(input, plan)) return this.listTools(plan.scope);
      this.completedRefreshes.delete(plan.signature);
    }

    const running = this.backgroundRefreshes.get(plan.signature);
    if (running) {
      return input.background ? this.listTools(plan.scope) : await running.task;
    }

    const failure = this.failedRefreshes.get(plan.signature);
    if (!input.force && failure && Date.now() < failure.nextRetryAt) return this.listTools(plan.scope);

    const epoch = this.beginRefresh(plan.scope);
    const entry: McpRefreshEntry = {
      sessionId: input.session?.id ?? "host",
      scope: plan.scope,
      epoch,
      task: Promise.resolve([])
    };
    const task = this.runRefreshPlan(input, plan, epoch)
      .catch((error) => {
        if (!this.isRefreshCurrent(plan.scope, epoch)) return [];
        input.onStartupEvent?.({
          type: "mcp_startup_complete",
          ready: [],
          failed: [{ server: "mcp", error: error instanceof Error ? error.message : String(error) }],
          cancelled: []
        });
        return this.listTools(plan.scope);
      })
      .finally(() => {
        if (this.backgroundRefreshes.get(plan.signature) === entry) {
          this.backgroundRefreshes.delete(plan.signature);
        }
      });
    entry.task = task;
    this.backgroundRefreshes.set(plan.signature, entry);
    if (input.background) return this.listTools(plan.scope);
    return await task;
  }

  private prepareRefreshPlan(input: McpRefreshInput): McpRefreshPlan {
    const scope = mcpScope(input.session);
    const configWorkspace = input.configWorkspace ?? input.workspace;
    this.lastConfigPathByScope.set(scope, [configPath("global"), configPath("project", configWorkspace)].join(", "));
    const allConfigs = mcpServersFromConfig(loadConfig(configWorkspace).mcpServers ?? {});
    const effectivePort = resolveMcpPort(allConfigs, input.portOffset ?? 0);
    const reserved = new Set(this.options.reservedServers ?? []);
    const resolvedConfigs = allConfigs
      .filter((config) => !reserved.has(config.name) && !this.options.reserveServer?.(config))
      .map((config) => applyMcpPortTemplate(config, effectivePort));
    const configs = resolvedConfigs.filter((server) => server.enabled);
    const active = new Set(configs.map((server) => scopedServerKey(input.session, server.name)));
    return {
      scope,
      signature: refreshSignature(input, resolvedConfigs),
      resolvedConfigs,
      configs,
      active
    };
  }

  private applyStatusPlaceholders(plan: McpRefreshPlan): void {
    const statuses = this.statusMap(plan.scope);
    const next = new Map<string, McpServerRuntimeStatus>();
    for (const config of plan.resolvedConfigs) {
      const existing = statuses.get(config.name);
      next.set(config.name, {
        name: config.name,
        enabled: config.enabled,
        running: existing?.running ?? false,
        startupState: existing?.startupState ?? (config.enabled ? "idle" : "idle"),
        runInContainer: config.runInContainer,
        command: [config.command, ...config.args].join(" "),
        toolCount: existing?.toolCount ?? 0,
        tools: existing?.tools ?? [],
        authStatus: existing?.authStatus ?? "unsupported",
        resources: existing?.resources ?? [],
        resourceTemplates: existing?.resourceTemplates ?? [],
        ...(existing?.proxy ? { proxy: existing.proxy } : {}),
        ...(existing?.error ? { error: existing.error } : {})
      });
    }
    statuses.clear();
    for (const [name, status] of next) statuses.set(name, status);
  }

  private async runRefreshPlan(input: McpRefreshInput, plan: McpRefreshPlan, epoch = this.refreshEpochs.get(plan.scope) ?? this.beginRefresh(plan.scope)): Promise<ToolDefinition[]> {
    if (!this.isRefreshCurrent(plan.scope, epoch)) return [];
    const statuses = this.statusMap(plan.scope);
    statuses.clear();
    for (const config of plan.resolvedConfigs) {
      statuses.set(config.name, {
        name: config.name,
        enabled: config.enabled,
        running: false,
        startupState: config.enabled ? "starting" : "idle",
        runInContainer: config.runInContainer,
        command: [config.command, ...config.args].join(" "),
        toolCount: 0,
        tools: [],
        authStatus: "unsupported",
        resources: [],
        resourceTemplates: []
      });
    }
    const scopePrefix = `${input.session?.id ?? "host"}:`;
    for (const [key, server] of this.servers) {
      if (key.startsWith(scopePrefix) && !plan.active.has(key)) {
        await server.client.stop().catch(() => {});
        if (!this.isRefreshCurrent(plan.scope, epoch)) return [];
        if (this.servers.get(key) === server) this.servers.delete(key);
        this.removeToolsForServer(plan.scope, server.config.name);
      }
    }

    const outcomes = await runWithConcurrency(plan.configs, resolveMcpStartupConcurrency(), async (config) => {
      if (!this.isRefreshCurrent(plan.scope, epoch)) return { status: "cancelled", server: config.name } as const;
      return await this.refreshOneServer(input, plan.scope, config, epoch);
    });
    if (!this.isRefreshCurrent(plan.scope, epoch)) return [];
    const ready = outcomes.filter((outcome): outcome is Extract<ServerRefreshOutcome, { status: "ready" }> => outcome.status === "ready").map((outcome) => outcome.server);
    const failed = outcomes
      .filter((outcome): outcome is Extract<ServerRefreshOutcome, { status: "failed" }> => outcome.status === "failed")
      .map((outcome) => ({ server: outcome.server, error: outcome.error }));
    const cancelled = outcomes
      .filter((outcome): outcome is Extract<ServerRefreshOutcome, { status: "cancelled" }> => outcome.status === "cancelled")
      .map((outcome) => outcome.server);
    ready.sort();
    failed.sort((a, b) => a.server.localeCompare(b.server));
    cancelled.sort();
    input.onStartupEvent?.({ type: "mcp_startup_complete", ready, failed, cancelled });
    const requiredFailure = outcomes.find((outcome): outcome is Extract<ServerRefreshOutcome, { status: "failed" }> => outcome.status === "failed" && outcome.required);
    const owner = input.session?.id ?? "host";
    if (failed.length > 0) {
      this.completedRefreshes.delete(plan.signature);
      const previous = this.failedRefreshes.get(plan.signature);
      const attempts = (previous?.attempts ?? 0) + 1;
      const retryDelayMs = Math.min(60_000, 2_000 * 2 ** Math.min(5, attempts - 1));
      this.failedRefreshes.set(plan.signature, { sessionId: owner, attempts, nextRetryAt: Date.now() + retryDelayMs });
    } else {
      this.failedRefreshes.delete(plan.signature);
      for (const [signature, sessionId] of this.completedRefreshes) {
        if (sessionId === owner) this.completedRefreshes.delete(signature);
      }
      this.completedRefreshes.set(plan.signature, owner);
    }
    if (requiredFailure) throw new Error(requiredFailure.error);
    return this.listTools(plan.scope);
  }

  private async refreshOneServer(input: McpRefreshInput, scope: string, config: ExternalMcpServer, epoch: number): Promise<ServerRefreshOutcome> {
    if (!this.isRefreshCurrent(scope, epoch)) return { status: "cancelled", server: config.name };
    const statuses = this.statusMap(scope);
    const tools = this.toolMap(scope);
    const originals = this.originalMap(scope);
    try {
      input.onStartupEvent?.({ type: "mcp_startup_update", server: config.name, status: { state: "starting" } });
      this.markServerStarting(scope, config);
      const prepared = await this.prepareConfig(input, config);
      if (!this.isRefreshCurrent(scope, epoch)) return { status: "cancelled", server: config.name };
      const key = scopedServerKey(input.session, config.name);
      let managed = this.servers.get(key);
      if (!managed || !managed.client.isRunning() || !sameProcessConfig(managed.config, prepared)) {
        await managed?.client.stop().catch(() => {});
        if (!this.isRefreshCurrent(scope, epoch)) return { status: "cancelled", server: config.name };
        managed = {
          config: prepared,
          client: new McpStdioClient(prepared),
          toolNames: new Set(),
          resources: [],
          resourceTemplates: [],
          resourcesLoaded: false,
          proxyStarted: false
        };
        this.servers.set(key, managed);
      }
      await this.ensureInitialized(managed);
      if (!this.isRefreshCurrent(scope, epoch) || this.servers.get(key) !== managed) return { status: "cancelled", server: config.name };
      const descriptors = await managed.client.listTools();
      if (!this.isRefreshCurrent(scope, epoch) || this.servers.get(key) !== managed) return { status: "cancelled", server: config.name };
      const toolNames: string[] = [];
      managed.toolNames = new Set(descriptors.map((descriptor) => descriptor.name));
      this.removeToolsForServer(scope, config.name);
      for (const descriptor of descriptors.filter((descriptor) => isToolEnabled(config, descriptor.name))) {
        const toolName = mcpToolName(descriptor.server, descriptor.name);
        const existing = originals.get(toolName);
        if (existing && (existing.server !== descriptor.server || existing.tool !== descriptor.name)) {
          throw new Error(`MCP tool name collision: ${existing.server}/${existing.tool} and ${descriptor.server}/${descriptor.name} both map to ${toolName}`);
        }
        toolNames.push(toolName);
        tools.set(toolName, this.toToolDefinition(toolName, descriptor));
        originals.set(toolName, { server: descriptor.server, tool: descriptor.name });
      }
      const existing = statuses.get(config.name);
      statuses.set(config.name, {
        name: config.name,
        enabled: true,
        running: true,
        startupState: "ready",
        runInContainer: config.runInContainer,
        command: [config.command, ...config.args].join(" "),
        toolCount: toolNames.length,
        tools: toolNames,
        authStatus: existing?.authStatus ?? "unsupported",
        resources: existing?.resources ?? [],
        resourceTemplates: existing?.resourceTemplates ?? [],
        ...(prepared.mitmproxy ? {
          proxy: this.proxyStatus(input, managed)
        } : {})
      });
      input.onStartupEvent?.({ type: "mcp_startup_update", server: config.name, status: { state: "ready" } });
      this.autostartServerInBackground(input, scope, config.name, managed);
      if (input.includeResources !== false) {
        await this.refreshServerResources(scope, config.name, managed, input.signal);
      } else {
        void this.refreshServerResources(scope, config.name, managed).catch(() => {});
      }
      return { status: "ready", server: config.name };
    } catch (error) {
      if (!this.isRefreshCurrent(scope, epoch)) return { status: "cancelled", server: config.name };
      const message = error instanceof Error ? error.message : String(error);
      this.removeToolsForServer(scope, config.name);
      statuses.set(config.name, {
        name: config.name,
        enabled: true,
        running: false,
        startupState: "failed",
        runInContainer: config.runInContainer,
        command: [config.command, ...config.args].join(" "),
        toolCount: 0,
        tools: [],
        authStatus: "unsupported",
        resources: [],
        resourceTemplates: [],
        error: message
      });
      input.onStartupEvent?.({ type: "mcp_startup_update", server: config.name, status: { state: "failed", error: message } });
      return { status: "failed", server: config.name, error: message, required: config.required };
    }
  }

  private async refreshServerResources(scope: string, serverName: string, managed: ManagedMcpServer, signal?: AbortSignal): Promise<void> {
    const [resourceDiscovery, resourceTemplates] = await Promise.all([
      discoverResources(managed.client, signal),
      discoverResourceTemplates(managed.client)
    ]);
    managed.resources = resourceDiscovery.resources;
    managed.resourceTemplates = resourceTemplates;
    managed.resourcesLoaded = resourceDiscovery.loaded;
    if (this.servers.get(scopedServerKey(scope, serverName)) !== managed) return;
    const statuses = this.statusMap(scope);
    const existing = statuses.get(serverName);
    if (!existing || !existing.running) return;
    statuses.set(serverName, {
      ...existing,
      resources: resourceDiscovery.resources.map(toStatusResource),
      resourceTemplates: resourceTemplates.map(toStatusResourceTemplate)
    });
  }

  private removeToolsForServer(scope: string, serverName: string): void {
    const tools = this.toolsByScope.get(scope);
    const originals = this.originalsByScope.get(scope);
    if (!tools || !originals) return;
    for (const [toolName, original] of originals) {
      if (original.server !== serverName) continue;
      originals.delete(toolName);
      tools.delete(toolName);
    }
  }

  private markServerStarting(scope: string, config: ExternalMcpServer): void {
    const statuses = this.statusMap(scope);
    const existing = statuses.get(config.name);
    statuses.set(config.name, {
      name: config.name,
      enabled: true,
      running: false,
      startupState: "starting",
      runInContainer: config.runInContainer,
      command: [config.command, ...config.args].join(" "),
      toolCount: existing?.toolCount ?? 0,
      tools: existing?.tools ?? [],
      authStatus: existing?.authStatus ?? "unsupported",
      resources: existing?.resources ?? [],
      resourceTemplates: existing?.resourceTemplates ?? [],
      ...(existing?.proxy ? { proxy: existing.proxy } : {})
    });
  }

  async call(dynamicToolName: string, args: unknown, context: ToolContext): Promise<ToolResult> {
    const scope = mcpScope(context.session);
    const original = this.originalsByScope.get(scope)?.get(dynamicToolName);
    const lastConfigPath = this.lastConfigPathByScope.get(scope);
    if (!original) throw new Error(`Unknown MCP tool: ${dynamicToolName}${lastConfigPath ? ` (config ${lastConfigPath})` : ""}`);
    const managed = this.servers.get(scopedServerKey(context.session, original.server));
    if (!managed) throw new Error(`MCP server is not running: ${original.server}`);
    await this.ensureInitialized(managed);
    const toolArgs = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
    const started = Date.now();
    const result = await managed.client.callTool(original.tool, toolArgs, context.signal);
    const durationMs = Date.now() - started;
    const output = renderMcpToolResult(result);
    return {
      ok: !isMcpErrorResult(result),
      summary: `${dynamicToolName} completed`,
      output,
      metadata: {
        server: original.server,
        tool: original.tool,
        mcp: {
          kind: "mcp_tool_call",
          server: original.server,
          tool: original.tool,
          result,
          durationMs
        } satisfies McpToolCallMetadata
      }
    };
  }

  async callServerTool(input: McpRefreshInput & { server: string; tool: string; args?: Record<string, unknown> }): Promise<unknown> {
    await waitForMcpSignal(this.refresh({
      workspace: input.workspace,
      ...(input.configWorkspace ? { configWorkspace: input.configWorkspace } : {}),
      ...(input.session ? { session: input.session } : {}),
      ...(input.portOffset !== undefined ? { portOffset: input.portOffset } : {}),
      includeResources: false
    }), input.signal);
    const managed = this.servers.get(scopedServerKey(input.session, input.server));
    if (!managed) throw new Error(`MCP server is not running: ${input.server}`);
    await this.ensureInitialized(managed);
    if (!managed.toolNames.has(input.tool)) throw new Error(`MCP tool is not available: ${input.server}.${input.tool}`);
    return await managed.client.callTool(input.tool, input.args ?? {}, input.signal);
  }

  async listResources(input: McpRefreshInput): Promise<Array<McpResourceDescriptor & { server: string }>> {
    await waitForMcpSignal(this.refresh({ ...input, includeResources: true, background: false }), input.signal);
    const scopePrefix = `${mcpScope(input.session)}:`;
    const resources: Array<McpResourceDescriptor & { server: string }> = [];
    for (const [key, managed] of this.servers) {
      if (!key.startsWith(scopePrefix)) continue;
      await this.ensureInitialized(managed);
      if (!managed.resourcesLoaded) {
        managed.resources = await managed.client.listResources(input.signal);
        managed.resourcesLoaded = true;
      }
      for (const resource of managed.resources) resources.push({ ...resource, server: managed.config.name });
    }
    return resources.sort((left, right) => left.server.localeCompare(right.server) || left.uri.localeCompare(right.uri));
  }

  async readResource(input: McpRefreshInput & { server: string; uri: string }): Promise<unknown> {
    await waitForMcpSignal(this.refresh({ ...input, includeResources: false, background: false }), input.signal);
    const managed = this.servers.get(scopedServerKey(input.session, input.server));
    if (!managed) throw new Error(`MCP server is not running: ${input.server}`);
    await this.ensureInitialized(managed);
    return await managed.client.readResource(input.uri, input.signal);
  }

  async callCapabilityTool(input: McpRefreshInput & { preferredServer?: string; tool: string; args?: Record<string, unknown> }): Promise<unknown> {
    await waitForMcpSignal(this.refresh({
      workspace: input.workspace,
      ...(input.configWorkspace ? { configWorkspace: input.configWorkspace } : {}),
      ...(input.session ? { session: input.session } : {}),
      ...(input.portOffset !== undefined ? { portOffset: input.portOffset } : {}),
      includeResources: false
    }), input.signal);
    const scopePrefix = `${input.session?.id ?? "host"}:`;
    const candidates = [...this.servers.entries()]
      .filter(([key, managed]) => key.startsWith(scopePrefix) && managed.toolNames.has(input.tool))
      .map(([, managed]) => managed)
      .sort((left, right) => {
        const preferred = input.preferredServer;
        return Number(right.config.name === preferred) - Number(left.config.name === preferred)
          || left.config.name.localeCompare(right.config.name);
      });
    const managed = candidates[0];
    if (!managed) {
      const failures = this.listStatuses(input.session)
        .filter((status) => status.enabled && !status.running && status.error)
        .map((status) => `${status.name}: ${status.error}`);
      throw new Error(`No enabled MCP browser backend provides ${input.tool}${failures.length ? `. Startup failures: ${failures.join("; ")}` : ""}`);
    }
    await this.ensureInitialized(managed);
    return await managed.client.callTool(input.tool, input.args ?? {}, input.signal);
  }

  private async prepareConfig(input: McpRefreshInput, config: ExternalMcpServer): Promise<ExternalMcpServer> {
    return await prepareMcpServerProcess(input, config);
  }

  private async ensureInitialized(server: ManagedMcpServer): Promise<void> {
    await server.client.initialize();
  }

  private refreshPlanHealthy(input: McpRefreshInput, plan: McpRefreshPlan): boolean {
    return plan.configs.every((config) => this.servers.get(scopedServerKey(input.session, config.name))?.client.isRunning());
  }

  private autostartServerInBackground(input: McpRefreshInput, scope: string, serverName: string, server: ManagedMcpServer): void {
    if (!server.config.mitmproxy?.autoStartProxy) return;
    void this.autostartServer(input, server)
      .then(() => this.updateProxyStatus(input, scope, serverName, server))
      .catch((error) => {
        if (this.servers.get(scopedServerKey(scope, serverName)) !== server) return;
        const statuses = this.statusMap(scope);
        const existing = statuses.get(serverName);
        if (!existing || !existing.running) return;
        const message = error instanceof Error ? error.message : String(error);
        statuses.set(serverName, {
          ...existing,
          proxy: this.proxyStatus(input, server),
          error: `MCP proxy auto-start failed: ${message}`
        });
      });
  }

  private updateProxyStatus(input: McpRefreshInput, scope: string, serverName: string, server: ManagedMcpServer): void {
    if (this.servers.get(scopedServerKey(scope, serverName)) !== server) return;
    const statuses = this.statusMap(scope);
    const existing = statuses.get(serverName);
    if (!existing || !existing.running || !server.config.mitmproxy) return;
    const { error: _error, ...rest } = existing;
    statuses.set(serverName, {
      ...rest,
      proxy: this.proxyStatus(input, server)
    });
  }

  private proxyStatus(input: McpRefreshInput, server: ManagedMcpServer): NonNullable<McpServerRuntimeStatus["proxy"]> {
    void input;
    return {
      running: server.proxyStarted,
      port: server.config.mitmproxy?.port ?? 0
    };
  }

  private async autostartServer(input: McpRefreshInput, server: ManagedMcpServer): Promise<void> {
    const mitmproxy = server.config.mitmproxy;
    if (!mitmproxy?.autoStartProxy) return;
    if (!server.toolNames.has("start_proxy")) return;
    if (server.proxyStartTask) return await server.proxyStartTask;
    const task = (async () => {
      if (!server.proxyStarted) {
        const args: Record<string, unknown> = { port: mitmproxy.port };
        if (mitmproxy.dumpFile) args.dump_file = mitmproxy.dumpFile;
        if (mitmproxy.upstreamProxy) args.upstream_proxy = mitmproxy.upstreamProxy;
        await server.client.callTool("start_proxy", args);
        server.proxyStarted = true;
      }
      await this.enableTransparentProxy(input, server, mitmproxy.port);
    })();
    server.proxyStartTask = task;
    try {
      await task;
    } catch (error) {
      if (server.proxyStartTask === task) delete server.proxyStartTask;
      throw error;
    }
  }

  private async enableTransparentProxy(input: McpRefreshInput, server: ManagedMcpServer, proxyPort: number): Promise<void> {
    if (!server.config.runInContainer || !input.session) return;
    const proxy = resolveProxyConfig(loadConfig(input.configWorkspace ?? input.workspace));
    if (!proxy.transparent) return;
    const backend = new KaliContainerBackend({ workspace: input.workspace, containerName: containerNameForSession(input.session.id) });
    const result = await backend.enableTransparentProxy({ proxyPort, redirectPorts: proxy.ports });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "could not enable transparent proxy capture in the container");
    }
  }

  private toToolDefinition(name: string, descriptor: McpToolDescriptor): ToolDefinition {
    return {
      name,
      description: descriptor.description ?? `External MCP tool ${descriptor.server}.${descriptor.name}`,
      inputSchema: descriptor.inputSchema ?? { type: "object", additionalProperties: true },
      mutates: descriptor.mutates,
      timeoutMs: 120_000,
      parallel: false,
      renderHuman: defaultHumanRenderer,
      renderModel: defaultModelRenderer,
      run: async (args, context) => await this.call(name, args, context)
    };
  }

  private toolMap(scope: string): Map<string, ToolDefinition> {
    let tools = this.toolsByScope.get(scope);
    if (!tools) {
      tools = new Map();
      this.toolsByScope.set(scope, tools);
    }
    return tools;
  }

  private originalMap(scope: string): Map<string, { server: string; tool: string }> {
    let originals = this.originalsByScope.get(scope);
    if (!originals) {
      originals = new Map();
      this.originalsByScope.set(scope, originals);
    }
    return originals;
  }

  private statusMap(scope: string): Map<string, McpServerRuntimeStatus> {
    let statuses = this.statusesByScope.get(scope);
    if (!statuses) {
      statuses = new Map();
      this.statusesByScope.set(scope, statuses);
    }
    return statuses;
  }

  private beginRefresh(scope: string): number {
    const epoch = ++this.nextRefreshEpoch;
    this.refreshEpochs.set(scope, epoch);
    return epoch;
  }

  private invalidateRefresh(scope: string): void {
    this.refreshEpochs.set(scope, ++this.nextRefreshEpoch);
  }

  private isRefreshCurrent(scope: string, epoch: number): boolean {
    return this.refreshEpochs.get(scope) === epoch;
  }
}

async function discoverResources(client: McpStdioClient, signal?: AbortSignal): Promise<{ resources: McpResourceDescriptor[]; loaded: boolean }> {
  try {
    return { resources: await client.listResources(signal), loaded: true };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { resources: [], loaded: false };
  }
}

async function discoverResourceTemplates(client: McpStdioClient): Promise<McpResourceTemplateDescriptor[]> {
  try {
    return await client.listResourceTemplates();
  } catch {
    return [];
  }
}

function toStatusResource(resource: McpResourceDescriptor): McpServerRuntimeStatus["resources"][number] {
  return {
    name: resource.name,
    ...(resource.title ? { title: resource.title } : {}),
    uri: resource.uri
  };
}

function toStatusResourceTemplate(template: McpResourceTemplateDescriptor): McpServerRuntimeStatus["resourceTemplates"][number] {
  return {
    name: template.name,
    ...(template.title ? { title: template.title } : {}),
    uriTemplate: template.uriTemplate
  };
}

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (;;) {
      const current = index;
      index += 1;
      const item = items[current];
      if (item === undefined) return;
      results[current] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function resolveMcpStartupConcurrency(): number {
  const raw = process.env.FARAI_MCP_STARTUP_CONCURRENCY;
  const value = raw ? Number(raw) : 3;
  return Number.isFinite(value) ? Math.max(1, Math.min(8, Math.floor(value))) : 3;
}

async function waitForMcpSignal<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await task;
  if (signal.aborted) throw mcpSignalError(signal);
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(mcpSignalError(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    task.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function mcpSignalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(signal.reason === undefined ? "MCP operation cancelled" : String(signal.reason));
}

function refreshSignature(input: McpRefreshInput, configs: ExternalMcpServer[]): string {
  return JSON.stringify({
    sessionId: input.session?.id ?? "host",
    workspace: input.workspace,
    configWorkspace: input.configWorkspace ?? input.workspace,
    portOffset: input.portOffset ?? 0,
    configs: configs.map((config) => ({
      name: config.name,
      enabled: config.enabled,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
      runInContainer: config.runInContainer,
      required: config.required,
      startupTimeoutMs: config.startupTimeoutMs,
      toolTimeoutMs: config.toolTimeoutMs,
      autoStart: config.autoStart,
      enabledTools: config.enabledTools,
      disabledTools: config.disabledTools,
      mitmproxy: config.mitmproxy
    }))
  });
}

export async function loadMergedMcpConfigs(paths: string[]): Promise<ExternalMcpServer[]> {
  const byName = new Map<string, ExternalMcpServer>();
  for (const path of paths) {
    const servers = await loadExternalMcpConfig(path);
    for (const server of servers) byName.set(server.name, server);
  }
  return [...byName.values()];
}

export function resolveMcpPort(configs: ExternalMcpServer[], portOffset = 0): number {
  const configured = configs.find((config) => config.mitmproxy)?.mitmproxy?.port;
  const base = Number.isInteger(configured) ? configured! : DEFAULT_MITMPROXY_PORT;
  const offset = Number.isFinite(portOffset) ? Math.trunc(portOffset) : 0;
  const port = base + offset;
  if (port < 1 || port > 65_535) throw new Error(`resolved MCP proxy port is outside 1-65535: ${port}`);
  return port;
}

export function applyMcpPortTemplate(config: ExternalMcpServer, port: number): ExternalMcpServer {
  const replacePort = (value: string): string => value
    .replaceAll("${PORT}", String(port))
    .replaceAll("${PROXY_PORT}", String(port))
    .replaceAll("{PORT}", String(port))
    .replaceAll("{PROXY_PORT}", String(port));
  return {
    ...config,
    command: replacePort(config.command),
    args: config.args.map(replacePort),
    ...(config.cwd ? { cwd: replacePort(config.cwd) } : {}),
    ...(config.env ? { env: Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, replacePort(value)])) } : {}),
    ...(config.mitmproxy ? { mitmproxy: { ...config.mitmproxy, port } } : {})
  };
}

export const mcpServerManager = new McpServerManager({ reserveServer: isPlaywrightMcpServer });

export async function refreshMcpTools(input: McpRefreshInput): Promise<ToolDefinition[]> {
  return await mcpServerManager.refresh(input);
}

export async function stopMcpTools(): Promise<void> {
  await mcpServerManager.stopAll();
}

export async function stopMcpToolsForSession(sessionId: string): Promise<void> {
  await mcpServerManager.stopSession(sessionId);
}

export function listMcpTools(session?: Session | string): ToolDefinition[] {
  return mcpServerManager.listTools(session);
}

export function getMcpTool(name: string, session?: Session | string): ToolDefinition | undefined {
  return mcpServerManager.getTool(name, session);
}

export function listMcpServerStatuses(session?: Session | string): McpServerRuntimeStatus[] {
  return mcpServerManager.listStatuses(session);
}

export async function callMcpServerTool(input: McpRefreshInput & { server: string; tool: string; args?: Record<string, unknown> }): Promise<unknown> {
  return await mcpServerManager.callServerTool(input);
}

export async function listMcpResources(input: McpRefreshInput): Promise<Array<McpResourceDescriptor & { server: string }>> {
  return await mcpServerManager.listResources(input);
}

export async function readMcpResource(input: McpRefreshInput & { server: string; uri: string }): Promise<unknown> {
  return await mcpServerManager.readResource(input);
}

export async function callMcpCapabilityTool(input: McpRefreshInput & { preferredServer?: string; tool: string; args?: Record<string, unknown> }): Promise<unknown> {
  return await mcpServerManager.callCapabilityTool(input);
}

export async function ensureMcpProxyReady(input: McpRefreshInput, expectedPort?: number): Promise<void> {
  await mcpServerManager.ensureProxyReady(input, expectedPort);
}

export function configuredMcpServer(workspace: string, preferredName: string): ExternalMcpServer | undefined {
  const rawConfigs = mcpServersFromConfig(loadConfig(workspace).mcpServers ?? {});
  const effectivePort = resolveMcpPort(rawConfigs);
  const configs = rawConfigs.map((config) => applyMcpPortTemplate(config, effectivePort)).filter((config) => config.enabled);
  return configs.find((config) => config.name === preferredName)
    ?? (preferredName === "playwright" ? configs.find(isPlaywrightMcpServer) : configs.find((config) => config.command.includes(preferredName)));
}

function isPlaywrightMcpServer(config: ExternalMcpServer): boolean {
  const command = [config.command, ...config.args].join(" ").toLowerCase();
  return config.name === "playwright" || command.includes("playwright-mcp") || command.includes("@playwright/mcp");
}

export async function prepareMcpServerProcess(input: McpRefreshInput, config: ExternalMcpServer): Promise<ExternalMcpServer> {
  if (!config.runInContainer) {
    return {
      ...config,
      cwd: config.cwd ?? input.workspace
    };
  }
  if (!input.session) throw new Error(`MCP server ${config.name} requires a session for container execution`);
  const containerName = containerNameForSession(input.session.id);
  const result = await new KaliContainerBackend({ workspace: input.workspace, containerName }).startPersistent();
  if (result.exitCode !== 0) throw new Error(result.stderr || `Could not start MCP container ${containerName}`);
  return {
    ...config,
    command: "docker",
    args: [
      "exec",
      "-i",
      containerName,
      "bash",
      "-lc",
      containerMcpShellCommand(config, containerMcpRuntimeDir(input.session.id, config.name))
    ],
    cwd: input.workspace
  };
}

export function mcpToolName(server: string, tool: string): string {
  const name = `mcp_${safeToolPart(server)}_${safeToolPart(tool)}`;
  if (name.length <= TOOL_NAME_MAX_LENGTH) return name;
  const suffix = Bun.hash(`${server}\0${tool}`).toString(36).slice(-10);
  return `${name.slice(0, TOOL_NAME_MAX_LENGTH - suffix.length - 1)}_${suffix}`;
}

export function renderMcpToolResult(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const obj = result as Record<string, unknown>;
  const content = obj.content;
  if (Array.isArray(content)) {
    const parts = content.map((part) => renderMcpContentBlock(part)).filter(Boolean);
    return parts.join("\n");
  }
  return JSON.stringify(result);
}

export function renderMcpContentBlock(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const record = part as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.data === "string") return `[${String(record.type ?? "data")} ${record.data.length} chars]`;
  if (record.type === "image") return "<image content>";
  if (record.type === "audio") return "<audio content>";
  if (record.type === "resource") {
    const resource = record.resource;
    if (resource && typeof resource === "object" && !Array.isArray(resource)) {
      const uri = (resource as Record<string, unknown>).uri;
      return typeof uri === "string" ? `embedded resource: ${uri}` : "embedded resource";
    }
    return "embedded resource";
  }
  if (record.type === "resource_link" || record.type === "resourceLink") {
    const uri = record.uri;
    return typeof uri === "string" ? `link: ${uri}` : "link";
  }
  return JSON.stringify(record);
}

export function formatMcpInventory(statuses: McpServerRuntimeStatus[]): string {
  if (statuses.length === 0) {
    return ["/mcp", "", "MCP Tools", "", "  - No MCP servers configured."].join("\n");
  }
  const lines = ["/mcp", "", "MCP Tools", ""];
  const sorted = [...statuses].sort((a, b) => a.name.localeCompare(b.name));
  if (!sorted.some((status) => status.toolCount > 0)) {
    lines.push("  - No MCP tools available.", "");
  }
  for (const status of sorted) {
    lines.push(`  - ${status.name}${status.enabled ? "" : " (disabled)"}`);
    lines.push(`    - Status: ${status.enabled ? (status.running ? "enabled" : "stopped") : "disabled"}`);
    lines.push(`    - Auth: ${mcpAuthStatusLabel(status.authStatus)}`);
    lines.push(`    - Command: ${status.command || "-"}`);
    if (status.proxy) {
      lines.push(`    - Proxy: ${status.proxy.running ? `127.0.0.1:${status.proxy.port}` : "stopped"}`);
    }
    lines.push(`    - Tools: ${status.tools.length ? status.tools.join(", ") : "(none)"}`);
    lines.push(`    - Resources: ${status.resources.length ? status.resources.map((resource) => `${resource.title ?? resource.name} (${resource.uri})`).join(", ") : "(none)"}`);
    lines.push(`    - Resource templates: ${status.resourceTemplates.length ? status.resourceTemplates.map((template) => `${template.title ?? template.name} (${template.uriTemplate})`).join(", ") : "(none)"}`);
    if (status.error) lines.push(`    - Error: ${status.error}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function mcpAuthStatusLabel(status: McpServerRuntimeStatus["authStatus"]): string {
  switch (status) {
    case "not_logged_in": return "Not logged in";
    case "bearer_token": return "Bearer token";
    case "oauth": return "OAuth";
    case "unsupported": return "Unsupported";
  }
}

export function isMcpErrorResult(result: unknown): boolean {
  return !!result && typeof result === "object" && (result as Record<string, unknown>).isError === true;
}

function mcpScope(session?: Session | string): string {
  return typeof session === "string" ? session : session?.id ?? "host";
}

function scopedServerKey(session: Session | string | undefined, serverName: string): string {
  return `${mcpScope(session)}:${serverName}`;
}

function sameProcessConfig(a: ExternalMcpServer, b: ExternalMcpServer): boolean {
  return a.command === b.command
    && JSON.stringify(a.args) === JSON.stringify(b.args)
    && a.cwd === b.cwd
    && JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {})
    && JSON.stringify(a.mitmproxy ?? {}) === JSON.stringify(b.mitmproxy ?? {})
    && a.toolTimeoutMs === b.toolTimeoutMs
    && a.startupTimeoutMs === b.startupTimeoutMs;
}

function safeToolPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function shellJoin(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function containerMcpShellCommand(config: ExternalMcpServer, runtimeDir = "/workspace"): string {
  const lines = ["export PATH=/root/.local/bin:/usr/local/bin:$PATH"];
  const command = containerMcpCommand(config);
  lines.push(`if ! command -v ${shellQuote(command.command)} >/dev/null 2>&1; then echo "MCP binary not found in farai-kali image: ${shellQuote(command.command)}" >&2; exit 127; fi`);
  lines.push(`mkdir -p ${shellQuote(runtimeDir)}`);
  lines.push(`cd ${shellQuote(runtimeDir)} && ${shellJoin([command.command, ...command.args])}`);
  return lines.join("\n");
}

function containerMcpRuntimeDir(sessionId: string, serverName: string): string {
  return `/workspace/.farai/mcp-runtime/${safeToolPart(sessionId)}/${safeToolPart(serverName)}`;
}

function containerMcpCommand(config: ExternalMcpServer): { command: string; args: string[] } {
  return { command: config.command, args: config.args };
}

function isToolEnabled(config: ExternalMcpServer, tool: string): boolean {
  if (config.enabledTools && !config.enabledTools.includes(tool)) return false;
  if (config.disabledTools?.includes(tool)) return false;
  return true;
}
