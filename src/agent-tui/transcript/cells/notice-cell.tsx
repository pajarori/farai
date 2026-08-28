import { Show, type JSX } from "solid-js";
import type { TimelineRow } from "../../renderers";
import { useTuiStore } from "../../context/store";
import { syntax } from "../../syntax";
import { COLOR } from "../../theme";
import { ExpandedPanel } from "./expanded-panel";

type NoticeRowProps = {
  row: Extract<TimelineRow, { kind: "loop_stop" | "compaction" | "error" | "notice" }>;
};

export function NoticeRow(props: NoticeRowProps): JSX.Element {
  const tui = useTuiStore();
  const expanded = () => Boolean(tui.store.ui.expandedCells[props.row.id]);
  const color = () => {
    if (props.row.kind === "error") return COLOR.error;
    if (props.row.kind === "notice" && props.row.tone === "warning") return COLOR.warning;
    if (props.row.kind === "notice" && props.row.tone === "success") return COLOR.success;
    return COLOR.dim;
  };
  const label = () => {
    if (props.row.kind === "compaction") return "compacted context";
    if (props.row.kind === "loop_stop") return props.row.reason;
    if (props.row.kind === "notice") return props.row.title;
    return props.row.title;
  };
  const detail = () => props.row.kind === "notice" ? props.row.detail : props.row.text;
  const body = () => {
    if (props.row.kind === "compaction") return props.row.summary;
    if (props.row.kind === "error" || props.row.kind === "notice") return props.row.body;
    return undefined;
  };
  const expandable = () => Boolean(body());
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }} onMouseUp={() => expandable() && tui.actions.cellExpandedToggle(props.row.id)}>
      <text fg={color()}>{`• ${label()}${props.row.kind !== "error" && detail() ? ` · ${detail()}` : ""}`}</text>
      <Show when={props.row.kind === "error" && detail()}>
        <box style={{ flexDirection: "column", paddingLeft: 2 }}>
          <text fg={COLOR.dim}>{`└ ${detail()}`}</text>
        </box>
      </Show>
      <Show when={expanded() && body()}>
        {(content) => (
          <ExpandedPanel>
            <markdown content={content()} streaming={false} syntaxStyle={syntax()} fg={props.row.kind === "error" ? COLOR.error : COLOR.dim} />
          </ExpandedPanel>
        )}
      </Show>
    </box>
  );
}
