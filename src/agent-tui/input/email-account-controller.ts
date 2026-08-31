import type { TuiStoreValue } from "../context/store";
import type { TuiRuntimePort } from "../runtime-port";
import { emailProviderMove, emailStorageMove, emailWizardFieldMove, emailWizardSaveInput } from "../email-account-state";
import { emailProviderPreset } from "../../agent-email/accounts";
import { createControllerOperations } from "./controller-operation";
import type { OverlaySelection } from "./overlay-selection";

type EmailAccountControllerInput = {
  tui: TuiStoreValue;
  port: TuiRuntimePort;
  selection: OverlaySelection;
  isDisposed(): boolean;
};

export function createEmailAccountController(input: EmailAccountControllerInput) {
  const { tui, port, selection } = input;
  const operations = createControllerOperations(tui);
  let probeController: AbortController | undefined;
  let roleGeneration = 0;
  let roleQueue = Promise.resolve();

  function reset(): void {
    operations.invalidate();
    roleGeneration += 1;
    probeController?.abort();
    probeController = undefined;
  }

  function overlayOpen(): boolean {
    return tui.store.ui.overlayStack.at(-1)?.kind === "email";
  }

  function openAdd(): void {
    reset();
    tui.actions.emailAccountWizardOpen();
  }

  function openEdit(): void {
    const account = selection.emailAccount();
    if (!account) return;
    reset();
    tui.actions.emailAccountWizardOpen(account);
  }

  async function testSelected(): Promise<void> {
    const account = selection.emailAccount();
    if (!account) return;
    const operation = operations.begin(`testing ${account.label}`);
    tui.actions.errorSet(undefined);
    try {
      const result = await port.probeEmailAccount({ emailId: account.id });
      if (!operations.owns(operation) || !overlayOpen() || input.isDisposed()) return;
      operations.finish(operation, result.ok
        ? `${account.label}: ${result.messages ?? 0} messages · ${result.latencyMs}ms`
        : `${account.label}: ${result.error ?? "connection failed"}`, 4_000);
    } catch (error) {
      if (!operations.owns(operation) || !overlayOpen() || input.isDisposed()) return;
      operations.finish(operation);
      tui.actions.errorSet(error instanceof Error ? error.message : String(error));
    }
  }

  function setRole(role: "primary" | "secondary"): Promise<void> {
    const selected = selection.selectedEmail();
    const session = tui.store.snapshot.session;
    if (!selected || !session) return Promise.resolve();
    const generation = roleGeneration;
    const sessionId = session.id;
    const emailId = selected.emailId;
    const update = roleQueue.catch(() => {}).then(async () => {
      if (generation !== roleGeneration || input.isDisposed() || tui.store.activeSessionId !== sessionId || !overlayOpen()) return;
      const currentSession = tui.store.snapshot.session;
      if (!currentSession || currentSession.id !== sessionId) return;
      const key = role === "primary" ? "emailPrimaryId" : "emailSecondaryId";
      const current = role === "primary" ? currentSession.emailPrimaryId : currentSession.emailSecondaryId;
      const other = role === "primary" ? currentSession.emailSecondaryId : currentSession.emailPrimaryId;
      const patch = current === emailId
        ? { [key]: null }
        : {
            [key]: emailId,
            ...(other === emailId ? { [role === "primary" ? "emailSecondaryId" : "emailPrimaryId"]: null } : {})
          };
      await port.updateSession(sessionId, patch);
      if (generation !== roleGeneration || input.isDisposed() || tui.store.activeSessionId !== sessionId) return;
      await tui.refreshSnapshot();
      if (generation !== roleGeneration || input.isDisposed() || tui.store.activeSessionId !== sessionId) return;
      tui.setStatusDetail(current === emailId ? `${role} email cleared` : `${role}: ${emailId}`, 3_000);
    });
    roleQueue = update;
    return update;
  }

  function requestRemoval(): void {
    const account = selection.emailAccount();
    if (account) tui.actions.emailAccountRemovalOpen(account);
  }

  async function confirmRemoval(): Promise<void> {
    const state = tui.store.ui.emailAccountRemoval;
    if (!state || state.busy) return;
    const operation = operations.begin();
    tui.actions.emailAccountRemovalPatch({ busy: true, error: undefined });
    try {
      await port.removeEmailAccount(state.account.id);
      if (!operations.owns(operation) || input.isDisposed() || tui.store.ui.emailAccountRemoval?.account.id !== state.account.id) return;
      const catalog = await port.loadEmailCatalog();
      if (!operations.owns(operation) || input.isDisposed()) return;
      tui.actions.emailCatalogSet(catalog.accounts);
      tui.actions.emailAccountRemovalClose();
      await tui.refreshSnapshot();
      tui.setStatusDetail(`removed ${state.account.label}`, 3_000);
    } catch (error) {
      if (!operations.owns(operation) || input.isDisposed() || tui.store.ui.emailAccountRemoval?.account.id !== state.account.id) return;
      tui.actions.emailAccountRemovalPatch({ busy: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function cancelRemoval(): void {
    operations.invalidate();
    tui.actions.emailAccountRemovalClose();
  }

  async function next(test = true): Promise<void> {
    const wizard = tui.store.ui.emailAccountWizard;
    if (!wizard || wizard.busy) return;
    tui.actions.emailAccountWizardPatch({ error: undefined });
    if (wizard.field === "provider") {
      const preset = emailProviderPreset(wizard.provider);
      tui.actions.emailAccountWizardPatch({
        endpoint: wizard.provider === "custom" ? wizard.endpoint : `imaps://${preset.host}:${preset.port}`,
        field: "label"
      });
      return;
    }
    if (wizard.field === "label") {
      if (!wizard.label.trim()) return void tui.actions.emailAccountWizardPatch({ error: "email label is required" });
      tui.actions.emailAccountWizardPatch({ field: "address" });
      return;
    }
    if (wizard.field === "address") {
      if (!wizard.address.trim()) return void tui.actions.emailAccountWizardPatch({ error: "email address is required" });
      tui.actions.emailAccountWizardPatch({ username: wizard.username || wizard.address.trim(), field: "username" });
      return;
    }
    if (wizard.field === "username") {
      tui.actions.emailAccountWizardPatch({ field: wizard.provider === "custom" ? "endpoint" : "credential" });
      return;
    }
    if (wizard.field === "endpoint") {
      if (!wizard.endpoint.trim()) return void tui.actions.emailAccountWizardPatch({ error: "imap endpoint is required" });
      tui.actions.emailAccountWizardPatch({ field: "credential" });
      return;
    }
    if (wizard.field === "credential") {
      tui.actions.emailAccountWizardPatch({ field: "storage" });
      return;
    }
    if (wizard.field === "storage") {
      tui.actions.emailAccountWizardPatch({ field: "review" });
      return;
    }

    let saveInput;
    try {
      saveInput = emailWizardSaveInput(wizard);
    } catch (error) {
      tui.actions.emailAccountWizardPatch({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const operation = operations.begin();
    if (test) {
      probeController?.abort();
      const controller = new AbortController();
      probeController = controller;
      tui.actions.emailAccountWizardPatch({ busy: true, busyKind: "probe", error: undefined, probe: undefined });
      const probe = await port.probeEmailAccount({ account: saveInput, ...(wizard.credential ? { credential: wizard.credential } : {}) }, controller.signal).catch((error) => ({ ok: false, latencyMs: 0, error: error instanceof Error ? error.message : String(error) }));
      if (!operations.owns(operation) || probeController !== controller || controller.signal.aborted || !tui.store.ui.emailAccountWizard || input.isDisposed()) return;
      probeController = undefined;
      tui.actions.emailAccountWizardPatch({ probe });
      if (!probe.ok) {
        tui.actions.emailAccountWizardPatch({ busy: false, busyKind: undefined, error: `${probe.error ?? "email test failed"} · ctrl+s saves without testing` });
        return;
      }
    }
    if (!operations.owns(operation) || !tui.store.ui.emailAccountWizard || input.isDisposed()) return;
    tui.actions.emailAccountWizardPatch({ busy: true, busyKind: "save", error: undefined });
    try {
      const catalog = await port.saveEmailAccount(saveInput);
      if (!operations.owns(operation) || input.isDisposed() || !tui.store.ui.emailAccountWizard) return;
      tui.actions.emailCatalogSet(catalog.accounts);
      tui.actions.emailAccountWizardClose();
      tui.setStatusDetail(`email ${wizard.label.trim().toLowerCase()} saved`, 3_000);
    } catch (error) {
      if (!operations.owns(operation) || input.isDisposed() || !tui.store.ui.emailAccountWizard) return;
      tui.actions.emailAccountWizardPatch({ busy: false, busyKind: undefined, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function back(): void {
    const wizard = tui.store.ui.emailAccountWizard;
    if (!wizard) return;
    if (wizard.busy) {
      if (wizard.busyKind !== "probe") return;
      operations.invalidate();
      probeController?.abort();
      probeController = undefined;
      tui.actions.emailAccountWizardPatch({ busy: false, busyKind: undefined, error: "email test cancelled" });
      return;
    }
    if (wizard.field === "provider") {
      reset();
      tui.actions.emailAccountWizardClose();
      return;
    }
    tui.actions.emailAccountWizardPatch({ field: emailWizardFieldMove(wizard, -1), error: undefined });
  }

  function providerMove(delta: number): void {
    const wizard = tui.store.ui.emailAccountWizard;
    if (!wizard) return;
    const provider = emailProviderMove(wizard.provider, delta);
    const preset = emailProviderPreset(provider);
    tui.actions.emailAccountWizardPatch({ provider, endpoint: `imaps://${preset.host}:${preset.port}`, probe: undefined });
  }

  function storageMove(delta: number): void {
    const wizard = tui.store.ui.emailAccountWizard;
    if (wizard) tui.actions.emailAccountWizardPatch({ storage: emailStorageMove(wizard.storage, delta) });
  }

  function secretBackspace(): void {
    const wizard = tui.store.ui.emailAccountWizard;
    if (wizard?.credential) tui.actions.emailAccountWizardPatch({ credential: [...wizard.credential].slice(0, -1).join(""), removeCredential: false });
  }

  function toggleCredentialRemoval(): void {
    const wizard = tui.store.ui.emailAccountWizard;
    if (wizard) tui.actions.emailAccountWizardPatch({ credential: "", removeCredential: !wizard.removeCredential, error: undefined });
  }

  return {
    reset,
    dispose: reset,
    openAdd,
    openEdit,
    testSelected,
    setRole,
    requestRemoval,
    confirmRemoval,
    cancelRemoval,
    next,
    back,
    providerMove,
    storageMove,
    secretBackspace,
    toggleCredentialRemoval
  };
}
