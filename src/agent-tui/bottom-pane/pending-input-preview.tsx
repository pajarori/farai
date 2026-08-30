import { For, Show, createMemo, type JSX } from "solid-js";
import { useTuiStore } from "../context/store";
import { truncateLine } from "../renderers";
import { COLOR } from "../theme";
import { useTuiDimensions } from "../context/terminal";

export function PendingInputPreview(props: { maxRows?: number }): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  const rows = createMemo(() => pendingInputPreviewRows(
    tui.store.snapshot.pendingSteers.map((item) => item.text),
    tui.store.snapshot.queuedPrompts.map((item) => item.text),
    dims().width,
    props.maxRows ?? Number.MAX_SAFE_INTEGER
  ));
  return (
    <Show when={rows().length > 0}>
      <box style={{ flexDirection: "column" }}>
        <For each={rows()}>{(row) => <text fg={COLOR.dim}>{row}</text>}</For>
      </box>
    </Show>
  );
}

export function pendingInputPreviewRows(
  pendingSteers: readonly string[],
  queuedPrompts: readonly string[],
  width: number,
  maxRows: number
): string[] {
  const limit = Math.max(0, Math.floor(maxRows));
  if (limit === 0 || (pendingSteers.length === 0 && queuedPrompts.length === 0)) return [];
  const contentWidth = Math.max(1, width - 4);
  const rows: string[] = [];
  if (pendingSteers.length > 0) {
    rows.push(width >= 42 ? "• steering at the next safe boundary" : `• ${pendingSteers.length} steering`);
    rows.push(...pendingSteers.slice(0, 3).map((text) => `  ↳ ${truncateLine(text.replace(/\s+/g, " "), contentWidth)}`));
    if (pendingSteers.length > 3) rows.push(`  … ${pendingSteers.length - 3} more`);
  }
  if (queuedPrompts.length > 0) {
    if (rows.length > 0) rows.push("");
    rows.push(width >= 42 ? "• queued follow-ups · ↑ edit latest" : `• ${queuedPrompts.length} queued · ↑ edit`);
    rows.push(...queuedPrompts.slice(0, 3).map((text, index) => `  ${index + 1}. ${truncateLine(text.replace(/\s+/g, " "), contentWidth)}`));
    if (queuedPrompts.length > 3) rows.push(`  … ${queuedPrompts.length - 3} more`);
  }
  if (rows.length <= limit) return rows.map((row) => truncateLine(row, Math.max(1, width)));
  if (limit === 1) return [truncateLine(`• ${pendingSteers.length + queuedPrompts.length} pending inputs`, Math.max(1, width))];
  const hidden = rows.length - limit + 1;
  return [...rows.slice(0, limit - 1), `  … ${hidden} more line${hidden === 1 ? "" : "s"}`]
    .map((row) => truncateLine(row, Math.max(1, width)));
}
