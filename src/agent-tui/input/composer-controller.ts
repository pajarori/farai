import type { CliRenderer } from "@opentui/core";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command, CommandContext } from "../command-registry";
import { findSlashCommand } from "../command-registry";
import type { ComposerControl } from "../context/composer";
import type { TuiStoreValue } from "../context/store";
import type { TuiRuntimePort } from "../runtime-port";
import { slashCommandOptions, slashCompletionOption, slashMatches, slashPopupRowLimit } from "../slash-autocomplete";
import { slashCommandInvocation } from "../slash-command-line";
import { writeClipboard } from "../clipboard";
import { ctrlCDecision } from "./interrupt";
import type { SessionOwner } from "./center-surface-controller";

const quitConfirmationMs = 1_500;

type ComposerControllerInput = {
  tui: TuiStoreValue;
  composer: ComposerControl;
  renderer: CliRenderer;
  port: TuiRuntimePort;
  exit(): Promise<void> | void;
  commandContext(): CommandContext;
  terminalHeight(): number;
  captureOwner(): SessionOwner | undefined;
  owns(owner: SessionOwner): boolean;
};

export function createComposerController(input: ComposerControllerInput) {
  const { tui, composer, renderer, port } = input;
  let historyIndex = -1;
  let historyOriginalDraft = "";

  function resetSession(): void {
    historyIndex = -1;
    historyOriginalDraft = "";
  }

  function resetQuitConfirmation(): void {
    if (tui.store.ui.quitArmedUntil !== undefined || tui.store.ui.footerMode === "quit_hint") {
      tui.actions.quitConfirmationSet(undefined);
    }
  }

  async function clearOrExit(): Promise<void> {
    const text = composer.ref()?.plainText ?? composer.text();
    const decision = ctrlCDecision(text, tui.store.ui.quitArmedUntil ?? 0);
    if (decision === "clear") {
      resetQuitConfirmation();
      composer.clear();
      return;
    }
    if (decision === "arm") {
      const until = Date.now() + quitConfirmationMs;
      tui.actions.quitConfirmationSet(until);
      setTimeout(() => {
        if (tui.store.ui.quitArmedUntil === until) tui.actions.quitConfirmationSet(undefined);
      }, quitConfirmationMs);
      return;
    }
    resetQuitConfirmation();
    await input.exit();
  }

  function dispose(): void {
    historyIndex = -1;
    historyOriginalDraft = "";
  }

  async function submit(): Promise<void> {
    const text = normalizeComposerText(composer.expandedText());
    if (!text.trim()) return;
    resetHistoryNavigation();
    if (text.startsWith("/") && await submitSlashInvocation(text)) return;
    if (tui.submitPrompt(text)) composer.clear();
  }

  async function queue(): Promise<void> {
    const text = normalizeComposerText(composer.expandedText());
    if (!text.trim()) return;
    resetHistoryNavigation();
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
      await runLocalSlash(command, trimmed);
      return true;
    }
    return false;
  }

  function resetHistoryNavigation(): void {
    historyIndex = -1;
    historyOriginalDraft = "";
  }

  function navigateHistory(direction: "older" | "newer"): void {
    const entries = tui.store.ui.promptHistory.map((entry) => entry.text);
    if (entries.length === 0) return;
    if (historyIndex < 0) historyOriginalDraft = composer.ref()?.plainText ?? composer.text();
    historyIndex = direction === "older"
      ? Math.min(entries.length - 1, historyIndex + 1)
      : Math.max(-1, historyIndex - 1);
    composer.setDraft(historyIndex < 0 ? historyOriginalDraft : entries[historyIndex] ?? historyOriginalDraft);
    composer.focus();
  }

  function startHistorySearch(): void {
    resetHistoryNavigation();
    tui.actions.historySearchStart(composer.ref()?.plainText ?? composer.text());
    applyHistoryPreview();
  }

  async function editLastQueued(): Promise<void> {
    const owner = input.captureOwner();
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
      if (input.owns(owner)) tui.actions.snapshotPatched(activity);
    } catch {
    }
  }

  async function restoreQueuedAfterCancel(): Promise<void> {
    const owner = input.captureOwner();
    if (!owner) return;
    const restored = [];
    while (true) {
      const queued = port.takeBackQueuedInput(owner.sessionId);
      if (!queued) break;
      restored.push(queued);
    }
    if (restored.length === 0 || !input.owns(owner)) return;
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
      if (input.owns(owner)) tui.actions.snapshotPatched(activity);
    } catch {
    }
  }

  function copyLastAssistantResponse(): void {
    const text = lastAssistantText(tui);
    if (!text) {
      tui.setStatusDetail("nothing to copy", 2_000);
      return;
    }
    copyText(text, "copied last response");
  }

  function copyText(text: string, successMessage: string): void {
    let copied = false;
    try { copied = renderer.copyToClipboardOSC52(text); } catch { copied = false; }
    if (!copied) copied = writeClipboard(text).ok;
    tui.setStatusDetail(copied ? successMessage : "copy failed", 2_000);
  }

  function slashMatchCount(): number {
    const text = composer.ref()?.plainText ?? composer.text();
    return slashMatches(slashCommandOptions(), text, slashPopupRowLimit(input.terminalHeight())).length;
  }

  function completeSlash(): void {
    const text = composer.ref()?.plainText ?? composer.text();
    const completion = slashCompletionOption(slashCommandOptions(), text, tui.store.ui.slashIndex);
    if (!completion) return;
    composer.setDraft(`${completion.title} `);
    tui.actions.slashSuppress(undefined);
    composer.focus();
  }

  async function dispatchSlash(): Promise<void> {
    const text = normalizeComposerText(composer.expandedText());
    const completion = slashCompletionOption(slashCommandOptions(), text, tui.store.ui.slashIndex);
    const command = completion?.value ?? findSlashCommand(text);
    const promptText = slashPromptText(text, completion?.title, command?.slashName);
    if (!command) return;
    if (command.slashBehavior === "local") {
      composer.clear();
      await runLocalSlash(command, promptText);
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
      await runLocalSlash(command, trimmed);
    } else if (tui.submitPrompt(trimmed)) {
      composer.clear();
    }
    return true;
  }

  async function runLocalSlash(command: Command, text: string): Promise<void> {
    try {
      await command.run(input.commandContext(), slashCommandInvocation(text));
    } catch (error) {
      tui.actions.errorSet(error instanceof Error ? error.message : String(error));
    }
  }

  function historyMatches(): string[] {
    const search = tui.store.ui.historySearch;
    const entries = tui.store.ui.promptHistory.map((entry) => entry.text);
    if (!search?.query.trim()) return entries;
    const needle = search.query.toLowerCase();
    return entries.filter((entry) => entry.toLowerCase().includes(needle));
  }

  function applyHistoryPreview(): void {
    const search = tui.store.ui.historySearch;
    if (!search) return;
    const matches = historyMatches();
    composer.setDraft(matches[search.index] ?? search.originalDraft);
  }

  function appendHistorySearch(char: string): void {
    tui.actions.historySearchAppend(char);
    applyHistoryPreview();
  }

  function backspaceHistorySearch(): void {
    tui.actions.historySearchBackspace();
    applyHistoryPreview();
  }

  function moveHistorySearch(delta: number): void {
    tui.actions.historySearchMove(delta, historyMatches().length);
    applyHistoryPreview();
  }

  function acceptHistorySearch(): void {
    tui.actions.historySearchStop();
    composer.focus();
  }

  function cancelHistorySearch(): void {
    const original = tui.store.ui.historySearch?.originalDraft ?? "";
    tui.actions.historySearchStop();
    composer.setDraft(original);
    composer.focus();
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
      try { renderer.resume(); } catch {
      }
      try { rmSync(dir, { recursive: true, force: true }); } catch {
      }
      if (tui.store.ui.overlayStack.length === 0 && tui.store.ui.centerSurfaceStack.length === 0) composer.focus();
      else composer.blur();
    }
  }

  return {
    resetSession,
    dispose,
    resetQuitConfirmation,
    clearOrExit,
    submit,
    queue,
    startHistorySearch,
    navigateHistory,
    editLastQueued,
    restoreQueuedAfterCancel,
    copyLastAssistantResponse,
    copyText,
    slashMatchCount,
    completeSlash,
    dispatchSlash,
    dismissSlash: () => tui.actions.slashSuppress(composer.ref()?.plainText ?? composer.text()),
    appendHistorySearch,
    backspaceHistorySearch,
    moveHistorySearch,
    acceptHistorySearch,
    cancelHistorySearch,
    openExternalEditor
  };
}

function normalizeComposerText(text: string): string {
  return text.replace(/^\s*\n+/, "").replace(/\n+\s*$/, "").trim();
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function slashPromptText(rawText: string, completedTitle: string | undefined, slashName: string | undefined): string {
  const trimmed = rawText.trim();
  if (/\s/.test(trimmed)) return trimmed;
  return completedTitle ?? (slashName ? `/${slashName}` : trimmed);
}

function lastAssistantText(tui: TuiStoreValue): string {
  for (const message of [...tui.store.snapshot.messages].reverse()) {
    if (message.role !== "assistant") continue;
    const parts = message.parts
      .filter((part) => part.type === "text")
      .map((part) => {
        const streamed = tui.transcript.state.text[part.id]?.content;
        if (streamed !== undefined) return streamed;
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
