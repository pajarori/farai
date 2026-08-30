import type { TuiStoreValue } from "../context/store";
import type { TuiRuntimePort } from "../runtime-port";
import { modelProviderProtocolMove, modelProviderWizardFieldMove } from "../model-provider-state";
import { createControllerOperations } from "./controller-operation";
import type { OverlaySelection } from "./overlay-selection";

type ModelProviderControllerInput = {
  tui: TuiStoreValue;
  port: TuiRuntimePort;
  selection: OverlaySelection;
  isDisposed(): boolean;
};

export function createModelProviderController(input: ModelProviderControllerInput) {
  const { tui, port, selection } = input;
  const operations = createControllerOperations(tui);
  let probeController: AbortController | undefined;

  function reset(): void {
    operations.invalidate();
    probeController?.abort();
    probeController = undefined;
  }

  function overlayOpen(): boolean {
    return tui.store.ui.overlayStack.at(-1)?.kind === "model";
  }

  function openAdd(): void {
    reset();
    tui.actions.modelProviderWizardOpen();
  }

  function openEdit(): void {
    const provider = selection.modelProvider();
    if (!provider?.removable) return;
    reset();
    tui.actions.modelProviderWizardOpen(provider);
  }

  async function testSelected(): Promise<void> {
    const provider = selection.modelProvider();
    if (!provider) return;
    const status = `testing ${provider.id}`;
    if (tui.store.ui.statusDetail === status) return;
    const operation = operations.begin(status);
    tui.actions.errorSet(undefined);
    try {
      const result = await port.probeModelProvider({ providerID: provider.id });
      if (!operations.owns(operation) || !overlayOpen() || input.isDisposed()) return;
      operations.finish(operation, result.ok
        ? `${provider.id}: ${result.models.length} models · ${result.latencyMs}ms`
        : `${provider.id}: ${result.error ?? "probe failed"}`, 4_000);
    } catch (error) {
      if (!operations.owns(operation) || !overlayOpen() || input.isDisposed()) return;
      operations.finish(operation);
      tui.actions.errorSet(error instanceof Error ? error.message : String(error));
    } finally {
      if (!overlayOpen() || input.isDisposed()) operations.finish(operation);
    }
  }

  function requestRemoval(): void {
    const provider = selection.modelProvider();
    if (provider?.removable) tui.actions.modelProviderRemovalOpen(provider);
  }

  async function confirmRemoval(): Promise<void> {
    const removalState = tui.store.ui.modelProviderRemoval;
    if (!removalState || removalState.busy) return;
    const operation = operations.begin();
    tui.actions.modelProviderRemovalPatch({ busy: true, error: undefined });
    let result: Awaited<ReturnType<typeof port.removeModelProvider>>;
    try {
      result = await port.removeModelProvider(removalState.provider.id);
    } catch (error) {
      if (!operations.owns(operation) || input.isDisposed()) return;
      if (tui.store.ui.modelProviderRemoval?.provider.id !== removalState.provider.id) return;
      tui.actions.modelProviderRemovalPatch({
        busy: false,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    if (!operations.owns(operation) || input.isDisposed() || tui.store.ui.modelProviderRemoval?.provider.id !== removalState.provider.id) return;
    tui.actions.modelProviderRemovalClose();
    tui.actions.overlayClear();
    tui.actions.overlayPush({ kind: "model", query: "", index: 0 });
    try {
      await Promise.all([tui.refreshAvailableModels(), tui.refreshSessions(), tui.refreshSnapshot()]);
    } catch (error) {
      if (!operations.owns(operation) || input.isDisposed()) return;
      tui.actions.errorSet(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!operations.owns(operation) || input.isDisposed()) return;
    const removal = result.providerRemains ? `removed ${result.location} override for ${result.id}` : `removed ${result.id}`;
    tui.setStatusDetail(`${removal} · ${result.updatedSessions} sessions moved to ${result.fallbackModel}`, 4_000);
  }

  function cancelRemoval(): void {
    operations.invalidate();
    tui.actions.modelProviderRemovalClose();
  }

  async function next(test = true): Promise<void> {
    const wizard = tui.store.ui.modelProviderWizard;
    if (!wizard || wizard.busy) return;
    tui.actions.modelProviderWizardPatch({ error: undefined });
    if (wizard.field === "id") {
      if (!wizard.id.trim()) {
        tui.actions.modelProviderWizardPatch({ error: "provider id is required" });
        return;
      }
      const normalized = wizard.id.trim().replace(/\s+/g, "-").toLowerCase();
      if (wizard.mode === "add" && tui.store.ui.modelProviders.some((provider) => provider.id === normalized)) {
        tui.actions.modelProviderWizardPatch({ error: `${normalized} already exists · select it and press ctrl+e to edit` });
        return;
      }
      tui.actions.modelProviderWizardPatch({ id: normalized, field: "protocol" });
      return;
    }
    if (wizard.field === "protocol") {
      tui.actions.modelProviderWizardPatch({ field: "baseUrl" });
      return;
    }
    if (wizard.field === "baseUrl") {
      if (!wizard.baseUrl.trim()) {
        tui.actions.modelProviderWizardPatch({ error: "base url is required" });
        return;
      }
      tui.actions.modelProviderWizardPatch({ field: "apiKey" });
      return;
    }
    if (wizard.field === "apiKey") {
      tui.actions.modelProviderWizardPatch({ field: "model" });
      return;
    }
    if (wizard.field === "model") {
      tui.actions.modelProviderWizardPatch({ field: "review" });
      return;
    }

    const operation = operations.begin();
    if (test) {
      probeController?.abort();
      const controller = new AbortController();
      probeController = controller;
      tui.actions.modelProviderWizardPatch({ busy: true, busyKind: "probe", error: undefined, probe: undefined });
      let probe: Awaited<ReturnType<typeof port.probeModelProvider>>;
      try {
        probe = await port.probeModelProvider({
          baseUrl: wizard.baseUrl,
          protocol: wizard.protocol,
          ...(wizard.apiKey ? { apiKey: wizard.apiKey } : {}),
          timeoutMs: 8_000
        }, controller.signal);
      } catch (error) {
        if (!operations.owns(operation) || probeController !== controller || controller.signal.aborted || !tui.store.ui.modelProviderWizard || input.isDisposed()) return;
        probeController = undefined;
        tui.actions.modelProviderWizardPatch({
          busy: false,
          busyKind: undefined,
          error: error instanceof Error ? error.message : String(error)
        });
        return;
      }
      if (!operations.owns(operation) || probeController !== controller || !tui.store.ui.modelProviderWizard || input.isDisposed()) return;
      probeController = undefined;
      tui.actions.modelProviderWizardPatch({ probe });
      if (!probe.ok) {
        tui.actions.modelProviderWizardPatch({ busy: false, busyKind: undefined, error: `${probe.error ?? "provider probe failed"} · ctrl+s saves without testing` });
        return;
      }
      if (!wizard.model.trim() && probe.models.length === 1) tui.actions.modelProviderWizardPatch({ model: probe.models[0]! });
    }

    const current = tui.store.ui.modelProviderWizard;
    if (!operations.owns(operation) || !current || input.isDisposed()) return;
    tui.actions.modelProviderWizardPatch({ busy: true, busyKind: "save", error: undefined });
    try {
      const catalog = await port.saveModelProvider({
        id: current.id,
        baseUrl: current.baseUrl,
        protocol: current.protocol,
        ...(current.model.trim() ? { model: current.model.trim() } : {}),
        ...(current.apiKey ? { apiKey: current.apiKey, credentialAction: "replace" as const } : current.removeCredential ? { credentialAction: "remove" as const } : { credentialAction: "keep" as const }),
        location: current.location
      });
      if (!operations.owns(operation) || input.isDisposed() || !tui.store.ui.modelProviderWizard) return;
      tui.actions.modelCatalogSet(catalog.providers, catalog.models);
      tui.actions.modelProviderWizardClose();
      tui.setStatusDetail(`provider ${current.id.trim().toLowerCase()} saved`, 3_000);
    } catch (error) {
      if (!operations.owns(operation) || input.isDisposed() || !tui.store.ui.modelProviderWizard) return;
      tui.actions.modelProviderWizardPatch({
        busy: false,
        busyKind: undefined,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  function back(): void {
    const wizard = tui.store.ui.modelProviderWizard;
    if (!wizard) return;
    if (wizard.busy) {
      if (wizard.busyKind !== "probe") return;
      operations.invalidate();
      probeController?.abort();
      probeController = undefined;
      tui.actions.modelProviderWizardPatch({ busy: false, busyKind: undefined, error: "provider probe cancelled" });
      return;
    }
    if ((wizard.mode === "add" && wizard.field === "id") || (wizard.mode === "edit" && wizard.field === "protocol")) {
      reset();
      tui.actions.modelProviderWizardClose();
      return;
    }
    tui.actions.modelProviderWizardPatch({ field: modelProviderWizardFieldMove(wizard.field, -1), error: undefined });
  }

  function protocolMove(delta: number): void {
    const wizard = tui.store.ui.modelProviderWizard;
    if (wizard) tui.actions.modelProviderWizardPatch({ protocol: modelProviderProtocolMove(wizard.protocol, delta) });
  }

  function secretBackspace(): void {
    const wizard = tui.store.ui.modelProviderWizard;
    if (wizard?.apiKey) tui.actions.modelProviderWizardPatch({ apiKey: [...wizard.apiKey].slice(0, -1).join(""), removeCredential: false });
  }

  function toggleCredentialRemoval(): void {
    const wizard = tui.store.ui.modelProviderWizard;
    if (wizard) tui.actions.modelProviderWizardPatch({ apiKey: "", removeCredential: !wizard.removeCredential, error: undefined });
  }

  return {
    reset,
    dispose: reset,
    openAdd,
    openEdit,
    testSelected,
    requestRemoval,
    confirmRemoval,
    cancelRemoval,
    next,
    back,
    protocolMove,
    secretBackspace,
    toggleCredentialRemoval
  };
}
