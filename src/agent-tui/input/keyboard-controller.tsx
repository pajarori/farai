import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useRenderer, useSelectionHandler } from "@opentui/solid";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEffect, onCleanup, type JSX } from "solid-js";
import { useExit } from "../context/exit";
import { useTuiRuntime } from "../context/runtime";
import { useTuiStore } from "../context/store";
import { useComposerControl } from "../context/composer";
import { findSlashCommand, isVisibleSlashCommand, listCommands, type Command } from "../command-registry";
import type { DialogOption } from "../dialog/fuzzy";
import { filterOptions } from "../dialog/fuzzy";
import { overlayOptions, type ModelChoice } from "../overlay-options";
import type { AgentThreadSummary } from "../runtime-port";
import { rememberModelSelection } from "../../agent-core/model-catalog";
import { slashCompletionOption, slashMatches } from "../slash-autocomplete";
import { routeKey, toKeyToken, type RouterAction } from "./router";
import { projectMessagesToRows, truncateLine, type TimelineRow } from "../renderers";
import { writeClipboard } from "../clipboard";
import { isAgentBusy, isAgentCancelable, proxyFlowsForFilter } from "../store";
import { ctrlCDecision } from "./interrupt";
import { requestOptionCount, requestOptionIndex, requestQuestion } from "../request-user-input-state";
import { modelProviderProtocolMove, modelProviderWizardFieldMove } from "../model-provider-state";

const QUIT_CONFIRMATION_MS = 1_500;

export function KeyboardController(): JSX.Element {
  const tui = useTuiStore();
  const composer = useComposerControl();
  const exit = useExit();
  const { port, capabilities } = useTuiRuntime();
  const renderer = useRenderer();
  let historyNavIndex = -1;
  let historyNavOriginalDraft = "";
  let quitArmedUntil = 0;
  let quitTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionEpoch = 0;
  let proxyFlowLoadGeneration = 0;
  let transcriptLoadGeneration = 0;
  let disposed = false;
  let modelProviderProbeController: AbortController | undefined;

  createEffect(() => {
    void tui.store.activeSessionId;
    sessionEpoch += 1;
    historyNavIndex = -1;
    historyNavOriginalDraft = "";
  });

  const dialog = {
    push: () => Symbol("unused-dialog"),
    pop: () => { tui.actions.overlayPop(); },
    replace: () => Symbol("unused-dialog"),
    clear: () => { tui.actions.overlayClear(); },
    isTop: () => false,
    stack: () => tui.store.ui.overlayStack
  };
  const commandContext = () => ({ tui, dialog, exit });

  useKeyboard((event: KeyEvent) => {
    const key = toKeyToken(event);
    if (!(key.ctrl && key.name === "c")) resetQuitConfirmation();
    const text = composer.ref()?.plainText ?? composer.text();
    const top = tui.store.ui.overlayStack.at(-1);
    const centerTop = tui.store.ui.centerSurfaceStack.at(-1);
    const pendingRequest = tui.store.snapshot.pendingUserInput;
    const requestState = tui.store.ui.requestUserInput;
    const pendingQuestion = pendingRequest && requestState?.requestId === pendingRequest.id
      ? requestQuestion(pendingRequest, requestState)
      : undefined;
    const cursor = composer.ref()?.cursorOffset;
    const modelOverlay = top?.kind === "model" ? selectedModelProviderContext() : undefined;
    const routed = routeKey(key, {
      overlayKind: top?.kind,
      centerSurfaceKind: centerTop?.kind,
      centerProxyFlowKind: centerTop?.kind === "proxy_flow" ? centerTop.flow.kind : undefined,
      running: isAgentBusy(tui.store),
      cancelable: capabilities.cancel && isAgentCancelable(tui.store),
      composerText: text,
      ...(cursor === undefined ? {} : { composerCursor: cursor }),
      slashSuppressed: tui.store.ui.slashSuppressedText === text,
      slashOptionCount: slashMatches(currentSlashOptions(), text).length,
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
          busy: tui.store.ui.modelProviderWizard.busy
        }
      } : {}),
      ...(tui.store.ui.modelProviderRemoval ? { modelProviderRemoval: true } : {}),
      ...(modelOverlay ? { modelOverlay } : {})
    });
    if (routed.type === "passthrough") return;
    event.preventDefault();
    event.stopPropagation();
    for (const action of routed.actions) dispatchAction(action);
  });

  useSelectionHandler((selection) => {
    if (selection.isDragging) return;
    const text = selection.getSelectedText();
    if (!text) return;
    copyTextToClipboard(text, "copied selection");
  });

  onCleanup(() => {
    disposed = true;
    sessionEpoch += 1;
    proxyFlowLoadGeneration += 1;
    transcriptLoadGeneration += 1;
    if (quitTimer) clearTimeout(quitTimer);
    modelProviderProbeController?.abort();
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
      case "requestUserInput.optionMove": {
        const current = currentUserInputQuestion();
        if (current) tui.actions.requestUserInputOptionMove(current.question.id, action.delta, requestOptionCount(current.question));
        return;
      }
      case "requestUserInput.choose":
        await chooseUserInputOption(action.index);
        return;
      case "requestUserInput.questionMove":
        tui.actions.requestUserInputQuestionMove(action.delta);
        return;
      case "requestUserInput.textModeEnter": {
        const current = currentUserInputQuestion();
        if (!current) return;
        if (!current.state.drafts[current.question.id] && current.state.answers[current.question.id]) {
          tui.actions.requestUserInputDraftSet(current.question.id, current.state.answers[current.question.id]!);
        }
        tui.actions.requestUserInputTextModeSet(current.question.id);
        return;
      }
      case "requestUserInput.textModeExit":
        tui.actions.requestUserInputTextModeSet(undefined);
        return;
      case "requestUserInput.commitText": {
        const current = currentUserInputQuestion();
        if (!current) return;
        const draft = current.state.drafts[current.question.id]?.trim() ?? "";
        if (!draft) {
          tui.actions.errorSet("enter an answer before continuing");
          return;
        }
        await tui.answerUserInputQuestion(current.question.id, draft);
        return;
      }
      case "requestUserInput.dismiss":
        tui.actions.requestUserInputDismissedSet(true);
        composer.focus();
        return;
      case "requestUserInput.show":
        tui.actions.requestUserInputDismissedSet(false);
        return;
      case "requestUserInput.cancel":
        await tui.cancelUserInput();
        return;
      case "modelProvider.next":
        await advanceModelProviderWizard(action.test);
        return;
      case "modelProvider.back":
        backModelProviderWizard();
        return;
      case "modelProvider.protocolMove": {
        const wizard = tui.store.ui.modelProviderWizard;
        if (wizard) tui.actions.modelProviderWizardPatch({ protocol: modelProviderProtocolMove(wizard.protocol, action.delta) });
        return;
      }
      case "modelProvider.secretBackspace": {
        const wizard = tui.store.ui.modelProviderWizard;
        if (wizard?.apiKey) tui.actions.modelProviderWizardPatch({ apiKey: [...wizard.apiKey].slice(0, -1).join(""), removeCredential: false });
        return;
      }
      case "modelProvider.credentialRemove": {
        const wizard = tui.store.ui.modelProviderWizard;
        if (wizard) tui.actions.modelProviderWizardPatch({ apiKey: "", removeCredential: !wizard.removeCredential, error: undefined });
        return;
      }
      case "modelProviderRemoval.confirm":
        await removePendingModelProvider();
        return;
      case "modelProviderRemoval.cancel":
        tui.actions.modelProviderRemovalClose();
        return;
      case "model.addProvider":
        tui.actions.modelProviderWizardOpen();
        return;
      case "model.editProvider": {
        const provider = selectedModelProvider();
        if (provider?.removable) tui.actions.modelProviderWizardOpen(provider);
        return;
      }
      case "model.testProvider":
        await testSelectedModelProvider();
        return;
      case "model.removeProvider":
        confirmSelectedModelProviderRemoval();
        return;
      case "composer.submit":
        await submitComposer();
        return;
      case "composer.queue":
        await queueComposer();
        return;
      case "composer.newline":
        composer.newline();
        return;
      case "composer.clearOrExit":
        await handleCtrlC();
        return;
      case "composer.historySearchStart":
        resetPromptHistoryNavigation();
        tui.actions.historySearchStart(composer.ref()?.plainText ?? composer.text());
        applyHistoryPreview();
        return;
      case "composer.historyNavigate":
        applyPromptHistoryNavigation(action.direction);
        return;
      case "composer.externalEditor":
        await openExternalEditor();
        return;
      case "composer.copyLast":
        copyLastAssistantResponse();
        return;
      case "transcript.clear":
        tui.actions.transcriptClear();
        return;
      case "transcript.rawToggle":
        tui.actions.rawOutputToggle();
        return;
      case "mainTab.set":
        tui.actions.mainTabSet(action.tab);
        if (action.tab === "proxy") await tui.refreshProxyFlows();
        return;
      case "proxy.filterSet":
        tui.actions.proxyFilterSet(action.filter);
        return;
      case "proxy.filterCycle":
        tui.actions.proxyFilterCycle(action.delta);
        return;
      case "proxy.move":
        tui.actions.proxySelectedMove(action.delta);
        return;
      case "proxy.openSelected":
        await openSelectedProxyFlow();
        return;
      case "proxy.detailPaneSet":
        tui.actions.proxyDetailPaneSet(action.pane);
        return;
      case "proxy.detailPaneMove":
        tui.actions.proxyDetailPaneMove(action.delta);
        return;
      case "proxy.websocketSectionSet": {
        const frame = tui.store.ui.centerSurfaceStack.at(-1);
        if (frame?.kind === "proxy_flow" && frame.flow.kind === "websocket") {
          tui.actions.proxyWebSocketSectionSet(action.section);
        } else {
          tui.actions.proxyDetailPaneSet(action.section);
        }
        return;
      }
      case "proxy.websocketMessageMove":
        tui.actions.proxyWebSocketMessageMove(action.delta);
        return;
      case "queued.editLast":
        await editLastQueuedPrompt();
        return;
      case "turn.cancel":
        if (!capabilities.cancel) {
          tui.actions.errorSet("turn cancellation is unavailable in this TUI session");
          return;
        }
        await tui.cancelCurrentTurn();
        await restoreQueuedInputsAfterCancel();
        return;
      case "message.nav":
        tui.actions.messageNavigationRequested(action.direction);
        return;
      case "overlay.open":
        tui.actions.overlayOpen(action.overlay);
        if (action.overlay === "sessions") await tui.refreshSessions();
        return;
      case "overlay.pop":
        tui.actions.overlayPop();
        return;
      case "overlay.move":
        tui.actions.overlayMove(action.delta, currentOverlayOptionCount());
        return;
      case "overlay.setIndex":
        tui.actions.overlaySetIndex(action.index, currentOverlayOptionCount());
        return;
      case "overlay.agentPreview":
        toggleSelectedAgentPreview();
        return;
      case "overlay.appendQuery":
        tui.actions.overlayAppendQuery(action.char);
        return;
      case "overlay.backspaceQuery":
        tui.actions.overlayBackspaceQuery();
        return;
      case "overlay.select":
        await selectOverlay();
        return;
      case "center.pop":
        tui.actions.centerSurfacePop();
        return;
      case "center.scroll":
        tui.actions.centerScrollRequested(action.action);
        return;
      case "center.action":
        await runCenterSurfaceAction(action.action);
        return;
      case "slash.move":
        tui.actions.slashIndexMove(action.delta, currentSlashOptions().length);
        return;
      case "slash.dismiss":
        tui.actions.slashSuppress(composer.ref()?.plainText ?? composer.text());
        return;
      case "slash.complete":
        completeSlash();
        return;
      case "slash.dispatch":
        await dispatchSlash();
        return;
      case "history.searchAppend":
        tui.actions.historySearchAppend(action.char);
        applyHistoryPreview();
        return;
      case "history.searchBackspace":
        tui.actions.historySearchBackspace();
        applyHistoryPreview();
        return;
      case "history.searchMove":
        tui.actions.historySearchMove(action.delta, currentHistoryMatches().length);
        applyHistoryPreview();
        return;
      case "history.searchAccept":
        tui.actions.historySearchStop();
        composer.focus();
        return;
      case "history.searchCancel": {
        const original = tui.store.ui.historySearch?.originalDraft ?? "";
        tui.actions.historySearchStop();
        composer.setDraft(original);
        composer.focus();
        return;
      }
      case "footer.shortcutsToggle":
        tui.actions.footerModeSet(tui.store.ui.footerMode === "shortcuts" ? "ambient" : "shortcuts");
        return;
      case "footer.escHint":
        tui.actions.footerModeSet("esc_hint");
        return;
      case "transcript.open":
        await openFullTranscript();
        return;
    }
  }

  function currentUserInputQuestion() {
    const request = tui.store.snapshot.pendingUserInput;
    const state = tui.store.ui.requestUserInput;
    if (!request || !state || state.requestId !== request.id) return undefined;
    const question = requestQuestion(request, state);
    return question ? { request, state, question } : undefined;
  }

  async function chooseUserInputOption(explicitIndex?: number): Promise<void> {
    const current = currentUserInputQuestion();
    if (!current || current.state.submitting) return;
    const choices = current.question.choices ?? [];
    if (choices.length === 0) {
      tui.actions.requestUserInputTextModeSet(current.question.id);
      return;
    }
    const index = explicitIndex ?? requestOptionIndex(current.question, current.state);
    tui.actions.requestUserInputOptionSet(current.question.id, index, requestOptionCount(current.question));
    const choice = choices[index];
    if (!choice) {
      tui.actions.requestUserInputTextModeSet(current.question.id);
      return;
    }
    await tui.answerUserInputQuestion(current.question.id, choice.label);
  }

  async function handleCtrlC(): Promise<void> {
    const text = composer.ref()?.plainText ?? composer.text();
    const decision = ctrlCDecision(text, quitArmedUntil);
    if (decision === "clear") {
      resetQuitConfirmation();
      composer.clear();
      return;
    }
    if (decision === "arm") {
      quitArmedUntil = Date.now() + QUIT_CONFIRMATION_MS;
      tui.actions.footerModeSet("quit_hint");
      if (quitTimer) clearTimeout(quitTimer);
      quitTimer = setTimeout(() => resetQuitConfirmation(), QUIT_CONFIRMATION_MS);
      return;
    }
    resetQuitConfirmation();
    await exit();
  }

  function resetQuitConfirmation(): void {
    quitArmedUntil = 0;
    if (quitTimer) clearTimeout(quitTimer);
    quitTimer = undefined;
    if (tui.store.ui.footerMode === "quit_hint") tui.actions.footerModeSet("ambient");
  }

  async function submitComposer(): Promise<void> {
    const text = normalizeComposerText(composer.expandedText());
    if (!text.trim()) return;
    resetPromptHistoryNavigation();
    if (text.startsWith("/") && await submitSlashInvocation(text)) return;
    if (tui.submitPrompt(text)) composer.clear();
  }

  async function queueComposer(): Promise<void> {
    const text = normalizeComposerText(composer.expandedText());
    if (!text.trim()) return;
    resetPromptHistoryNavigation();
    if (text.startsWith("/") && await queueSlashInvocation(text)) return;
    if (tui.queuePrompt(text)) composer.clear();
  }

  async function queueSlashInvocation(rawText: string): Promise<boolean> {
    const trimmed = rawText.trim();
    const command = findSlashCommand(trimmed);
    if (!command) return false;
    if (command.name === "session.compact") {
      composer.clear();
      await tui.compact(trimmed.slice("/compact".length).trim() || undefined);
      return true;
    }
    if (command.name === "session.clear") {
      composer.clear();
      await tui.clearCurrentSession();
      return true;
    }
    if (command.slashBehavior === "local") {
      composer.clear();
      await command.run(commandContext());
      return true;
    }
    return false;
  }

  function resetPromptHistoryNavigation(): void {
    historyNavIndex = -1;
    historyNavOriginalDraft = "";
  }

  function applyPromptHistoryNavigation(direction: "older" | "newer"): void {
    const entries = tui.store.ui.promptHistory.map((entry) => entry.text);
    if (entries.length === 0) return;
    if (historyNavIndex < 0) historyNavOriginalDraft = composer.ref()?.plainText ?? composer.text();
    historyNavIndex = direction === "older"
      ? Math.min(entries.length - 1, historyNavIndex + 1)
      : Math.max(-1, historyNavIndex - 1);
    composer.setDraft(historyNavIndex < 0 ? historyNavOriginalDraft : entries[historyNavIndex] ?? historyNavOriginalDraft);
    composer.focus();
  }

  async function editLastQueuedPrompt(): Promise<void> {
    const owner = captureSessionOwner();
    if (!owner) return;
    const queued = port.takeBackQueuedInput(owner.sessionId);
    if (!queued) return;
    tui.actions.snapshotPatched({
      queuedPrompts: tui.store.snapshot.queuedPrompts.filter((item) => item.id !== queued.id)
    });
    composer.setDraft(queued.text);
    composer.focus();
    try {
      const activity = await port.loadActivityState(owner.sessionId);
      if (ownsSession(owner)) tui.actions.snapshotPatched(activity);
    } catch {
    }
  }

  async function restoreQueuedInputsAfterCancel(): Promise<void> {
    const owner = captureSessionOwner();
    if (!owner) return;
    const restored = [];
    while (true) {
      const queued = port.takeBackQueuedInput(owner.sessionId);
      if (!queued) break;
      restored.push(queued);
    }
    if (restored.length === 0 || !ownsSession(owner)) return;
    restored.reverse();
    const restoredIds = new Set(restored.map((item) => item.id));
    tui.actions.snapshotPatched({
      queuedPrompts: tui.store.snapshot.queuedPrompts.filter((item) => !restoredIds.has(item.id))
    });
    const currentDraft = composer.ref()?.plainText ?? composer.text();
    composer.setDraft([...restored.map((item) => item.text), currentDraft].filter((text) => text.trim()).join("\n"));
    composer.focus();
    try {
      const activity = await port.loadActivityState(owner.sessionId);
      if (ownsSession(owner)) tui.actions.snapshotPatched(activity);
    } catch {
    }
  }

  function copyLastAssistantResponse(): void {
    const text = lastAssistantText();
    if (!text) {
      tui.setStatusDetail("nothing to copy", 2_000);
      return;
    }
    copyTextToClipboard(text, "copied last response");
  }

  function copyTextToClipboard(text: string, successMessage: string): void {
    let copied = false;
    try { copied = renderer.copyToClipboardOSC52(text); } catch { copied = false; }
    if (!copied) copied = writeClipboard(text).ok;
    tui.setStatusDetail(copied ? successMessage : "copy failed", 2_000);
  }

  async function openSelectedProxyFlow(): Promise<void> {
    const owner = captureSessionOwner();
    if (!owner) return;
    const generation = ++proxyFlowLoadGeneration;
    const flow = proxyFlowsForFilter(tui.store.ui.proxyFlows, tui.store.ui.proxyFilter)[tui.store.ui.proxySelectedIndex];
    if (!flow) return;
    const status = "loading proxy flow";
    tui.setStatusDetail(status);
    try {
      const detail = await port.getProxyFlow(flow.id);
      if (generation !== proxyFlowLoadGeneration || !ownsSession(owner)) return;
      if (detail) {
        tui.actions.centerSurfacePush({ kind: "proxy_flow", flow: detail });
        return;
      }
      tui.actions.centerSurfacePush({
        kind: "detail",
        title: `${flow.method} ${flow.status ?? "-"} ${flow.host}`,
        body: `No stored detail for flow ${flow.id}.`
      });
    } finally {
      if (generation === proxyFlowLoadGeneration && ownsSession(owner) && tui.store.ui.statusDetail === status) {
        tui.setStatusDetail(undefined);
      }
    }
  }

  function currentOverlayOptions(): DialogOption<unknown>[] {
    const frame = tui.store.ui.overlayStack.at(-1);
    if (!frame || !("query" in frame)) return [];
    return filterOptions(overlayOptions(frame, tui, commandContext()), frame.query)
      .map((match) => match.option)
      .filter((option) => !option.disabled) as DialogOption<unknown>[];
  }

  function currentOverlayOptionCount(): number {
    return currentOverlayOptions().length;
  }

  function selectedModelProvider() {
    const frame = tui.store.ui.overlayStack.at(-1);
    if (frame?.kind !== "model") return undefined;
    const option = currentOverlayOptions()[frame.index];
    const choice = option?.value as ModelChoice | undefined;
    const providerID = frame.providerID ?? (choice?.kind === "model_provider" ? choice.providerID : undefined);
    return providerID ? tui.store.ui.modelProviders.find((provider) => provider.id === providerID) : undefined;
  }

  function selectedModelProviderContext(): { providerID?: string; removable: boolean } {
    const provider = selectedModelProvider();
    return provider ? { providerID: provider.id, removable: provider.removable } : { removable: false };
  }

  async function testSelectedModelProvider(): Promise<void> {
    const provider = selectedModelProvider();
    if (!provider) return;
    tui.setStatusDetail(`testing ${provider.id}`);
    const result = await port.probeModelProvider({ providerID: provider.id });
    tui.setStatusDetail(result.ok
      ? `${provider.id}: ${result.models.length} models · ${result.latencyMs}ms`
      : `${provider.id}: ${result.error ?? "probe failed"}`, 4_000);
  }

  function confirmSelectedModelProviderRemoval(): void {
    const provider = selectedModelProvider();
    if (!provider?.removable) return;
    tui.actions.modelProviderRemovalOpen(provider);
  }

  async function removePendingModelProvider(): Promise<void> {
    const provider = tui.store.ui.modelProviderRemoval;
    if (!provider) return;
    const result = await port.removeModelProvider(provider.id);
    tui.actions.modelProviderRemovalClose();
    await Promise.all([tui.refreshAvailableModels(), tui.refreshSessions(), tui.refreshSnapshot()]);
    tui.actions.overlayClear();
    tui.actions.overlayPush({ kind: "model", query: "", index: 0 });
    const removal = result.providerRemains ? `removed ${result.location} override for ${result.id}` : `removed ${result.id}`;
    tui.setStatusDetail(`${removal} · ${result.updatedSessions} sessions moved to ${result.fallbackModel}`, 4_000);
  }

  function toggleSelectedAgentPreview(): void {
    const frame = tui.store.ui.overlayStack.at(-1);
    if (frame?.kind !== "agents") return;
    const option = currentOverlayOptions()[frame.index];
    if (option) tui.actions.agentDetailToggle(option.id);
  }

  async function selectOverlay(): Promise<void> {
    const frame = tui.store.ui.overlayStack.at(-1);
    if (!frame || !("query" in frame)) return;
    const option = currentOverlayOptions()[frame.index];
    if (!option) return;
    switch (frame.kind) {
      case "palette":
        tui.actions.overlayPop();
        await (option.value as Command).run(commandContext());
        return;
      case "sessions":
        tui.actions.overlayClear();
        await tui.selectSession(String(option.value));
        return;
      case "agents":
        tui.actions.overlayClear();
        await tui.selectSession((option.value as AgentThreadSummary).sessionId);
        return;
      case "evidence": {
        const item = tui.store.snapshot.evidence.find((candidate) => candidate.id === option.value);
        if (item) {
          const metadata = [
            `source: ${item.source}`,
            item.path ? `path: ${item.path}` : undefined,
            item.createdAt ? `captured: ${item.createdAt}` : undefined
          ].filter((value): value is string => Boolean(value));
          tui.actions.centerSurfaceReplaceTop({
            kind: "detail",
            title: item.title,
            body: [...metadata, "", "## evidence", item.summary || "no evidence summary recorded"].join("\n")
          });
        }
        return;
      }
      case "findings": {
        const item = tui.store.snapshot.findings.find((candidate) => candidate.id === option.value);
        if (item) tui.actions.centerSurfaceReplaceTop({
          kind: "detail",
          title: `${item.severity.toLowerCase()} · ${item.title}`,
          body: [
            `target: ${item.target || "not recorded"}`,
            item.status ? `status: ${item.status}` : undefined,
            `evidence: ${item.evidenceIds.length} linked item${item.evidenceIds.length === 1 ? "" : "s"}`,
            "",
            "## impact",
            item.impact || "not recorded",
            "",
            "## reproduction",
            item.reproduction || "not recorded",
            "",
            "## remediation",
            item.remediation || "not recorded"
          ].filter((value): value is string => value !== undefined).join("\n")
        });
        return;
      }
      case "memory": {
        const item = tui.store.snapshot.memory.find((candidate) => candidate.id === option.value);
        if (item) tui.actions.centerSurfaceReplaceTop({ kind: "detail", title: `${item.kind} · ${item.key}`, body: memoryDetailBody(item.value) });
        return;
      }
      case "mcp":
        return;
      case "model": {
        const choice = option.value as ModelChoice;
        if (choice.kind === "model_action") {
          tui.actions.modelProviderWizardOpen();
          return;
        }
        if (choice.kind === "model_provider") {
          tui.actions.overlayPush({ kind: "model", providerID: choice.providerID, query: "", index: 0 });
          return;
        }
        const owner = captureSessionOwner();
        if (!owner) return;
        if (choice.kind !== "model") return;
        await port.updateSession(owner.sessionId, { model: choice.model });
        await rememberModelSelection(choice.model, {
          workspace: tui.store.workspace,
          ...(choice.providerID ? { providerID: choice.providerID } : {}),
          ...(choice.contextWindow ? { contextWindow: choice.contextWindow } : {}),
          ...(choice.maxOutputTokens ? { maxOutputTokens: choice.maxOutputTokens } : {})
        });
        if (!ownsSession(owner)) return;
        await tui.refreshSnapshot();
        if (!ownsSession(owner)) return;
        await tui.refreshSessions();
        if (!ownsSession(owner)) return;
        tui.setStatusDetail(`model: ${choice.model}`, 2_000);
        tui.actions.overlayClear();
        return;
      }
    }
  }

  async function runCenterSurfaceAction(action: string): Promise<void> {
    const frame = tui.store.ui.centerSurfaceStack.at(-1);
    if (!frame) return;
    if (frame.kind === "confirm" && action === "confirm") {
      tui.actions.centerSurfacePop();
      return;
    }
    if (frame.kind === "report" && action === "save") {
      const owner = captureSessionOwner();
      if (!owner) return;
      const result = await port.exportReport(owner.sessionId, { write: true });
      if (!ownsSession(owner)) return;
      tui.actions.centerSurfacePush({ kind: "detail", title: "report saved", body: result.path ?? "saved" });
      return;
    }
    if (frame.kind === "container" && action === "toggle") {
      await tui.toggleContainer();
      tui.actions.centerSurfaceReplaceTop({ kind: "container", refreshToken: (frame.refreshToken ?? 0) + 1 });
      return;
    }
    if (frame.kind === "container" && action === "refresh") {
      await tui.refreshContainerStatus();
      tui.actions.centerSurfaceReplaceTop({ kind: "container", refreshToken: (frame.refreshToken ?? 0) + 1 });
    }
  }

  async function advanceModelProviderWizard(test = true): Promise<void> {
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
      tui.actions.modelProviderWizardPatch({ field: "protocol" });
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

    if (test) {
      modelProviderProbeController?.abort();
      const controller = new AbortController();
      modelProviderProbeController = controller;
      tui.actions.modelProviderWizardPatch({ busy: true, error: undefined, probe: undefined });
      const probe = await port.probeModelProvider({
        baseUrl: wizard.baseUrl,
        protocol: wizard.protocol,
        ...(wizard.apiKey ? { apiKey: wizard.apiKey } : {}),
        timeoutMs: 8_000
      }, controller.signal);
      if (modelProviderProbeController !== controller || !tui.store.ui.modelProviderWizard) return;
      modelProviderProbeController = undefined;
      tui.actions.modelProviderWizardPatch({ busy: false, probe });
      if (!probe.ok) {
        tui.actions.modelProviderWizardPatch({ error: `${probe.error ?? "provider probe failed"} · ctrl+s saves without testing` });
        return;
      }
      if (!wizard.model.trim() && probe.models.length === 1) tui.actions.modelProviderWizardPatch({ model: probe.models[0]! });
    }

    const current = tui.store.ui.modelProviderWizard;
    if (!current) return;
    const catalog = await port.saveModelProvider({
      id: current.id,
      baseUrl: current.baseUrl,
      protocol: current.protocol,
      ...(current.model.trim() ? { model: current.model.trim() } : {}),
      ...(current.apiKey ? { apiKey: current.apiKey, credentialAction: "replace" as const } : current.removeCredential ? { credentialAction: "remove" as const } : { credentialAction: "keep" as const }),
      location: current.location
    });
    tui.actions.modelCatalogSet(catalog.providers, catalog.models);
    tui.actions.modelProviderWizardClose();
    tui.setStatusDetail(`provider ${current.id.trim().toLowerCase()} saved`, 3_000);
  }

  function backModelProviderWizard(): void {
    const wizard = tui.store.ui.modelProviderWizard;
    if (!wizard) return;
    if (wizard.busy) {
      modelProviderProbeController?.abort();
      modelProviderProbeController = undefined;
      tui.actions.modelProviderWizardPatch({ busy: false, error: "provider probe cancelled" });
      return;
    }
    if ((wizard.mode === "add" && wizard.field === "id") || (wizard.mode === "edit" && wizard.field === "protocol")) {
      tui.actions.modelProviderWizardClose();
      return;
    }
    tui.actions.modelProviderWizardPatch({ field: modelProviderWizardFieldMove(wizard.field, -1), error: undefined });
  }

  function currentSlashOptions(): DialogOption<Command>[] {
    return listCommands()
      .filter((command) => command.slashName && isVisibleSlashCommand(command))
      .map((command) => ({ id: command.name, title: `/${command.slashName ?? command.name}`, ...(command.desc ? { description: command.desc } : {}), value: command }));
  }

  function completeSlash(): void {
    const text = composer.ref()?.plainText ?? composer.text();
    const completion = slashCompletionOption(currentSlashOptions(), text, tui.store.ui.slashIndex);
    if (!completion) return;
    composer.setDraft(`${completion.title} `);
    tui.actions.slashSuppress(undefined);
    composer.focus();
  }

  async function dispatchSlash(): Promise<void> {
    const text = normalizeComposerText(composer.expandedText());
    const completion = slashCompletionOption(currentSlashOptions(), text, tui.store.ui.slashIndex);
    const command = completion?.value ?? findSlashCommand(text);
    const promptText = slashPromptText(text, completion?.title, command?.slashName);
    if (!command) return;
    if (command.slashBehavior === "local") {
      composer.clear();
      await command.run(commandContext());
    } else if (tui.submitPrompt(promptText)) {
      composer.clear();
    }
  }

  async function submitSlashInvocation(rawText: string): Promise<boolean> {
    const trimmed = rawText.trim();
    if (!trimmed.startsWith("/")) return false;
    const command = findSlashCommand(trimmed);
    if (!command) return false;
    if (command.name === "session.compact") {
      composer.clear();
      await tui.compact(trimmed.slice("/compact".length).trim() || undefined);
    } else if (command.slashBehavior === "local") {
      composer.clear();
      await command.run(commandContext());
    } else if (tui.submitPrompt(trimmed)) {
      composer.clear();
    }
    return true;
  }

  function currentHistoryMatches(): string[] {
    const search = tui.store.ui.historySearch;
    const entries = tui.store.ui.promptHistory.map((entry) => entry.text);
    if (!search?.query.trim()) return entries;
    const needle = search.query.toLowerCase();
    return entries.filter((entry) => entry.toLowerCase().includes(needle));
  }

  function applyHistoryPreview(): void {
    const search = tui.store.ui.historySearch;
    if (!search) return;
    const matches = currentHistoryMatches();
    const preview = matches[search.index] ?? search.originalDraft;
    composer.setDraft(preview);
  }

  async function openExternalEditor(): Promise<void> {
    const editor = process.env.VISUAL || process.env.EDITOR;
    if (!editor) {
      tui.actions.centerSurfacePush({
        kind: "detail",
        title: "external editor",
        body: "set VISUAL or EDITOR before starting farai to edit the current draft externally."
      });
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "farai-editor-"));
    const file = join(dir, "prompt.md");
    writeFileSync(file, composer.ref()?.plainText ?? composer.text());
    composer.blur();
    try {
      renderer.suspend();
      const proc = Bun.spawn(["sh", "-lc", `${editor} ${shellQuote(file)}`], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit"
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        tui.actions.centerSurfacePush({
          kind: "detail",
          title: "external editor",
          body: `${editor} exited with code ${exitCode}. draft was not changed.`
        });
        return;
      }
      composer.setDraft(readFileSync(file, "utf8").trimEnd());
    } catch (error) {
      tui.actions.centerSurfacePush({
        kind: "detail",
        title: "external editor",
        body: error instanceof Error ? error.message : String(error)
      });
    } finally {
      try { renderer.resume(); } catch {  }
      try { rmSync(dir, { recursive: true, force: true }); } catch {  }
      if (tui.store.ui.overlayStack.length === 0 && tui.store.ui.centerSurfaceStack.length === 0) composer.focus();
      else composer.blur();
    }
  }

  async function openFullTranscript(): Promise<void> {
    const owner = captureSessionOwner();
    if (!owner) return;
    const generation = ++transcriptLoadGeneration;
    const status = "loading transcript";
    tui.setStatusDetail(status);
    try {
      const messages = await port.loadFullMessages(owner.sessionId);
      if (generation !== transcriptLoadGeneration || !ownsSession(owner)) return;
      tui.actions.centerSurfacePush({ kind: "detail", title: "transcript", body: transcriptMarkdown(messages) });
    } catch (error) {
      if (generation === transcriptLoadGeneration && ownsSession(owner)) {
        tui.actions.errorSet(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (generation === transcriptLoadGeneration && ownsSession(owner) && tui.store.ui.statusDetail === status) {
        tui.setStatusDetail(undefined);
      }
    }
  }

  function transcriptMarkdown(messages = tui.store.snapshot.messages): string {
    const rows = projectMessagesToRows(
      messages,
      160,
      tui.store.snapshot.runningTurnId,
      tui.store.snapshot.toolCalls,
      tui.store.snapshot.toolInputPreviews,
      { fullToolResults: true }
    );
    return rows.length ? rows.map(transcriptRowMarkdown).join("\n\n") : "no transcript yet.";
  }

  function lastAssistantText(): string {
    for (const message of [...tui.store.snapshot.messages].reverse()) {
      if (message.role !== "assistant") continue;
      const parts = message.parts
        .map((part) => {
          if (typeof part.payload === "string") return part.payload;
          if (part.payload && typeof part.payload === "object" && "text" in part.payload) {
            return String((part.payload as { text?: unknown }).text ?? "");
          }
          return "";
        })
        .filter((part) => part.trim().length > 0);
      if (parts.length > 0) return parts.join("\n\n");
    }
    return "";
  }

  return <></>;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeComposerText(text: string): string {
  return text.replace(/^\s*\n+/, "").replace(/\n+\s*$/, "").trim();
}

function transcriptRowMarkdown(row: TimelineRow): string {
  switch (row.kind) {
    case "user":
      return `## user\n\n${row.text}`;
    case "assistant":
      return `## assistant\n\n${row.text}`;
    case "thinking":
      return `## thinking\n\n${row.title}${row.body.trim() ? `\n\n${row.body}` : ""}`;
    case "tool": {
      const header = `## tool: ${row.tool}\n\nstatus: ${row.status}${row.argsSummary ? `\ninput: ${row.argsSummary}` : ""}`;
      const result = row.fullResult ?? row.result;
      return result ? `${header}\n\n### output\n\n${result}` : header;
    }
    case "exploration":
      return [
        `## ${row.status === "running" ? "exploring" : "explored"}`,
        "",
        ...row.items.flatMap((item) => [
          `### ${item.verb} ${item.target}`,
          "",
          item.fullResult ?? item.result ?? "no output"
        ])
      ].join("\n");
    case "plan":
      return [
        `## ${row.title}`,
        "",
        row.explanation ?? "",
        ...row.items.map((item) => `- [${item.status === "completed" ? "x" : " "}] ${item.step}`),
        row.markdown ?? ""
      ].filter((line) => line.length > 0).join("\n");
    case "mcp_inventory":
      return row.text;
    case "todo_list":
      return [
        `## ${row.title}`,
        "",
        ...row.items.map((item) => `- [${item.status === "completed" ? "x" : " "}] ${item.text}${item.priority ? ` (${item.priority})` : ""}`)
      ].join("\n");
    case "artifact":
      return `## ${row.title}\n\n${row.detail}${row.body ? `\n\n${row.body}` : ""}`;
    case "finding":
      return `## finding: ${row.title}\n\nseverity: ${row.severity}\ntarget: ${row.target}\n${row.body ?? row.detail}`;
    case "progress":
      return `## ${row.title}\n\n${row.detail}`;
    case "phase":
      return `## phase changed\n\n${row.phase}\n${row.detail}`;
    case "loop_stop":
      return `## ${row.reason}\n\n${row.text}`;
    case "compaction":
      return `## compacted context\n\n${row.text}`;
    case "error":
      return `## error\n\n${row.body ?? row.text}`;
    case "notice":
      return `## ${row.title}\n\n${row.body ?? row.detail ?? ""}`;
  }
}

function memoryDetailBody(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  } catch {
    return String(value);
  }
}

function slashPromptText(rawText: string, completedTitle: string | undefined, slashName: string | undefined): string {
  const trimmed = rawText.trim();
  if (/\s/.test(trimmed)) return trimmed;
  return completedTitle ?? (slashName ? `/${slashName}` : trimmed);
}
