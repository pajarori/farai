import { createTextAttributes } from "@opentui/core";
import { For, Show, type JSX } from "solid-js";
import type { TimelineRow } from "../../renderers";
import { COLOR } from "../../theme";
import { FaraiSpinner } from "../../common/spinner";
import { MarkdownView } from "../../markdown";

type PlanRowProps = {
  row: Extract<TimelineRow, { kind: "plan" }>;
  animated?: boolean | undefined;
};

const boldAttributes = createTextAttributes({ bold: true });
const completedAttributes = createTextAttributes({ dim: true, strikethrough: true });
const italicAttributes = createTextAttributes({ dim: true, italic: true });

export function PlanRow(props: PlanRowProps): JSX.Element {
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <Show when={props.row.streaming} fallback={
        <box style={{ flexDirection: "row" }}>
          <text fg={COLOR.dim}>{"• "}</text>
          <text fg={COLOR.text} attributes={boldAttributes}>{props.row.title}</text>
        </box>
      }>
        <FaraiSpinner label={props.row.title} color={COLOR.accent} animated={props.animated} />
      </Show>
      <Show when={props.row.explanation}>
        {(explanation) => <text fg={COLOR.dim} attributes={italicAttributes}>{`  └ ${explanation()}`}</text>}
      </Show>
      <Show when={props.row.items.length > 0}>
        <box style={{ flexDirection: "column" }}>
          <For each={props.row.items}>{(item, index) => (
            <box style={{ flexDirection: "row" }}>
              <text fg={COLOR.dim}>{!props.row.explanation && index() === 0 ? "  └ " : "    "}</text>
              <text fg={planItemColor(item.status)}>{`${planMarker(item.status)} `}</text>
              <text
                fg={planItemColor(item.status)}
                attributes={planItemAttributes(item.status)}
                wrapMode="word"
                style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}
              >
                {item.step}
              </text>
            </box>
          )}</For>
        </box>
      </Show>
      <Show when={props.row.markdown && props.row.items.length === 0}>
        {(markdown) => (
          <box style={{ flexDirection: "column", paddingLeft: 2, marginTop: 1 }}>
            <MarkdownView content={String(markdown())} streaming={props.row.streaming} />
          </box>
        )}
      </Show>
    </box>
  );
}

function planItemColor(status: string): string {
  if (status === "in_progress") return COLOR.accent;
  return COLOR.dim;
}

function planMarker(status: string): string {
  if (status === "completed") return "✔";
  return "□";
}

function planItemAttributes(status: string): number {
  if (status === "completed") return completedAttributes;
  if (status === "in_progress") return boldAttributes;
  return 0;
}
