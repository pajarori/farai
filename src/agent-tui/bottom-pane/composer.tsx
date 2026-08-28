import type { PasteEvent, TextareaRenderable } from "@opentui/core";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { useTuiStore } from "../context/store";
import { useComposerControl } from "../context/composer";
import { COLOR } from "../theme";
import { isVisibleSlashCommand, listCommands, type Command } from "../command-registry";
import { slashMatches as matchSlashCommands } from "../slash-autocomplete";
import { truncateLine } from "../renderers";
import type { DialogOption } from "../dialog/fuzzy";
import { isPrimaryClick } from "../input/mouse";

export function composerHeightFromVisualLines(visualLines: number): number {
  return Math.min(6, Math.max(1, visualLines));
}

export function Composer(): JSX.Element {
  const tui = useTuiStore();
  const composer = useComposerControl();
  const dims = useTerminalDimensions();
  const renderer = useRenderer();
  let textareaRef!: TextareaRenderable;
  const [composerHeight, setComposerHeight] = createSignal(1);
  let composerHeightRefreshPending = false;
  let disposed = false;
  const decoder = new TextDecoder();

  const syncComposerHeight = (): void => {
    if (!textareaRef) return;
    // virtualLineCount is viewport-limited; total includes wrapped rows below it.
    const visualLines = textareaRef.editorView.getTotalVirtualLineCount();
    setComposerHeight(composerHeightFromVisualLines(visualLines));
  };
  const refreshComposerHeightAfterLayout = (): void => {
    composerHeightRefreshPending = false;
    queueMicrotask(() => {
      if (!disposed) syncComposerHeight();
    });
  };
  const scheduleComposerHeightRefresh = (): void => {
    if (!textareaRef || composerHeightRefreshPending) return;
    composerHeightRefreshPending = true;
    renderer.once("frame", refreshComposerHeightAfterLayout);
    renderer.requestRender();
  };

  const slashOptions = createMemo<DialogOption<Command>[]>(() => listCommands()
    .filter((command) => command.slashName && isVisibleSlashCommand(command))
    .map((command) => ({
      id: command.name,
      title: `/${command.slashName ?? command.name}`,
      ...(command.desc ? { description: command.desc } : {}),
      value: command
    })));
  const slashMatches = createMemo(() => matchSlashCommands(slashOptions(), composer.text()));
  const slashActive = () => composer.text().startsWith("/")
    && !composer.text().slice(1).includes(" ")
    && tui.store.ui.slashSuppressedText !== composer.text()
    && slashMatches().length > 0
    && tui.store.ui.overlayStack.length === 0;
  const popupWidth = () => Math.max(24, dims().width);
  const commandWidth = () => Math.min(28, Math.max(8, ...slashMatches().map((option) => option.title.length + 2)));
  const descWidth = () => Math.max(12, popupWidth() - commandWidth() - 6);
  const rule = () => "─".repeat(Math.max(1, dims().width));

  createEffect(() => {
    dims().width;
    scheduleComposerHeightRefresh();
  });

  createEffect(() => {
    const len = slashMatches().length;
    tui.actions.slashIndexSet(tui.store.ui.slashIndex, len);
  });

  createEffect(() => {
    const blocked = tui.store.ui.overlayStack.length > 0 || tui.store.ui.centerSurfaceStack.length > 0;
    if (!textareaRef) return;
    if (blocked) textareaRef.blur();
    else textareaRef.focus();
  });

  onMount(() => {
    const draft = composer.text();
    if (draft) {
      try { textareaRef?.setText(draft); } catch {  }
    }
    const onPaste = (event: PasteEvent): void => {
      const text = decoder.decode(event.bytes);
      if (text.length < 1_000) return;
      event.preventDefault();
      event.stopPropagation();
      const label = composer.addLargePaste(text);
      composer.insertText(label);
      tui.setStatusDetail(`large paste captured (${text.length} chars)`, 2_000);
    };
    renderer.keyInput.on("paste", onPaste);
    onCleanup(() => renderer.keyInput.off("paste", onPaste));
  });

  onCleanup(() => {
    disposed = true;
    renderer.off("frame", refreshComposerHeightAfterLayout);
    composer.setRef(undefined);
    textareaRef?.blur();
  });

  return (
    <box style={{ flexShrink: 0, flexDirection: "column", paddingTop: 0 }}>
      <text fg={COLOR.border}>{rule()}</text>
      <box style={{ flexDirection: "row", height: composerHeight(), backgroundColor: COLOR.panel }}>
        <text fg={COLOR.dim}>{"› "}</text>
        <textarea
          id="composer-input"
          ref={(node) => {
            textareaRef = node;
            composer.setRef(node);
            scheduleComposerHeightRefresh();
          }}
          placeholder="ask farai to do anything"
          placeholderColor={COLOR.dim}
          textColor={COLOR.text}
          focusedTextColor={COLOR.text}
          cursorColor={COLOR.accent}
          wrapMode="word"
          style={{ height: composerHeight(), flexGrow: 1, backgroundColor: COLOR.panel }}
          onContentChange={() => {
            const value = textareaRef?.plainText ?? "";
            composer.setText(value);
            syncComposerHeight();
            scheduleComposerHeightRefresh();
            if (tui.store.ui.footerMode !== "ambient" && value.trim()) tui.actions.footerModeSet("ambient");
            tui.actions.slashIndexSet(0, slashMatches().length || 1);
            if (tui.store.ui.slashSuppressedText && tui.store.ui.slashSuppressedText !== value) tui.actions.slashSuppress(undefined);
          }}
        />
      </box>
      <Show when={slashActive()}>
        <box style={{ width: popupWidth(), flexDirection: "column" }}>
          <For each={slashMatches()}>{(option, index) => {
            const active = () => index() === tui.store.ui.slashIndex;
            const command = () => truncateLine(option.title.padEnd(commandWidth()), commandWidth());
            const desc = () => truncateLine(option.description ?? "", descWidth());
            return (
              <box
                style={{ flexDirection: "row" }}
                onMouseUp={(event) => {
                  if (!isPrimaryClick(event)) return;
                  composer.setDraft(`${option.title} `);
                  tui.actions.slashSuppress(undefined);
                  composer.focus();
                }}
              >
                <text selectable={false} fg={active() ? COLOR.accent : COLOR.text}>{`  ${command()}`}</text>
                <text selectable={false} fg={COLOR.dim}>{desc()}</text>
              </box>
            );
          }}</For>
        </box>
      </Show>
      <text fg={COLOR.border}>{rule()}</text>
    </box>
  );
}
