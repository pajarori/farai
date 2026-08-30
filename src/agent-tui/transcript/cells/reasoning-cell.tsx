import { Show, createMemo, type JSX } from "solid-js";
import type { TimelineRow } from "../../renderers";
import { truncateLine } from "../../renderers";
import { COLOR } from "../../theme";
import { MarkdownView } from "../../markdown";
import { useTuiDimensions } from "../../context/terminal";
import { useTuiStore } from "../../context/store";
import { ExpandedPanel } from "./expanded-panel";
import { TranscriptMarker } from "./transcript-marker";
import { createPrimaryClickGesture } from "../../input/mouse";
import { parseReasoning } from "../../reasoning";

type ReasoningRowProps = {
  row: Extract<TimelineRow, { kind: "thinking" }>;
  streamedReasoning?: string | undefined;
  animated?: boolean | undefined;
};

export function ReasoningRow(props: ReasoningRowProps): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  const expanded = () => Boolean(tui.store.ui.expandedCells[props.row.id]);
  const content = createMemo(() => props.streamedReasoning === undefined
    ? { title: props.row.title, body: props.row.body }
    : parseReasoning(props.streamedReasoning));
  const label = () => truncateLine(content().title === "reasoning" ? "thinking" : content().title, Math.max(1, dims().width - 4));
  const toggleClick = createPrimaryClickGesture(() => tui.actions.cellExpandedToggle(props.row.id));
  return (
    <box style={{ flexDirection: "column", flexShrink: 0, marginBottom: 1 }}>
      <box style={{ flexDirection: "row", flexShrink: 0 }} {...toggleClick}>
        <TranscriptMarker color={COLOR.dim} spinning={props.row.streaming} animated={props.animated} />
        <text fg={COLOR.dim}>{label()}</text>
      </box>
      <Show when={expanded() && content().body.trim()}>
        <ExpandedPanel>
          <MarkdownView id={`${props.row.id}:markdown`} content={content().body} streaming={props.row.streaming} fg={COLOR.dim} />
        </ExpandedPanel>
      </Show>
    </box>
  );
}
