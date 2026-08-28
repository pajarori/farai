import { For, Show, type JSX } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { TimelineRow } from "../../renderers";
import { truncateLine } from "../../renderers";
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
  const dims = useTerminalDimensions();
  const expanded = () => Boolean(tui.store.ui.expandedCells[props.row.id]);
  const widths = () => artifactLineWidths(dims().width, props.row.title, props.row.detail);
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }} onMouseUp={() => tui.actions.cellExpandedToggle(props.row.id)}>
      <box style={{ flexDirection: "row" }}>
        <text fg={COLOR.dim}>{"• "}</text>
        <text fg={COLOR.text}>{truncateLine(props.row.title, widths().title)}</text>
        <Show when={widths().detail > 0 && props.row.detail}>
          {(detail) => <text fg={COLOR.dim}>{truncateLine(` · ${detail()}`, widths().detail)}</text>}
        </Show>
      </box>
      <Show when={expanded() && props.row.body}>
        {(body) => (
          <ExpandedPanel id={`${props.row.id}:expanded`}>
            <Show
              when={props.row.bodyFormat === "text"}
              fallback={<markdown content={body()} streaming={false} internalBlockMode="top-level" syntaxStyle={syntax()} fg={COLOR.text} />}
            >
              <code content={body()} filetype="text" syntaxStyle={syntax()} fg={COLOR.text} />
            </Show>
          </ExpandedPanel>
        )}
      </Show>
    </box>
  );
}

export function artifactLineWidths(totalWidth: number, title: string, detail: string): { title: number; detail: number } {
  const available = Math.max(1, Math.floor(totalWidth) - 4);
  if (!detail) return { title: available, detail: 0 };
  const decoratedDetailLength = detail.length + 3;
  if (title.length + decoratedDetailLength <= available) {
    return { title: title.length, detail: decoratedDetailLength };
  }
  const reservedDetail = Math.min(decoratedDetailLength, Math.max(0, Math.floor(available * 0.4)));
  const titleWidth = Math.max(1, Math.min(title.length, available - reservedDetail));
  return { title: titleWidth, detail: Math.max(0, available - titleWidth) };
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
