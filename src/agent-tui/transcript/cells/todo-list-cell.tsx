import { Index, type JSX } from "solid-js";
import type { TimelineRow } from "../../renderers";
import { COLOR } from "../../theme";

type TodoListRowProps = {
  row: Extract<TimelineRow, { kind: "todo_list" }>;
};

export function TodoListRow(props: TodoListRowProps): JSX.Element {
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <text fg={COLOR.text}>{`• ${props.row.title}`}</text>
      <box style={{ flexDirection: "column", paddingLeft: 2 }}>
        <Index each={props.row.items}>{(item) => (
          <text fg={todoItemColor(item().status)}>
            {`${todoMarker(item().status)} ${item().text}${item().priority ? ` · ${item().priority}` : ""}`}
          </text>
        )}</Index>
      </box>
    </box>
  );
}

function todoItemColor(status: string): string {
  if (status === "in_progress") return COLOR.accent;
  if (status === "blocked") return COLOR.warning;
  return COLOR.dim;
}

function todoMarker(status: string): string {
  if (status === "completed") return "✔";
  if (status === "in_progress") return "◒";
  if (status === "blocked") return "!";
  return "□";
}
