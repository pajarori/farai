import { For, createMemo, type JSX } from "solid-js";
import { COLOR } from "../theme";
import { truncateLine } from "../renderers";
import { useTuiDimensions } from "../context/terminal";

export function MultiSelectRows(props: {
  items: string[];
  selected: (item: string) => boolean;
  cursor: number;
  visibleLimit?: number;
}): JSX.Element {
  const dims = useTuiDimensions();
  const limit = () => Math.max(1, Math.min(6, props.visibleLimit ?? 6));
  const window = createMemo(() => {
    const cursor = Math.max(0, Math.min(props.cursor, props.items.length - 1));
    const start = Math.max(0, Math.min(cursor - Math.floor(limit() / 2), Math.max(0, props.items.length - limit())));
    return props.items.slice(start, start + limit()).map((item, index) => ({ item, index: start + index }));
  });
  return (
    <box style={{ flexDirection: "column" }}>
      <For each={window()} fallback={<text fg={COLOR.dim}>{"  no matching tools"}</text>}>{(entry) => {
        const active = () => entry.index === Math.max(0, Math.min(props.cursor, props.items.length - 1));
        const checked = () => props.selected(entry.item);
        return (
          <box style={{ flexDirection: "row" }}>
            <text selectable={false} fg={active() ? COLOR.accent : COLOR.dim}>{active() ? "› " : "  "}</text>
            <text selectable={false} fg={checked() ? COLOR.success : COLOR.dim}>{checked() ? "◉ " : "○ "}</text>
            <text selectable={false} fg={active() ? COLOR.text : checked() ? COLOR.text : COLOR.dim}>{truncateLine(entry.item, Math.max(1, dims().width - 8))}</text>
          </box>
        );
      }}</For>
    </box>
  );
}
