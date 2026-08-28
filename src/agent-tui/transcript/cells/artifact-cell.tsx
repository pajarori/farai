import { For, Show, type JSX } from "solid-js";
import type { TimelineRow } from "../../renderers";
import { COLOR } from "../../theme";
import { useTuiStore } from "../../context/store";
import { syntax } from "../../syntax";
import { ExpandedPanel } from "./expanded-panel";

type ArtifactRowProps = {
  row: Extract<TimelineRow, { kind: "artifact" }>;
};

type McpInventoryRowProps = {
  row: Extract<TimelineRow, { kind: "mcp_inventory" }>;
};

type FindingRowProps = {
  row: Extract<TimelineRow, { kind: "finding" }>;
};

export function ArtifactRow(props: ArtifactRowProps): JSX.Element {
  const tui = useTuiStore();
  const expanded = () => Boolean(tui.store.ui.expandedCells[props.row.id]);
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }} onMouseUp={() => tui.actions.cellExpandedToggle(props.row.id)}>
      <box style={{ flexDirection: "row" }}>
        <text fg={COLOR.dim}>{"• "}</text>
        <text fg={COLOR.text}>{props.row.title}</text>
        <Show when={props.row.detail}>
          {(detail) => <text fg={COLOR.dim}>{` · ${detail()}`}</text>}
        </Show>
      </box>
      <Show when={expanded() && props.row.body}>
        {(body) => (
          <ExpandedPanel>
            <markdown content={body()} streaming={false} internalBlockMode="top-level" syntaxStyle={syntax()} fg={COLOR.text} />
          </ExpandedPanel>
        )}
      </Show>
    </box>
  );
}

export function McpInventoryRow(props: McpInventoryRowProps): JSX.Element {
  const tui = useTuiStore();
  const expanded = () => Boolean(tui.store.ui.expandedCells[props.row.id]);
  const lines = () => props.row.text.split("\n");
  const preview = () => expanded() ? lines() : lines().slice(0, 12);
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }} onMouseUp={() => tui.actions.cellExpandedToggle(props.row.id)}>
      <box style={{ flexDirection: "row" }}>
        <text fg={COLOR.dim}>{"• "}</text>
        <text fg={COLOR.text}>{"mcp tools"}</text>
      </box>
      <box style={{ flexDirection: "column", paddingLeft: 2, ...(expanded() ? { marginTop: 1, paddingRight: 2, paddingTop: 1, paddingBottom: 1, backgroundColor: COLOR.panelActive } : {}) }}>
        <For each={preview()}>
          {(line, index) => <text fg={index() === 0 ? COLOR.text : COLOR.dim}>{`${index() === 0 ? "└ " : "  "}${line}`}</text>}
        </For>
        <Show when={!expanded() && lines().length > preview().length}>
          <text fg={COLOR.dim}>{`  ... +${lines().length - preview().length} lines`}</text>
        </Show>
      </box>
    </box>
  );
}

export function FindingRow(props: FindingRowProps): JSX.Element {
  const tui = useTuiStore();
  const expanded = () => Boolean(tui.store.ui.expandedCells[props.row.id]);
  const color = () => severityColor(props.row.severity);
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }} onMouseUp={() => tui.actions.cellExpandedToggle(props.row.id)}>
      <box style={{ flexDirection: "row" }}>
        <text fg={color()}>{`• ${props.row.severity.toLowerCase()} `}</text>
        <text fg={COLOR.text}>{props.row.title}</text>
      </box>
      <Show when={props.row.detail}>
        {(detail) => <text fg={COLOR.dim}>{`  └ ${detail()}`}</text>}
      </Show>
      <Show when={expanded() && props.row.body}>
        {(body) => (
          <ExpandedPanel>
            <markdown content={body()} streaming={false} internalBlockMode="top-level" syntaxStyle={syntax()} fg={COLOR.text} />
          </ExpandedPanel>
        )}
      </Show>
    </box>
  );
}

function severityColor(severity: string): string {
  if (severity === "critical" || severity === "high") return COLOR.error;
  if (severity === "medium") return COLOR.warning;
  if (severity === "low") return COLOR.accent;
  return COLOR.dim;
}
