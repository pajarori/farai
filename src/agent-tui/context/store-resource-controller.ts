import type { ProxyFlowQuery, ProxyFlowSummary } from "../../agent-tools/services/mitmproxy/flows";
import type { EmailCatalogSnapshot, McpCatalogSnapshot, TuiRuntimePort } from "../runtime-port";
import type { FaraiTuiStore, StoreActions } from "../store";
import type { createStoreSessionController, StoreSessionOwner } from "./store-session-controller";

type SessionController = ReturnType<typeof createStoreSessionController>;

type StoreResourceControllerInput = {
  port: TuiRuntimePort;
  store: FaraiTuiStore;
  actions: StoreActions;
  sessions: SessionController;
  setStatusDetail(detail: string | undefined, timeoutMs?: number): void;
  isDisposed(): boolean;
};

export function proxyRefreshQuery(): ProxyFlowQuery {
  return { limit: 300 };
}

export function createStoreResourceController(input: StoreResourceControllerInput) {
  const { port, store, actions, sessions } = input;
  const proxyRefreshes = new Map<string, Promise<void>>();
  const mcpRefreshes = new Map<string, { epoch: number; promise: Promise<void> }>();
  const agentThreadRefreshes = new Map<string, { epoch: number; promise: Promise<void> }>();
  const containerToggles = new Map<string, { epoch: number; promise: Promise<void> }>();
  let modelRefreshGeneration = 0;
  let modelOverlayGeneration = 0;
  let mcpOverlayGeneration = 0;
  let emailOverlayGeneration = 0;

  async function loadMcpCatalog(): Promise<McpCatalogSnapshot> {
    const loader = (port as typeof port & { loadMcpCatalog?: () => Promise<McpCatalogSnapshot> }).loadMcpCatalog;
    if (typeof loader === "function") return await loader.call(port);
    return { servers: store.ui.mcpServers, statuses: await port.listMcpStatuses() };
  }

  async function loadEmailCatalog(): Promise<EmailCatalogSnapshot> {
    return await port.loadEmailCatalog();
  }

  function refreshSessionMcp(sessionId: string): Promise<void> {
    const owner = sessions.captureOwner(sessionId);
    if (!owner) return Promise.resolve();
    const existing = mcpRefreshes.get(sessionId);
    if (existing?.epoch === owner.epoch) return existing.promise;
    const refresh = (async () => {
      if (!sessions.owns(owner)) return;
      input.setStatusDetail("starting mcp");
      try {
        await port.refreshMcp();
        if (!sessions.owns(owner)) return;
        const [catalog, services] = await Promise.all([loadMcpCatalog(), port.listServices()]);
        if (!sessions.owns(owner)) return;
        actions.mcpCatalogSet(catalog.servers, catalog.statuses);
        actions.servicesSet(services);
      } catch (error) {
        if (sessions.owns(owner)) actions.errorSet(error instanceof Error ? error.message : String(error));
      } finally {
        if (sessions.owns(owner) && store.ui.statusDetail === "starting mcp") input.setStatusDetail(undefined);
      }
    })();
    const entry = { epoch: owner.epoch, promise: refresh };
    mcpRefreshes.set(sessionId, entry);
    const cleanup = () => {
      if (mcpRefreshes.get(sessionId) === entry) mcpRefreshes.delete(sessionId);
    };
    void refresh.then(cleanup, cleanup);
    return refresh;
  }

  async function refreshContainerStatus(): Promise<void> {
    const owner = sessions.captureOwner();
    if (!owner) return;
    try {
      const status = await port.containerStatus();
      if (!sessions.owns(owner)) return;
      actions.containerStatusSet(containerState(
        status.imageExists,
        status.imageContractCurrent,
        status.persistentRunning,
        status.persistentImageCurrent
      ));
    } catch {
      if (sessions.owns(owner)) actions.containerStatusSet("missing");
    }
  }

  async function refreshServices(): Promise<void> {
    const owner = sessions.captureOwner();
    if (!owner) return;
    try {
      const services = await port.listServices();
      if (sessions.owns(owner)) actions.servicesSet(services);
    } catch {
      if (sessions.owns(owner)) actions.servicesSet([]);
    }
  }

  function refreshProxyFlows(): Promise<void> {
    const owner = sessions.captureOwner();
    if (!owner) return Promise.resolve();
    const key = `${owner.sessionId}:${owner.epoch}`;
    const inFlight = proxyRefreshes.get(key);
    if (inFlight) return inFlight;
    const refresh = (async () => {
      try {
        const flows = await port.listProxyFlows(proxyRefreshQuery());
        if (sessions.owns(owner)) actions.proxyFlowsSet(sortProxyFlowsNewestFirst(flows));
      } catch {
      }
    })();
    proxyRefreshes.set(key, refresh);
    const cleanup = () => {
      if (proxyRefreshes.get(key) === refresh) proxyRefreshes.delete(key);
    };
    void refresh.then(cleanup, cleanup);
    return refresh;
  }

  async function refreshAvailableModels(): Promise<void> {
    if (input.isDisposed()) return;
    const generation = ++modelRefreshGeneration;
    try {
      const catalog = await port.loadModelCatalog();
      if (input.isDisposed() || modelRefreshGeneration !== generation) return;
      actions.modelCatalogSet(catalog.providers, catalog.models);
    } catch (error) {
      if (input.isDisposed() || modelRefreshGeneration !== generation) return;
      actions.availableModelsSet([]);
      throw error;
    }
  }

  async function openModelsOverlay(): Promise<void> {
    if (input.isDisposed()) return;
    const generation = ++modelOverlayGeneration;
    actions.overlayOpen("model");
    input.setStatusDetail("loading models");
    try {
      await refreshAvailableModels();
    } catch (error) {
      if (!input.isDisposed() && modelOverlayGeneration === generation && store.ui.overlayStack.at(-1)?.kind === "model") {
        actions.errorSet(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (!input.isDisposed() && modelOverlayGeneration === generation && store.ui.statusDetail === "loading models") {
        input.setStatusDetail(undefined);
      }
    }
  }

  function refreshAgentThreads(): Promise<void> {
    const owner = sessions.captureOwner();
    if (!owner) return Promise.resolve();
    const inFlight = agentThreadRefreshes.get(owner.sessionId);
    if (inFlight?.epoch === owner.epoch) return inFlight.promise;
    const refresh = (async () => {
      try {
        const threads = await port.listAgentThreads(owner.sessionId);
        if (sessions.owns(owner)) actions.agentThreadsSet(threads);
      } catch (error) {
        if (sessions.owns(owner) && store.ui.overlayStack.at(-1)?.kind === "agents") {
          actions.errorSet(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    const entry = { epoch: owner.epoch, promise: refresh };
    agentThreadRefreshes.set(owner.sessionId, entry);
    const cleanup = () => {
      if (agentThreadRefreshes.get(owner.sessionId) === entry) agentThreadRefreshes.delete(owner.sessionId);
    };
    void refresh.then(cleanup, cleanup);
    return refresh;
  }

  async function openAgentsOverlay(): Promise<void> {
    const owner = sessions.captureOwner();
    if (!owner) return;
    actions.overlayOpen("agents");
    try {
      await Promise.all([sessions.refreshSessions(), refreshAgentThreads()]);
    } catch (error) {
      if (sessions.owns(owner) && store.ui.overlayStack.at(-1)?.kind === "agents") {
        actions.errorSet(error instanceof Error ? error.message : String(error));
      }
    }
  }

  async function openMcpOverlay(): Promise<void> {
    const owner = sessions.captureOwner();
    if (!owner) return;
    const generation = ++mcpOverlayGeneration;
    input.setStatusDetail("refreshing mcp");
    actions.mcpStatusErrorSet(undefined);
    actions.overlayOpen("mcp");
    try {
      let refreshError: string | undefined;
      try {
        await port.refreshMcp();
      } catch (error) {
        refreshError = error instanceof Error ? error.message : String(error);
      }
      if (mcpOverlayGeneration !== generation || !sessions.owns(owner)) return;
      const [services, catalog] = await Promise.allSettled([port.listServices(), loadMcpCatalog()]);
      if (mcpOverlayGeneration !== generation || !sessions.owns(owner)) return;
      if (services.status === "fulfilled") actions.servicesSet(services.value);
      if (catalog.status === "fulfilled") actions.mcpCatalogSet(catalog.value.servers, catalog.value.statuses);
      const errors = [
        refreshError,
        services.status === "rejected" ? errorMessage(services.reason) : undefined,
        catalog.status === "rejected" ? errorMessage(catalog.reason) : undefined
      ].filter((message): message is string => Boolean(message));
      actions.mcpStatusErrorSet(errors.length ? [...new Set(errors)].join(" · ") : undefined);
    } finally {
      if (mcpOverlayGeneration === generation && sessions.owns(owner) && store.ui.statusDetail === "refreshing mcp") {
        input.setStatusDetail(undefined);
      }
    }
  }

  async function openEmailOverlay(): Promise<void> {
    const owner = sessions.captureOwner();
    if (!owner) return;
    const generation = ++emailOverlayGeneration;
    input.setStatusDetail("loading email");
    actions.overlayOpen("email");
    try {
      const catalog = await loadEmailCatalog();
      if (emailOverlayGeneration !== generation || !sessions.owns(owner)) return;
      actions.emailCatalogSet(catalog.accounts);
    } catch (error) {
      if (emailOverlayGeneration === generation && sessions.owns(owner)) actions.errorSet(errorMessage(error));
    } finally {
      if (emailOverlayGeneration === generation && sessions.owns(owner) && store.ui.statusDetail === "loading email") {
        input.setStatusDetail(undefined);
      }
    }
  }

  function toggleContainer(options: { reportError?: boolean } = {}): Promise<void> {
    const owner = sessions.captureOwner();
    if (!owner) return Promise.resolve();
    const existing = containerToggles.get(owner.sessionId);
    if (existing?.epoch === owner.epoch) return observeContainerToggle(existing.promise, owner, options);
    const toggle = (async () => {
      const status = await port.containerStatus();
      if (!sessions.owns(owner)) return;
      const current = containerState(
        status.imageExists,
        status.imageContractCurrent,
        status.persistentRunning,
        status.persistentImageCurrent
      );
      if (current === "running") await port.stopContainer();
      else await port.startContainer();
      if (!sessions.owns(owner)) return;
      await refreshContainerStatus();
    })();
    const entry = { epoch: owner.epoch, promise: toggle };
    containerToggles.set(owner.sessionId, entry);
    const cleanup = () => {
      if (containerToggles.get(owner.sessionId) === entry) containerToggles.delete(owner.sessionId);
    };
    void toggle.then(cleanup, cleanup);
    return observeContainerToggle(toggle, owner, options);
  }

  async function observeContainerToggle(
    toggle: Promise<void>,
    owner: StoreSessionOwner,
    options: { reportError?: boolean }
  ): Promise<void> {
    try {
      await toggle;
    } catch (error) {
      if (!sessions.owns(owner)) return;
      if (options.reportError !== false) {
        actions.errorSet(errorMessage(error));
        return;
      }
      throw error;
    }
  }

  function dispose(): void {
    modelRefreshGeneration += 1;
    modelOverlayGeneration += 1;
    mcpOverlayGeneration += 1;
    emailOverlayGeneration += 1;
    proxyRefreshes.clear();
    mcpRefreshes.clear();
    agentThreadRefreshes.clear();
    containerToggles.clear();
  }

  return {
    refreshSessionMcp,
    refreshContainerStatus,
    refreshServices,
    refreshProxyFlows,
    refreshAvailableModels,
    openModelsOverlay,
    refreshAgentThreads,
    openAgentsOverlay,
    openMcpOverlay,
    openEmailOverlay,
    toggleContainer,
    dispose
  };
}

function sortProxyFlowsNewestFirst(flows: ProxyFlowSummary[]): ProxyFlowSummary[] {
  return flows.slice().sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp));
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function containerState(
  imageExists: boolean,
  imageContractCurrent: boolean,
  persistentRunning: boolean,
  persistentImageCurrent: boolean
): "missing" | "running" | "stopped" {
  if (!imageExists || !imageContractCurrent) return "missing";
  return persistentRunning && persistentImageCurrent ? "running" : "stopped";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
