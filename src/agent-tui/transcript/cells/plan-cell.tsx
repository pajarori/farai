import { For, Show, type JSX } from "solid-js";
import type { TimelineRow } from "../../renderers";
import { syntax } from "../../syntax";
import { COLOR } from "../../theme";
import { FaraiSpinner } from "../../common/spinner";

type PlanRowProps = {
  row: Extract<TimelineRow, { kind: "plan" }>;
};

export function PlanRow(props: PlanRowProps): JSX.Element {
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <Show when={props.row.streaming} fallback={<text fg={COLOR.text}>{`• ${props.row.title}`}</text>}>
        <FaraiSpinner label={props.row.title} color={COLOR.accent} />
      </Show>
      <Show when={props.row.explanation}>
        {(explanation) => <text fg={COLOR.dim}>{`  └ ${explanation()}`}</text>}
      </Show>
      <Show when={props.row.items.length > 0}>
        <box style={{ flexDirection: "column", paddingLeft: 2 }}>
          <For each={props.row.items}>{(item) => (
            <text fg={planItemColor(item.status)}>
              {`${planMarker(item.status)} ${item.step}`}
            </text>
          )}</For>
        </box>
      </Show>
      <Show when={props.row.markdown && props.row.items.length === 0}>
        {(markdown) => (
          <box style={{ flexDirection: "column", paddingLeft: 2, marginTop: 1 }}>
            <markdown content={String(markdown())} streaming={props.row.streaming} syntaxStyle={syntax()} fg={COLOR.markdownText} />
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
  if (status === "in_progress") return "□";
  return "□";
}
