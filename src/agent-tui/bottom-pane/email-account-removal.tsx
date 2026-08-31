import type { JSX } from "solid-js";
import { useTuiStore } from "../context/store";
import { useTuiDimensions } from "../context/terminal";
import { SelectionMenuHint, SelectionRow, selectionDescriptionColumn } from "../overlays/selection-row";
import { truncateLine } from "../renderers";
import { fitTerminalPair } from "../terminal-text";
import { COLOR } from "../theme";

export function EmailAccountRemoval(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  const state = () => tui.store.ui.emailAccountRemoval!;
  const account = () => state().account;
  const title = () => `remove ${account().label}`;
  const descriptionColumn = () => selectionDescriptionColumn([{ title: title() }], dims().width);
  const header = () => fitTerminalPair("remove email", account().source, Math.max(1, dims().width - 4), 8, 1);
  const hint = () => state().busy ? `removing ${account().label}…` : state().error ? `error · ${state().error}` : "enter remove · esc cancel";
  return (
    <box id="email-account-removal" style={{ height: 8, flexShrink: 0, flexDirection: "column", overflow: "hidden" }}>
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between", paddingLeft: 2, paddingRight: 2 }}>
        <text fg={COLOR.text}>{header().left}</text><text fg={COLOR.dim}>{header().right}</text>
      </box>
      <box style={{ height: 5, flexShrink: 0, flexDirection: "column", paddingTop: 1, overflow: "hidden" }}>
        <text fg={COLOR.accent}>{`  ${truncateLine(`remove ${account().label}?`, Math.max(1, dims().width - 2))}`}</text>
        <box style={{ flexDirection: "column", marginTop: 1 }}>
          <SelectionRow title={title()} description={`${account().address} · credential and role bindings`} selected disabled={state().busy} width={dims().width} descriptionColumn={descriptionColumn()} titleColor={COLOR.error} />
        </box>
      </box>
      <SelectionMenuHint text={hint()} color={state().error ? COLOR.error : undefined} />
    </box>
  );
}
