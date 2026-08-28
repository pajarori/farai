import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useRenderer, useSelectionHandler } from "@opentui/solid";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onCleanup, type JSX } from "solid-js";
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
import { slashCompletionOption } from "../slash-autocomplete";
import { routeKey, toKeyToken, type RouterAction } from "./router";
import { projectMessagesToRows, truncateLine, type TimelineRow } from "../renderers";
import { writeClipboard } from "../clipboard";
import { isAgentBusy, isAgentCancelable, proxyFlowsForFilter } from "../store";
import { ctrlCDecision } from "./interrupt";

const QUIT_CONFIRMATION_MS = 1_500;

export function KeyboardController(): JSX.Element {
  const tui = useTuiStore();
  const composer = useComposerControl();
  const exit = useExit();
  const { port } = useTuiRuntime();
  const renderer = useRenderer();
  let historyNavIndex = -1;
  let historyNavOriginalDraft = "";
  let lastCopiedSelection = "";
  let quitArmedUntil = 0;
  let quitTimer: ReturnType<typeof setTimeout> | undefined;

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
    const cursor = composer.ref()?.cursorOffset;
    const routed = routeKey(key, {
      overlayKind: top?.kind,
      centerSurfaceKind: centerTop?.kind,
      running: isAgentBusy(tui.store),
      cancelable: isAgentCancelable(tui.store),
      composerText: text,
      ...(cursor === undefined ? {} : { composerCursor: cursor }),
      slashSuppressed: tui.store.ui.slashSuppressedText === text,
      historySearchActive: Boolean(tui.store.ui.historySearch),
      queuedCount: tui.store.snapshot.queuedPrompts.length,
      activeMainTab: tui.store.ui.activeMainTab
    });
    if (routed.type === "passthrough") return;
    event.preventDefault();
    event.stopPropagation();
    for (const action of routed.actions) void applyAction(action);
  });

  useSelectionHandler((selection) => {
    if (selection.isDragging) return;
    const text = selection.getSelectedText().trim();
    if (!text || text === lastCopiedSelection) return;
    lastCopiedSelection = text;
    copyTextToClipboard(text, "copied selection");
  });

  onCleanup(() => {
    if (quitTimer) clearTimeout(quitTimer);
  });

  async function applyAction(action: RouterAction): Promise<void> {
    switch (action.kind) {
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
      case "proxy.websocketMessageMove":
        tui.actions.proxyWebSocketMessageMove(action.delta);
        return;
      case "queued.editLast":
        await editLastQueuedPrompt();
        return;
      case "turn.cancel":
        await tui.cancelCurrentTurn();
        return;
      case "message.nav":
        tui.actions.messageNavigationRequested(action.direction);
        return;
      case "overlay.open":
        if (action.overlay === "sessions") void tui.refreshSessions();
        tui.actions.overlayOpen(action.overlay);
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
    if (await submitSlashInvocation(text)) return;
    composer.clear();
    await tui.submitPrompt(text);
  }

  async function queueComposer(): Promise<void> {
    const text = normalizeComposerText(composer.expandedText());
    if (!text.trim()) return;
    resetPromptHistoryNavigation();
    composer.clear();
    await tui.queuePrompt(text);
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
    const sid = tui.store.activeSessionId;
    if (!sid) return;
    const queued = port.takeBackQueuedInput(sid);
    if (!queued) return;
    tui.actions.snapshotPatched({
      queuedPrompts: tui.store.snapshot.queuedPrompts.filter((item) => item.id !== queued.id)
    });
    composer.setDraft(queued.text);
    composer.focus();
    try {
      const activity = await port.loadActivityState(sid);
      if (tui.store.activeSessionId === sid) tui.actions.snapshotPatched(activity);
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
    const flow = proxyFlowsForFilter(tui.store.ui.proxyFlows, tui.store.ui.proxyFilter)[tui.store.ui.proxySelectedIndex];
    if (!flow) return;
    tui.setStatusDetail("loading proxy flow");
    try {
      const detail = await port.getProxyFlow(flow.id);
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
      tui.setStatusDetail(undefined);
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
        await tui.selectSession(String(option.value));
        tui.actions.overlayClear();
        return;
      case "agents":
        await tui.selectSession((option.value as AgentThreadSummary).sessionId);
        tui.actions.overlayClear();
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
        if (choice.kind === "model_provider") {
          tui.actions.overlayPush({ kind: "model", providerID: choice.providerID, query: "", index: 0 });
          return;
        }
        const sessionId = tui.store.activeSessionId;
        if (!sessionId) return;
        if (choice.kind !== "model") return;
        await port.updateSession(sessionId, { model: choice.model });
        await rememberModelSelection(choice.model, {
          workspace: tui.store.workspace,
          ...(choice.providerID ? { providerID: choice.providerID } : {}),
          ...(choice.contextWindow ? { contextWindow: choice.contextWindow } : {}),
          ...(choice.maxOutputTokens ? { maxOutputTokens: choice.maxOutputTokens } : {})
        });
        await tui.refreshSnapshot();
        await tui.refreshSessions();
        tui.setStatusDetail(`model: ${choice.model}`, 2_000);
        tui.actions.overlayClear();
        return;
      }
    }
  }

  async function runCenterSurfaceAction(action: string): Promise<void> {
    const frame = tui.store.ui.centerSurfaceStack.at(-1);
    if (!frame) return;
    if (frame.kind === "report" && action === "save") {
      const id = tui.store.activeSessionId;
      if (!id) return;
      const result = await port.exportReport(id, { write: true });
      tui.actions.centerSurfacePush({ kind: "detail", title: "report saved", body: result.path ?? "saved" });
      return;
    }
    if (frame.kind === "container" && action === "toggle") {
      await tui.toggleContainer();
      return;
    }
    if (frame.kind === "container" && action === "refresh") {
      await tui.refreshContainerStatus();
    }
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
    composer.clear();
    if (command.slashBehavior === "local") await command.run(commandContext());
    else await tui.submitPrompt(promptText);
  }

  async function submitSlashInvocation(rawText: string): Promise<boolean> {
    const trimmed = rawText.trim();
    if (!trimmed.startsWith("/")) return false;
    const command = findSlashCommand(trimmed);
    if (!command) return false;
    composer.clear();
    if (command.name === "session.compact") {
      await tui.compact(trimmed.slice("/compact".length).trim() || undefined);
    } else if (command.slashBehavior === "local") {
      await command.run(commandContext());
    } else {
      await tui.submitPrompt(trimmed);
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
      composer.focus();
    }
  }

  async function openFullTranscript(): Promise<void> {
    const sessionId = tui.store.activeSessionId;
    if (!sessionId) return;
    tui.setStatusDetail("loading transcript");
    try {
      const messages = await port.loadFullMessages(sessionId);
      tui.actions.centerSurfacePush({ kind: "detail", title: "transcript", body: transcriptMarkdown(messages) });
    } catch (error) {
      tui.actions.errorSet(error instanceof Error ? error.message : String(error));
    } finally {
      tui.setStatusDetail(undefined);
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
