import type { JSX } from "solid-js";
import { useTuiStore } from "../context/store";
import { SelectionMenuHint, SelectionRow, selectionDescriptionColumn } from "../overlays/selection-row";
import { COLOR } from "../theme";
import { truncateLine } from "../renderers";
import { fitTerminalPair } from "../terminal-text";
import { useTuiDimensions } from "../context/terminal";

export function LaneRemoval(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  const state = () => tui.store.ui.laneRemoval!;
  const lane = () => state().lane;
  const title = () => `remove ${lane().id}`;
  const descriptionColumn = () => selectionDescriptionColumn([{ title: title() }], dims().width);
  const header = () => fitTerminalPair("remove lane", lane().source, Math.max(1, dims().width - 4), 8, 1);
  const hint = () => state().busy
    ? `removing ${lane().id}…`
    : state().error
      ? `error · ${state().error}`
      : "enter remove · esc cancel";

  return (
    <box id="lane-removal" style={{ height: 8, flexShrink: 0, flexDirection: "column", overflow: "hidden" }}>
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between", paddingLeft: 2, paddingRight: 2 }}>
        <text fg={COLOR.text}>{header().left}</text>
        <text fg={COLOR.dim}>{header().right}</text>
      </box>
      <box style={{ height: 5, flexShrink: 0, flexDirection: "column", paddingTop: 1, overflow: "hidden" }}>
        <text fg={COLOR.accent}>{`  ${truncateLine(`remove custom lane ${lane().id}?`, Math.max(1, dims().width - 2))}`}</text>
        <box style={{ flexDirection: "column", marginTop: 1 }}>
          <SelectionRow
            title={title()}
            description="reverts to the builtin definition if one exists"
            selected
            disabled={state().busy}
            width={dims().width}
            descriptionColumn={descriptionColumn()}
            titleColor={COLOR.error}
          />
        </box>
      </box>
      <SelectionMenuHint text={hint()} color={state().error ? COLOR.error : undefined} />
    </box>
  );
}
