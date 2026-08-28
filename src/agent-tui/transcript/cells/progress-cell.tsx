import { Show, type JSX } from "solid-js";
import type { TimelineRow } from "../../renderers";
import { COLOR } from "../../theme";
import { FaraiSpinner } from "../../common/spinner";

type ProgressRowProps = {
  row: Extract<TimelineRow, { kind: "progress" }>;
};

type PhaseRowProps = {
  row: Extract<TimelineRow, { kind: "phase" }>;
};

export function ProgressRow(props: ProgressRowProps): JSX.Element {
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <Show when={props.row.status === "running"} fallback={<text fg={COLOR.dim}>{`• ${props.row.title}${props.row.detail ? ` · ${props.row.detail}` : ""}`}</text>}>
        <FaraiSpinner label={`${props.row.title}${props.row.detail ? ` · ${props.row.detail}` : ""}`} color={COLOR.dim} />
      </Show>
    </box>
  );
}

export function PhaseRow(props: PhaseRowProps): JSX.Element {
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <text fg={COLOR.dim}>{`• phase changed · ${props.row.phase}${props.row.detail ? ` · ${props.row.detail}` : ""}`}</text>
    </box>
  );
}
