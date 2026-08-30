import type { TuiStoreValue } from "../context/store";
import type { TuiRuntimePort } from "../runtime-port";
import { mcpAuthMove, mcpTransportMove, mcpWizardFieldMove, mcpWizardSaveInput } from "../mcp-server-state";
import { createControllerOperations } from "./controller-operation";
import type { OverlaySelection } from "./overlay-selection";

type McpServerControllerInput = {
  tui: TuiStoreValue;
  port: TuiRuntimePort;
  selection: OverlaySelection;
  isDisposed(): boolean;
};

export function createMcpServerController(input: McpServerControllerInput) {
  const { tui, port, selection } = input;
  const operations = createControllerOperations(tui);
  let probeController: AbortController | undefined;

  function reset(): void {
    operations.invalidate();
    probeController?.abort();
    probeController = undefined;
  }

  function overlayOpen(): boolean {
    return tui.store.ui.overlayStack.at(-1)?.kind === "mcp";
  }

  function openAdd(): void {
    reset();
    tui.actions.mcpServerWizardOpen();
  }

  function openEdit(): void {
    const server = selection.mcpServer();
    if (!server) return;
    reset();
    tui.actions.mcpServerWizardOpen(server);
  }

  async function testSelected(): Promise<void> {
    const server = selection.mcpServer();
    if (!server) return;
    const status = `testing ${server.id}`;
    if (tui.store.ui.statusDetail === status) return;
    const operation = operations.begin(status);
    tui.actions.errorSet(undefined);
    try {
      const result = await port.startMcpServer(server.id);
      if (!operations.owns(operation) || !overlayOpen() || input.isDisposed()) return;
      const catalog = await port.loadMcpCatalog();
      if (!operations.owns(operation) || !overlayOpen() || input.isDisposed()) return;
      tui.actions.mcpCatalogSet(catalog.servers, catalog.statuses);
      operations.finish(operation, `${server.id}: ${result.toolCount} tools ready`, 4_000);
    } catch (error) {
      if (!operations.owns(operation) || !overlayOpen() || input.isDisposed()) return;
      operations.finish(operation);
      tui.actions.errorSet(error instanceof Error ? error.message : String(error));
    } finally {
      if (!overlayOpen() || input.isDisposed()) operations.finish(operation);
    }
  }

  async function toggleSelected(): Promise<void> {
    const server = selection.mcpServer();
    if (!server?.toggleable) return;
    const status = `${server.enabled ? "disabling" : "enabling"} ${server.id}`;
    const operation = operations.begin(status);
    tui.actions.errorSet(undefined);
    try {
      const catalog = await port.setMcpServerEnabled(server.id, !server.enabled);
      if (!operations.owns(operation) || !overlayOpen() || input.isDisposed()) return;
      tui.actions.mcpCatalogSet(catalog.servers, catalog.statuses);
      operations.finish(operation, `${server.id}: ${server.enabled ? "disabled" : "enabled"}`, 3_000);
    } catch (error) {
      if (!operations.owns(operation) || !overlayOpen() || input.isDisposed()) return;
      operations.finish(operation);
      tui.actions.errorSet(error instanceof Error ? error.message : String(error));
    } finally {
      if (!overlayOpen() || input.isDisposed()) operations.finish(operation);
    }
  }

  function requestRemoval(): void {
    const server = selection.mcpServer();
    if (!server?.removable) return;
    reset();
    tui.actions.mcpServerRemovalOpen(server);
  }

  async function confirmRemoval(): Promise<void> {
    const removal = tui.store.ui.mcpServerRemoval;
    if (!removal || removal.busy) return;
    const operation = operations.begin();
    tui.actions.mcpServerRemovalPatch({ busy: true, error: undefined });
    try {
      const catalog = await port.removeMcpServer(removal.server.id);
      if (!operations.owns(operation) || input.isDisposed() || tui.store.ui.mcpServerRemoval?.server.id !== removal.server.id) return;
      tui.actions.mcpServerRemovalClose();
      tui.actions.mcpCatalogSet(catalog.servers, catalog.statuses);
      const frame = tui.store.ui.overlayStack.at(-1);
      if (frame?.kind === "mcp" && frame.serverID === removal.server.id) tui.actions.overlayPop();
      tui.setStatusDetail(`removed ${removal.server.id}`, 3_000);
    } catch (error) {
      if (!operations.owns(operation) || input.isDisposed() || tui.store.ui.mcpServerRemoval?.server.id !== removal.server.id) return;
      tui.actions.mcpServerRemovalPatch({ busy: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function cancelRemoval(): void {
    operations.invalidate();
    tui.actions.mcpServerRemovalClose();
  }

  async function next(test = true): Promise<void> {
    const wizard = tui.store.ui.mcpServerWizard;
    if (!wizard || wizard.busy) return;
    tui.actions.mcpServerWizardPatch({ error: undefined });
    if (wizard.field === "id") {
      const normalized = wizard.id.trim().replace(/\s+/g, "-").toLowerCase();
      if (!normalized) {
        tui.actions.mcpServerWizardPatch({ error: "server id is required" });
        return;
      }
      if (wizard.mode === "add" && tui.store.ui.mcpServers.some((server) => server.id === normalized)) {
        tui.actions.mcpServerWizardPatch({ error: `${normalized} already exists · select it and press ctrl+e to edit` });
        return;
      }
      tui.actions.mcpServerWizardPatch({ id: normalized, field: "transport" });
      return;
    }
    if (wizard.field === "endpoint" && !wizard.endpoint.trim()) {
      tui.actions.mcpServerWizardPatch({ error: wizard.transport === "http" ? "server url is required" : "stdio command is required" });
      return;
    }
    if (wizard.field !== "review") {
      tui.actions.mcpServerWizardPatch({ field: mcpWizardFieldMove(wizard, 1) });
      return;
    }
    let saveInput;
    try {
      saveInput = mcpWizardSaveInput(wizard);
    } catch (error) {
      tui.actions.mcpServerWizardPatch({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const operation = operations.begin();
    if (test) {
      probeController?.abort();
      const controller = new AbortController();
      probeController = controller;
      tui.actions.mcpServerWizardPatch({ busy: true, busyKind: "probe", error: undefined, probe: undefined });
      try {
        const probe = await port.probeMcpServer(saveInput, controller.signal);
        if (!operations.owns(operation) || probeController !== controller || controller.signal.aborted || !tui.store.ui.mcpServerWizard || input.isDisposed()) return;
        probeController = undefined;
        tui.actions.mcpServerWizardPatch({ probe });
        if (!probe.ok) {
          tui.actions.mcpServerWizardPatch({ busy: false, busyKind: undefined, error: `${probe.error ?? "mcp server test failed"} · ctrl+s saves without testing` });
          return;
        }
      } catch (error) {
        if (!operations.owns(operation) || probeController !== controller || controller.signal.aborted || !tui.store.ui.mcpServerWizard || input.isDisposed()) return;
        probeController = undefined;
        tui.actions.mcpServerWizardPatch({ busy: false, busyKind: undefined, error: error instanceof Error ? error.message : String(error) });
        return;
      }
    }

    const current = tui.store.ui.mcpServerWizard;
    if (!operations.owns(operation) || !current || input.isDisposed()) return;
    try {
      saveInput = mcpWizardSaveInput(current);
    } catch (error) {
      tui.actions.mcpServerWizardPatch({ busy: false, busyKind: undefined, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    tui.actions.mcpServerWizardPatch({ busy: true, busyKind: "save", error: undefined });
    try {
      const catalog = await port.saveMcpServer(saveInput);
      if (!operations.owns(operation) || input.isDisposed() || !tui.store.ui.mcpServerWizard) return;
      const frame = tui.store.ui.overlayStack.at(-1);
      tui.actions.mcpCatalogSet(catalog.servers, catalog.statuses);
      tui.actions.mcpServerWizardClose();
      if (frame?.kind === "mcp" && frame.serverID === saveInput.originalID && saveInput.originalID !== saveInput.id) tui.actions.overlayPop();
      tui.setStatusDetail(`mcp server ${saveInput.id} saved`, 3_000);
    } catch (error) {
      if (!operations.owns(operation) || input.isDisposed() || !tui.store.ui.mcpServerWizard) return;
      tui.actions.mcpServerWizardPatch({ busy: false, busyKind: undefined, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function back(): void {
    const wizard = tui.store.ui.mcpServerWizard;
    if (!wizard) return;
    if (wizard.busy) {
      if (wizard.busyKind !== "probe") return;
      operations.invalidate();
      probeController?.abort();
      probeController = undefined;
      tui.actions.mcpServerWizardPatch({ busy: false, busyKind: undefined, error: "mcp server test cancelled" });
      return;
    }
    if ((wizard.mode === "add" && wizard.field === "id") || (wizard.mode === "edit" && wizard.field === "transport")) {
      reset();
      tui.actions.mcpServerWizardClose();
      return;
    }
    tui.actions.mcpServerWizardPatch({ field: mcpWizardFieldMove(wizard, -1), error: undefined });
  }

  function transportMove(delta: number): void {
    const wizard = tui.store.ui.mcpServerWizard;
    if (!wizard) return;
    const transport = mcpTransportMove(wizard.transport, delta);
    tui.actions.mcpServerWizardPatch({ transport, ...(transport === "stdio" ? { auth: "none" as const } : {}), error: undefined });
  }

  function authMove(delta: number): void {
    const wizard = tui.store.ui.mcpServerWizard;
    if (wizard) tui.actions.mcpServerWizardPatch({ auth: mcpAuthMove(wizard.auth, delta), error: undefined });
  }

  function secretBackspace(): void {
    const wizard = tui.store.ui.mcpServerWizard;
    if (wizard?.credential) tui.actions.mcpServerWizardPatch({ credential: [...wizard.credential].slice(0, -1).join(""), removeCredential: false });
  }

  function toggleCredentialRemoval(): void {
    const wizard = tui.store.ui.mcpServerWizard;
    if (wizard) tui.actions.mcpServerWizardPatch({ credential: "", removeCredential: !wizard.removeCredential, error: undefined });
  }

  return {
    reset,
    dispose: reset,
    openAdd,
    openEdit,
    testSelected,
    toggleSelected,
    requestRemoval,
    confirmRemoval,
    cancelRemoval,
    next,
    back,
    transportMove,
    authMove,
    secretBackspace,
    toggleCredentialRemoval
  };
}
