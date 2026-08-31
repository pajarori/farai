import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useRenderer, useSelectionHandler } from "@opentui/solid";
import { createEffect, on, onCleanup, type JSX } from "solid-js";
import { useExit, useExiting } from "../context/exit";
import { useTuiRuntime } from "../context/runtime";
import { useTuiStore } from "../context/store";
import { useComposerControl } from "../context/composer";
import { routeKey, toKeyToken, type RouterAction } from "./router";
import { useTuiDimensions } from "../context/terminal";
import { buildRouterContext } from "./router-context";
import { createOverlaySelection } from "./overlay-selection";
import { createModelProviderController } from "./model-provider-controller";
import { createMcpServerController } from "./mcp-server-controller";
import { createEmailAccountController } from "./email-account-controller";
import { createRequestUserInputController } from "./request-user-input-controller";
import { createCenterSurfaceController } from "./center-surface-controller";
import { createOverlayController } from "./overlay-controller";
import { createComposerController } from "./composer-controller";
import { createProxyController } from "./proxy-controller";
import { createTranscriptController } from "./transcript-controller";

export function KeyboardController(): JSX.Element {
  const tui = useTuiStore();
  const composer = useComposerControl();
  const exit = useExit();
  const exiting = useExiting();
  const { port, capabilities } = useTuiRuntime();
  const renderer = useRenderer();
  const dims = useTuiDimensions();
  let sessionEpoch = 0;
  let disposed = false;

  const dialog = {
    push: () => Symbol("unused-dialog"),
    pop: () => { tui.actions.overlayPop(); },
    replace: () => Symbol("unused-dialog"),
    clear: () => { tui.actions.overlayClear(); },
    isTop: () => false,
    stack: () => tui.store.ui.overlayStack
  };
  const commandContext = () => ({ tui, dialog, exit });
  const overlaySelection = createOverlaySelection(tui, commandContext);
  const modelProvider = createModelProviderController({ tui, port, selection: overlaySelection, isDisposed: () => disposed });
  const mcpServer = createMcpServerController({ tui, port, selection: overlaySelection, isDisposed: () => disposed });
  const emailAccount = createEmailAccountController({ tui, port, selection: overlaySelection, isDisposed: () => disposed });
  const requestUserInput = createRequestUserInputController(tui, () => composer.focus());
  const centerSurface = createCenterSurfaceController({ tui, port, captureOwner: captureSessionOwner, owns: ownsSession });
  const composerActions = createComposerController({
    tui,
    composer,
    renderer,
    port,
    exit,
    commandContext,
    terminalHeight: () => dims().height,
    captureOwner: captureSessionOwner,
    owns: ownsSession
  });
  const proxy = createProxyController({ tui, port, captureOwner: captureSessionOwner, owns: ownsSession });
  const transcript = createTranscriptController({ tui, port, captureOwner: captureSessionOwner, owns: ownsSession });
  const overlay = createOverlayController({
    tui,
    port,
    selection: overlaySelection,
    commandContext,
    captureOwner: captureSessionOwner,
    owns: ownsSession,
    openModelProvider: modelProvider.openAdd,
    openMcpServer: mcpServer.openAdd,
    openEmailAccount: emailAccount.openAdd
  });
  let modelOverlayKey: string | undefined;
  let mcpOverlayKey: string | undefined;

  createEffect(on(() => tui.store.activeSessionId, () => {
    sessionEpoch += 1;
    centerSurface.reset();
    proxy.reset();
    transcript.reset();
    modelProvider.reset();
    mcpServer.reset();
    emailAccount.reset();
    overlay.reset();
    composerActions.resetSession();
  }));

  createEffect(on(() => {
    const frame = tui.store.ui.overlayStack.at(-1);
    return frame?.kind === "model" ? frame.providerID ?? "list" : undefined;
  }, (nextModelKey) => {
    if (nextModelKey !== modelOverlayKey) {
      modelOverlayKey = nextModelKey;
      modelProvider.reset();
    }
  }));

  createEffect(on(() => {
    const frame = tui.store.ui.overlayStack.at(-1);
    return frame?.kind === "mcp" ? frame.serverID ?? "list" : undefined;
  }, (nextMcpKey) => {
    if (nextMcpKey !== mcpOverlayKey) {
      mcpOverlayKey = nextMcpKey;
      mcpServer.reset();
    }
  }));

  useKeyboard((event: KeyEvent) => {
    if (exiting()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const key = toKeyToken(event);
    if (!(key.ctrl && key.name === "c")) composerActions.resetQuitConfirmation();
    const text = composer.ref()?.plainText ?? composer.text();
    const top = tui.store.ui.overlayStack.at(-1);
    const cursor = composer.ref()?.cursorOffset;
    const routed = routeKey(key, buildRouterContext({
      tui,
      capabilities,
      composerText: text,
      ...(cursor === undefined ? {} : { composerCursor: cursor }),
      terminalHeight: dims().height,
      ...(top?.kind === "model" ? { modelOverlay: overlaySelection.modelContext() } : {}),
      ...(top?.kind === "mcp" ? { mcpOverlay: overlaySelection.mcpContext() } : {}),
      ...(top?.kind === "email" ? { emailOverlay: overlaySelection.emailContext() } : {})
    }));
    if (routed.type === "passthrough") return;
    event.preventDefault();
    event.stopPropagation();
    for (const action of routed.actions) dispatchAction(action);
  });

  useSelectionHandler((selection) => {
    if (selection.isDragging) return;
    const text = selection.getSelectedText();
    if (!text) return;
    composerActions.copyText(text, "copied selection");
  });

  onCleanup(() => {
    disposed = true;
    sessionEpoch += 1;
    centerSurface.reset();
    proxy.reset();
    transcript.reset();
    overlay.reset();
    composerActions.dispose();
    modelProvider.dispose();
    mcpServer.dispose();
    emailAccount.dispose();
  });

  function dispatchAction(action: RouterAction): void {
    void applyAction(action).catch((error) => {
      if (disposed) return;
      tui.actions.errorSet(error instanceof Error ? error.message : String(error));
    });
  }

  function captureSessionOwner(): { sessionId: string; epoch: number } | undefined {
    const sessionId = tui.store.activeSessionId;
    return sessionId ? { sessionId, epoch: sessionEpoch } : undefined;
  }

  function ownsSession(owner: { sessionId: string; epoch: number }): boolean {
    return !disposed && tui.store.activeSessionId === owner.sessionId && sessionEpoch === owner.epoch;
  }

  async function applyAction(action: RouterAction): Promise<void> {
    switch (action.kind) {
      case "emailAccount.next":
        await emailAccount.next(action.test);
        return;
      case "emailAccount.back":
        emailAccount.back();
        return;
      case "emailAccount.providerMove":
        emailAccount.providerMove(action.delta);
        return;
      case "emailAccount.storageMove":
        emailAccount.storageMove(action.delta);
        return;
      case "emailAccount.secretBackspace":
        emailAccount.secretBackspace();
        return;
      case "emailAccount.credentialRemove":
        emailAccount.toggleCredentialRemoval();
        return;
      case "emailAccountRemoval.confirm":
        await emailAccount.confirmRemoval();
        return;
      case "emailAccountRemoval.cancel":
        emailAccount.cancelRemoval();
        return;
      case "email.add":
        emailAccount.openAdd();
        return;
      case "email.edit":
        emailAccount.openEdit();
        return;
      case "email.test":
        await emailAccount.testSelected();
        return;
      case "email.remove":
        emailAccount.requestRemoval();
        return;
      case "email.primary":
        await emailAccount.setRole("primary");
        return;
      case "email.secondary":
        await emailAccount.setRole("secondary");
        return;
      case "requestUserInput.optionMove": {
        requestUserInput.moveOption(action.delta);
        return;
      }
      case "requestUserInput.choose":
        await requestUserInput.choose(action.index);
        return;
      case "requestUserInput.questionMove":
        requestUserInput.moveQuestion(action.delta);
        return;
      case "requestUserInput.textModeEnter":
        requestUserInput.enterTextMode();
        return;
      case "requestUserInput.textModeExit":
        requestUserInput.exitTextMode();
        return;
      case "requestUserInput.commitText":
        await requestUserInput.commitText();
        return;
      case "requestUserInput.dismiss":
        requestUserInput.dismiss();
        return;
      case "requestUserInput.show":
        requestUserInput.show();
        return;
      case "requestUserInput.cancel":
        await requestUserInput.cancel();
        return;
      case "modelProvider.next":
        await modelProvider.next(action.test);
        return;
      case "modelProvider.back":
        modelProvider.back();
        return;
      case "modelProvider.protocolMove":
        modelProvider.protocolMove(action.delta);
        return;
      case "modelProvider.secretBackspace":
        modelProvider.secretBackspace();
        return;
      case "modelProvider.credentialRemove":
        modelProvider.toggleCredentialRemoval();
        return;
      case "modelProviderRemoval.confirm":
        await modelProvider.confirmRemoval();
        return;
      case "modelProviderRemoval.cancel":
        modelProvider.cancelRemoval();
        return;
      case "model.addProvider":
        modelProvider.openAdd();
        return;
      case "model.editProvider":
        modelProvider.openEdit();
        return;
      case "model.testProvider":
        await modelProvider.testSelected();
        return;
      case "model.removeProvider":
        modelProvider.requestRemoval();
        return;
      case "mcpServer.next":
        await mcpServer.next(action.test);
        return;
      case "mcpServer.back":
        mcpServer.back();
        return;
      case "mcpServer.transportMove":
        mcpServer.transportMove(action.delta);
        return;
      case "mcpServer.authMove":
        mcpServer.authMove(action.delta);
        return;
      case "mcpServer.secretBackspace":
        mcpServer.secretBackspace();
        return;
      case "mcpServer.credentialRemove":
        mcpServer.toggleCredentialRemoval();
        return;
      case "mcpServerRemoval.confirm":
        await mcpServer.confirmRemoval();
        return;
      case "mcpServerRemoval.cancel":
        mcpServer.cancelRemoval();
        return;
      case "mcp.addServer":
        mcpServer.openAdd();
        return;
      case "mcp.editServer":
        mcpServer.openEdit();
        return;
      case "mcp.testServer":
        await mcpServer.testSelected();
        return;
      case "mcp.toggleServer":
        await mcpServer.toggleSelected();
        return;
      case "mcp.removeServer":
        mcpServer.requestRemoval();
        return;
      case "composer.submit":
        await composerActions.submit();
        return;
      case "composer.queue":
        await composerActions.queue();
        return;
      case "composer.newline":
        composer.newline();
        return;
      case "composer.clearOrExit":
        await composerActions.clearOrExit();
        return;
      case "composer.historySearchStart":
        composerActions.startHistorySearch();
        return;
      case "composer.historyNavigate":
        composerActions.navigateHistory(action.direction);
        return;
      case "composer.externalEditor":
        await composerActions.openExternalEditor();
        return;
      case "composer.copyLast":
        composerActions.copyLastAssistantResponse();
        return;
      case "transcript.clear":
        tui.actions.transcriptClear();
        return;
      case "transcript.rawToggle":
        tui.actions.rawOutputToggle();
        return;
      case "mainTab.set":
        await proxy.setMainTab(action.tab);
        return;
      case "proxy.filterSet":
        proxy.setFilter(action.filter);
        return;
      case "proxy.filterCycle":
        proxy.cycleFilter(action.delta);
        return;
      case "proxy.move":
        proxy.move(action.delta);
        return;
      case "proxy.openSelected":
        await proxy.openSelected();
        return;
      case "proxy.detailPaneSet":
        proxy.setDetailPane(action.pane);
        return;
      case "proxy.detailPaneMove":
        proxy.moveDetailPane(action.delta);
        return;
      case "proxy.websocketSectionSet":
        proxy.setWebSocketSection(action.section);
        return;
      case "proxy.websocketMessageMove":
        proxy.moveWebSocketMessage(action.delta);
        return;
      case "queued.editLast":
        await composerActions.editLastQueued();
        return;
      case "turn.cancel":
        if (!capabilities.cancel) {
          tui.actions.errorSet("turn cancellation is unavailable in this TUI session");
          return;
        }
        await tui.cancelCurrentTurn();
        await composerActions.restoreQueuedAfterCancel();
        return;
      case "message.nav":
        tui.actions.messageNavigationRequested(action.direction);
        return;
      case "overlay.open":
        await overlay.open(action.overlay);
        return;
      case "overlay.pop":
        overlay.pop();
        return;
      case "overlay.move":
        overlay.move(action.delta);
        return;
      case "overlay.setIndex":
        overlay.setIndex(action.index);
        return;
      case "overlay.agentPreview":
        overlay.toggleAgentPreview();
        return;
      case "overlay.appendQuery":
        overlay.appendQuery(action.char);
        return;
      case "overlay.backspaceQuery":
        overlay.backspaceQuery();
        return;
      case "overlay.select":
        await overlay.select();
        return;
      case "center.pop":
        centerSurface.pop();
        return;
      case "center.scroll":
        tui.actions.centerScrollRequested(action.action);
        return;
      case "center.action":
        await centerSurface.run(action.action);
        return;
      case "slash.move":
        tui.actions.slashIndexMove(action.delta, composerActions.slashMatchCount());
        return;
      case "slash.dismiss":
        composerActions.dismissSlash();
        return;
      case "slash.complete":
        composerActions.completeSlash();
        return;
      case "slash.dispatch":
        await composerActions.dispatchSlash();
        return;
      case "history.searchAppend":
        composerActions.appendHistorySearch(action.char);
        return;
      case "history.searchBackspace":
        composerActions.backspaceHistorySearch();
        return;
      case "history.searchMove":
        composerActions.moveHistorySearch(action.delta);
        return;
      case "history.searchAccept":
        composerActions.acceptHistorySearch();
        return;
      case "history.searchCancel":
        composerActions.cancelHistorySearch();
        return;
      case "footer.shortcutsToggle":
        tui.actions.footerModeSet(tui.store.ui.footerMode === "shortcuts" ? "ambient" : "shortcuts");
        return;
      case "footer.escHint":
        tui.actions.footerModeSet("esc_hint");
        return;
      case "transcript.open":
        await transcript.open();
        return;
    }
  }

  return <></>;
}
