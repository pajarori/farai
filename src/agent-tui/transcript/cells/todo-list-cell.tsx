import { createTextAttributes } from "@opentui/core";
import { Index, type JSX } from "solid-js";
import type { TimelineRow } from "../../renderers";
import { COLOR } from "../../theme";

type TodoListRowProps = {
  row: Extract<TimelineRow, { kind: "todo_list" }>;
};

const boldAttributes = createTextAttributes({ bold: true });
const completedAttributes = createTextAttributes({ dim: true, strikethrough: true });

export function TodoListRow(props: TodoListRowProps): JSX.Element {
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <box style={{ flexDirection: "row" }}>
        <text fg={COLOR.dim}>{"• "}</text>
        <text fg={COLOR.text} attributes={boldAttributes}>{props.row.title}</text>
      </box>
      <box style={{ flexDirection: "column" }}>
        <Index each={props.row.items}>{(item, index) => (
          <box style={{ flexDirection: "row" }}>
            <text fg={COLOR.dim}>{index === 0 ? "  └ " : "    "}</text>
            <text fg={todoItemColor(item().status)}>{`${todoMarker(item().status)} `}</text>
            <text
              fg={todoItemColor(item().status)}
              attributes={todoItemAttributes(item().status)}
              wrapMode="word"
              style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}
            >
              {`${item().text}${item().priority ? ` · ${item().priority}` : ""}`}
            </text>
          </box>
        )}</Index>
      </box>
    </box>
  );
}

function todoItemColor(status: string): string {
  if (status === "in_progress") return COLOR.accent;
  if (status === "blocked") return COLOR.warning;
  if (status === "completed") return COLOR.dim;
  return COLOR.muted;
}

function todoMarker(status: string): string {
  if (status === "completed") return "✔";
  if (status === "blocked") return "✗";
  return "□";
}

function todoItemAttributes(status: string): number {
  if (status === "completed") return completedAttributes;
  if (status === "in_progress") return boldAttributes;
  return 0;
}
