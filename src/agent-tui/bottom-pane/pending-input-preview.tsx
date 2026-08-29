import { useTerminalDimensions } from "@opentui/solid";
import { For, Show, type JSX } from "solid-js";
import { useTuiStore } from "../context/store";
import { truncateLine } from "../renderers";
import { COLOR } from "../theme";

export function PendingInputPreview(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTerminalDimensions();
  const contentWidth = () => Math.max(1, dims().width - 4);
  return (
    <Show when={tui.store.snapshot.pendingSteers.length > 0 || tui.store.snapshot.queuedPrompts.length > 0}>
      <box style={{ flexDirection: "column" }}>
        <Show when={tui.store.snapshot.pendingSteers.length > 0}>
          <text fg={COLOR.dim}>{dims().width >= 42 ? "• steering at the next safe boundary" : `• ${tui.store.snapshot.pendingSteers.length} steering`}</text>
          <For each={tui.store.snapshot.pendingSteers.slice(0, 3)}>{(item) => (
            <text fg={COLOR.dim}>{`  ↳ ${truncateLine(item.text.replace(/\s+/g, " "), contentWidth())}`}</text>
          )}</For>
          <Show when={tui.store.snapshot.pendingSteers.length > 3}>
            <text fg={COLOR.dim}>{`  … ${tui.store.snapshot.pendingSteers.length - 3} more`}</text>
          </Show>
        </Show>
        <Show when={tui.store.snapshot.queuedPrompts.length > 0}>
          <text fg={COLOR.dim}>{dims().width >= 42 ? "• queued follow-ups · ↑ edit latest" : `• ${tui.store.snapshot.queuedPrompts.length} queued · ↑ edit`}</text>
          <For each={tui.store.snapshot.queuedPrompts.slice(0, 3)}>{(item, index) => (
            <text fg={COLOR.dim}>{`  ${index() + 1}. ${truncateLine(item.text.replace(/\s+/g, " "), contentWidth())}`}</text>
          )}</For>
          <Show when={tui.store.snapshot.queuedPrompts.length > 3}>
            <text fg={COLOR.dim}>{`  … ${tui.store.snapshot.queuedPrompts.length - 3} more`}</text>
          </Show>
        </Show>
      </box>
    </Show>
  );
}
