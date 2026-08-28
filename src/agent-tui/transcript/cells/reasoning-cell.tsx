import { Show, type JSX } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { TimelineRow } from "../../renderers";
import { truncateLine } from "../../renderers";
import { syntax } from "../../syntax";
import { COLOR } from "../../theme";
import { FaraiSpinner } from "../../common/spinner";
import { useTuiStore } from "../../context/store";
import { ExpandedPanel } from "./expanded-panel";

type ReasoningRowProps = {
  row: Extract<TimelineRow, { kind: "thinking" }>;
};

export function ReasoningRow(props: ReasoningRowProps): JSX.Element {
  const tui = useTuiStore();
  const dims = useTerminalDimensions();
  const expanded = () => Boolean(tui.store.ui.expandedCells[props.row.id]);
  const label = () => truncateLine(props.row.title === "reasoning" ? "thinking" : props.row.title, Math.max(1, dims().width - 4));
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }} onMouseUp={() => tui.actions.cellExpandedToggle(props.row.id)}>
      <box style={{ flexDirection: "row" }}>
        <Show when={props.row.streaming} fallback={<text fg={COLOR.dim}>{`• ${label()}`}</text>}>
          <FaraiSpinner label={label()} color={COLOR.dim} />
        </Show>
      </box>
      <Show when={expanded() && props.row.body.trim()}>
        <ExpandedPanel>
          <markdown content={props.row.body} streaming={props.row.streaming} internalBlockMode="top-level" syntaxStyle={syntax()} fg={COLOR.dim} />
        </ExpandedPanel>
      </Show>
    </box>
  );
}
