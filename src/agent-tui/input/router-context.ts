import type { TuiCapabilities } from "../runtime-port";
import type { TuiStoreValue } from "../context/store";
import { isAgentBusy, isAgentCancelable } from "../store";
import { requestOptionCount, requestQuestion } from "../request-user-input-state";
import { slashCommandOptions, slashMatches, slashPopupRowLimit } from "../slash-autocomplete";
import type { RouterContext } from "./router";

type RouterContextInput = {
  tui: TuiStoreValue;
  capabilities: TuiCapabilities;
  composerText: string;
  composerCursor?: number;
  terminalHeight: number;
  modelOverlay?: RouterContext["modelOverlay"];
  mcpOverlay?: RouterContext["mcpOverlay"];
  emailOverlay?: RouterContext["emailOverlay"];
};

export function buildRouterContext(input: RouterContextInput): RouterContext {
  const { tui } = input;
  const top = tui.store.ui.overlayStack.at(-1);
  const centerTop = tui.store.ui.centerSurfaceStack.at(-1);
  const pendingRequest = tui.store.snapshot.pendingUserInput;
  const requestState = tui.store.ui.requestUserInput;
  const pendingQuestion = pendingRequest && requestState?.requestId === pendingRequest.id
    ? requestQuestion(pendingRequest, requestState)
    : undefined;

  return {
    overlayKind: top?.kind,
    centerSurfaceKind: centerTop?.kind,
    centerProxyFlowKind: centerTop?.kind === "proxy_flow" ? centerTop.flow.kind : undefined,
    centerSurfaceBusy: Boolean(tui.store.ui.centerSurfaceBusy),
    running: isAgentBusy(tui.store),
    cancelable: input.capabilities.cancel && isAgentCancelable(tui.store),
    composerText: input.composerText,
    ...(input.composerCursor === undefined ? {} : { composerCursor: input.composerCursor }),
    slashSuppressed: tui.store.ui.slashSuppressedText === input.composerText,
    slashOptionCount: slashMatches(slashCommandOptions(), input.composerText, slashPopupRowLimit(input.terminalHeight)).length,
    historySearchActive: Boolean(tui.store.ui.historySearch),
    queuedCount: tui.store.snapshot.queuedPrompts.length,
    activeMainTab: tui.store.ui.activeMainTab,
    pendingUserInput: Boolean(pendingRequest),
    ...(pendingRequest && requestState && pendingQuestion && !requestState.dismissed ? {
      requestUserInput: {
        textMode: requestState.textModeQuestionId === pendingQuestion.id,
        canExitTextMode: Boolean(pendingQuestion.choices?.length),
        optionCount: requestOptionCount(pendingQuestion),
        submitting: requestState.submitting
      }
    } : {}),
    ...(tui.store.ui.modelProviderWizard ? {
      modelProviderWizard: {
        field: tui.store.ui.modelProviderWizard.field,
        busy: tui.store.ui.modelProviderWizard.busy,
        cancellable: tui.store.ui.modelProviderWizard.busyKind === "probe"
      }
    } : {}),
    ...(tui.store.ui.modelProviderRemoval ? { modelProviderRemoval: { busy: tui.store.ui.modelProviderRemoval.busy } } : {}),
    ...(tui.store.ui.mcpServerWizard ? {
      mcpServerWizard: {
        field: tui.store.ui.mcpServerWizard.field,
        busy: tui.store.ui.mcpServerWizard.busy,
        cancellable: tui.store.ui.mcpServerWizard.busyKind === "probe"
      }
    } : {}),
    ...(tui.store.ui.mcpServerRemoval ? { mcpServerRemoval: { busy: tui.store.ui.mcpServerRemoval.busy } } : {}),
    ...(tui.store.ui.emailAccountWizard ? {
      emailAccountWizard: {
        field: tui.store.ui.emailAccountWizard.field,
        busy: tui.store.ui.emailAccountWizard.busy,
        cancellable: tui.store.ui.emailAccountWizard.busyKind === "probe"
      }
    } : {}),
    ...(tui.store.ui.emailAccountRemoval ? { emailAccountRemoval: { busy: tui.store.ui.emailAccountRemoval.busy } } : {}),
    ...(input.modelOverlay ? { modelOverlay: input.modelOverlay } : {}),
    ...(input.mcpOverlay ? { mcpOverlay: input.mcpOverlay } : {}),
    ...(input.emailOverlay ? { emailOverlay: input.emailOverlay } : {})
  };
}
