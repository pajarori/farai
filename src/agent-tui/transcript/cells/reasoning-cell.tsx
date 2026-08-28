import { Show, type JSX } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { TimelineRow } from "../../renderers";
import { truncateLine } from "../../renderers";
import { syntax } from "../../syntax";
import { COLOR } from "../../theme";
import { useTuiStore } from "../../context/store";
import { ExpandedPanel } from "./expanded-panel";
import { TranscriptMarker } from "./transcript-marker";
import { createPrimaryClickGesture } from "../../input/mouse";

type ReasoningRowProps = {
  row: Extract<TimelineRow, { kind: "thinking" }>;
};

export function ReasoningRow(props: ReasoningRowProps): JSX.Element {
  const tui = useTuiStore();
  const dims = useTerminalDimensions();
  const expanded = () => Boolean(tui.store.ui.expandedCells[props.row.id]);
  const label = () => truncateLine(props.row.title === "reasoning" ? "thinking" : props.row.title, Math.max(1, dims().width - 4));
  const toggleClick = createPrimaryClickGesture(() => tui.actions.cellExpandedToggle(props.row.id));
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <box style={{ flexDirection: "row" }} {...toggleClick}>
        <TranscriptMarker color={COLOR.dim} spinning={props.row.streaming} />
        <text fg={COLOR.dim}>{label()}</text>
      </box>
      <Show when={expanded() && props.row.body.trim()}>
        <ExpandedPanel>
          <markdown content={props.row.body} streaming={props.row.streaming} internalBlockMode="top-level" syntaxStyle={syntax()} fg={COLOR.dim} />
        </ExpandedPanel>
      </Show>
    </box>
  );
}
