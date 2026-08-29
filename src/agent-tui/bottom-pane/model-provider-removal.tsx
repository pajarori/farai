import { useTerminalDimensions } from "@opentui/solid";
import type { JSX } from "solid-js";
import { useTuiStore } from "../context/store";
import { SelectionMenuHint, SelectionRow, selectionDescriptionColumn } from "../overlays/selection-row";
import { COLOR } from "../theme";
import { truncateLine } from "../renderers";
import { fitTerminalPair } from "../terminal-text";

export function ModelProviderRemoval(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTerminalDimensions();
  const state = () => tui.store.ui.modelProviderRemoval!;
  const provider = () => state().provider;
  const title = () => `remove ${provider().id}`;
  const descriptionColumn = () => selectionDescriptionColumn([{ title: title() }], dims().width);
  const header = () => fitTerminalPair("remove provider", provider().source, Math.max(1, dims().width - 4), 8, 1);
  const hint = () => state().busy
    ? `removing ${provider().id}…`
    : state().error
      ? `error · ${state().error}`
      : "enter remove · esc cancel";

  return (
    <box id="model-provider-removal" style={{ flexShrink: 0, flexDirection: "column" }}>
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between", paddingLeft: 2, paddingRight: 2 }}>
        <text fg={COLOR.text}>{header().left}</text>
        <text fg={COLOR.dim}>{header().right}</text>
      </box>
      <text fg={COLOR.accent}>{`  ${truncateLine(`remove ${provider().id}?`, Math.max(1, dims().width - 2))}`}</text>
      <box style={{ flexDirection: "column", marginTop: 1 }}>
        <SelectionRow
          title={title()}
          description="configuration, credential, and invalid model selections"
          selected
          disabled={state().busy}
          width={dims().width}
          descriptionColumn={descriptionColumn()}
          titleColor={COLOR.error}
        />
      </box>
      <SelectionMenuHint text={hint()} color={state().error ? COLOR.error : undefined} />
    </box>
  );
}
