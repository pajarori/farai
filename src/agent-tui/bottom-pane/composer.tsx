import { RGBA, type BoxRenderable, type OptimizedBuffer, type PasteEvent, type TextareaRenderable } from "@opentui/core";
import { For, Show, createEffect, createMemo, onCleanup, onMount, type JSX } from "solid-js";
import { useRenderer } from "@opentui/solid";
import { useTuiStore } from "../context/store";
import { useComposerControl } from "../context/composer";
import { COLOR } from "../theme";
import type { Command } from "../command-registry";
import { slashCommandOptions, slashMatches as matchSlashCommands, slashPopupRowLimit, slashPopupVisible } from "../slash-autocomplete";
import { truncateLine } from "../renderers";
import type { DialogOption } from "../dialog/fuzzy";
import { isPrimaryClick } from "../input/mouse";
import { fitTerminal, terminalWidth } from "../terminal-text";
import { useTuiDimensions } from "../context/terminal";
import { useCommandRegistryRevision } from "../command-registry-signal";

export function composerHeightFromVisualLines(visualLines: number): number {
  return Math.min(6, Math.max(1, visualLines));
}

export const COMPOSER_PLACEHOLDER = "what should we investigate?";

const focusTintStart = [22, 33, 38] as const;
const focusTintEnd = [16, 16, 16] as const;
const inactiveComposerBackground = RGBA.fromInts(...focusTintEnd);
const composerPageBackground = RGBA.fromInts(0, 0, 0);
const focusTintPalettes = new Map<number, readonly RGBA[]>();
const composerEdgeRuns = new Map<number, { top: string; bottom: string }>();

export function composerFocusTintColor(progress: number): RGBA {
  const amount = Math.max(0, Math.min(1, progress));
  return RGBA.fromInts(
    Math.round(focusTintStart[0] + (focusTintEnd[0] - focusTintStart[0]) * amount),
    Math.round(focusTintStart[1] + (focusTintEnd[1] - focusTintStart[1]) * amount),
    Math.round(focusTintStart[2] + (focusTintEnd[2] - focusTintStart[2]) * amount)
  );
}

function composerFocusTintPalette(size: number): readonly RGBA[] {
  const cached = focusTintPalettes.get(size);
  if (cached) return cached;
  const palette = Array.from({ length: size }, (_, index) => (
    composerFocusTintColor(size <= 1 ? 0 : index / (size - 1))
  ));
  focusTintPalettes.set(size, palette);
  return palette;
}

function composerEdgeRun(width: number): { top: string; bottom: string } {
  const cached = composerEdgeRuns.get(width);
  if (cached) return cached;
  const run = { top: "▄".repeat(width), bottom: "▀".repeat(width) };
  composerEdgeRuns.set(width, run);
  return run;
}

function paintComposerBand(
  buffer: OptimizedBuffer,
  x: number,
  y: number,
  width: number,
  height: number,
  color: RGBA
): void {
  if (height <= 1) {
    buffer.fillRect(x, y, width, height, color);
    return;
  }
  const edge = composerEdgeRun(width);
  buffer.drawText(edge.top, x, y, color, composerPageBackground);
  if (height > 2) buffer.fillRect(x, y + 1, width, height - 2, color);
  buffer.drawText(edge.bottom, x, y + height - 1, color, composerPageBackground);
}

export function Composer(props: { visible?: boolean; active?: boolean } = {}): JSX.Element {
  const tui = useTuiStore();
  const composer = useComposerControl();
  const dims = useTuiDimensions();
  const renderer = useRenderer();
  const commandRegistryRevision = useCommandRegistryRevision();
  let textareaRef!: TextareaRenderable;
  let composerHeightRefreshPending = false;
  let disposed = false;
  const decoder = new TextDecoder();
  const surfaceVisible = () => props.visible ?? true;
  const inputActive = () => surfaceVisible() && (props.active ?? (
    tui.store.ui.overlayStack.length === 0 && tui.store.ui.centerSurfaceStack.length === 0
  ));

  const syncComposerHeight = (): void => {
    if (!textareaRef || !surfaceVisible()) return;
    const visualLines = textareaRef.editorView.getTotalVirtualLineCount();
    composer.setHeight(composerHeightFromVisualLines(visualLines));
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

  const slashOptions = createMemo<DialogOption<Command>[]>(() => {
    commandRegistryRevision();
    return slashCommandOptions();
  });
  const slashRowLimit = () => slashPopupRowLimit(dims().height);
  const slashMatches = createMemo(() => matchSlashCommands(slashOptions(), composer.text(), slashRowLimit()));
  const slashActive = () => slashPopupVisible(
    composer.text(),
    tui.store.ui.slashSuppressedText === composer.text(),
    slashMatches().length,
    tui.store.ui.overlayStack.length > 0 || tui.store.ui.centerSurfaceStack.length > 0
  ) && inputActive();
  const popupWidth = () => Math.max(1, dims().width);
  const commandWidth = () => Math.min(
    Math.max(1, popupWidth() - 2),
    Math.min(28, Math.max(8, ...slashOptions().map((option) => terminalWidth(option.title) + 2)))
  );
  const descWidth = () => Math.max(0, popupWidth() - commandWidth() - 2);
  const paintComposerBackground = function (this: BoxRenderable, buffer: OptimizedBuffer): void {
    const width = Math.max(1, Math.floor(this.width));
    const height = Math.max(1, Math.floor(this.height));
    const x = Math.floor(this.x);
    const y = Math.floor(this.y);
    if (!inputActive()) {
      paintComposerBand(buffer, x, y, width, height, inactiveComposerBackground);
      return;
    }
    const bands = Math.min(width, 48);
    const palette = composerFocusTintPalette(bands);
    for (let band = 0; band < bands; band += 1) {
      const left = Math.floor((band * width) / bands);
      const right = Math.floor(((band + 1) * width) / bands);
      paintComposerBand(buffer, x + left, y, Math.max(1, right - left), height, palette[band]!);
    }
  };

  createEffect(() => {
    dims().width;
    if (surfaceVisible()) scheduleComposerHeightRefresh();
  });

  createEffect(() => {
    const len = slashMatches().length;
    tui.actions.slashIndexSet(tui.store.ui.slashIndex, len);
  });

  createEffect(() => {
    if (!textareaRef) return;
    if (inputActive()) textareaRef.focus();
    else textareaRef.blur();
    renderer.requestRender();
  });

  onMount(() => {
    const draft = composer.text();
    if (draft) {
      try { textareaRef?.setText(draft); } catch {  }
    }
    const onPaste = (event: PasteEvent): void => {
      if (!inputActive()) return;
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
    <box id="composer-surface" visible={surfaceVisible()} style={{ flexShrink: 0, flexDirection: "column", paddingTop: 0 }}>
      <box style={{ position: "relative", height: composer.height() + 2, flexShrink: 0 }}>
        <box
          shouldFill={false}
          renderBefore={paintComposerBackground}
          style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 0 }}
        />
        <box style={{ position: "absolute", left: 2, right: 1, top: 1, height: composer.height(), zIndex: 1, flexDirection: "row" }}>
          <textarea
            id="composer-input"
            ref={(node) => {
              textareaRef = node;
              composer.setRef(node);
              scheduleComposerHeightRefresh();
            }}
            placeholder={COMPOSER_PLACEHOLDER}
            placeholderColor={COLOR.dim}
            textColor={COLOR.text}
            focusedTextColor={COLOR.text}
            cursorColor={COLOR.accent}
            wrapMode="word"
            style={{ height: composer.height(), flexGrow: 1, backgroundColor: "transparent" }}
            onContentChange={() => {
              const value = textareaRef?.plainText ?? "";
              composer.setText(value);
              if (tui.store.ui.lastError) tui.actions.errorSet(undefined);
              syncComposerHeight();
              scheduleComposerHeightRefresh();
              if (tui.store.ui.footerMode !== "ambient" && value.trim()) tui.actions.footerModeSet("ambient");
              tui.actions.slashIndexSet(0, slashMatches().length || 1);
              if (tui.store.ui.slashSuppressedText && tui.store.ui.slashSuppressedText !== value) tui.actions.slashSuppress(undefined);
            }}
          />
        </box>
      </box>
      <Show when={slashActive()}>
        <box style={{ width: popupWidth(), height: slashRowLimit(), flexDirection: "column", overflow: "hidden" }}>
          <For each={slashMatches()}>{(option, index) => {
            const active = () => index() === tui.store.ui.slashIndex;
            const command = () => fitTerminal(option.title, commandWidth());
            const desc = () => descWidth() >= 8 ? truncateLine(option.description ?? "", descWidth()) : "";
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
                <text selectable={false} fg={active() ? COLOR.accent : COLOR.dim}>{active() ? "› " : "  "}</text>
                <text selectable={false} fg={active() ? COLOR.accent : COLOR.text}>{command()}</text>
                <text selectable={false} fg={COLOR.dim}>{desc()}</text>
              </box>
            );
          }}</For>
        </box>
      </Show>
    </box>
  );
}
