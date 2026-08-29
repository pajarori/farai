import { useTerminalDimensions } from "@opentui/solid";
import type { JSX } from "solid-js";
import { useTuiStore } from "../context/store";
import { SelectionMenuHint, SelectionRow, selectionDescriptionColumn } from "../overlays/selection-row";
import { COLOR } from "../theme";

export function ModelProviderRemoval(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTerminalDimensions();
  const provider = () => tui.store.ui.modelProviderRemoval!;
  const title = () => `remove ${provider().id}`;
  const descriptionColumn = () => selectionDescriptionColumn([{ title: title() }], dims().width);

  return (
    <box id="model-provider-removal" style={{ flexShrink: 0, flexDirection: "column" }}>
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
        <text fg={COLOR.text}>{"  remove provider"}</text>
        <text fg={COLOR.dim}>{provider().source}</text>
      </box>
      <text fg={COLOR.accent} wrapMode="word" truncate>
        {`  remove ${provider().id}?`}
      </text>
      <box style={{ flexDirection: "column", marginTop: 1 }}>
        <SelectionRow
          title={title()}
          description="configuration, credential, and invalid model selections"
          selected
          width={dims().width}
          descriptionColumn={descriptionColumn()}
          titleColor={COLOR.error}
        />
      </box>
      <SelectionMenuHint text="enter remove · esc cancel" />
    </box>
  );
}
