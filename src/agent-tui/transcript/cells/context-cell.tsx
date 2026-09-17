import { For, Show, type JSX } from "solid-js";
import type { TimelineRow } from "../../renderers";
import type { ContextTone } from "../../../agent-core/context-report";
import { COLOR } from "../../theme";
import { TranscriptMarker } from "./transcript-marker";

type ContextRowProps = {
  row: Extract<TimelineRow, { kind: "context" }>;
};

const TONE_COLOR: Record<ContextTone, string> = {
  system: COLOR.dim,
  tools: COLOR.accent,
  instructions: COLOR.warning,
  capabilities: COLOR.memory.hypothesis,
  working: COLOR.memory.service,
  retrieved: COLOR.memory.endpoint,
  ephemeral: COLOR.memory.credential,
  messages: COLOR.success,
  free: COLOR.border
};

function toneColor(tone: ContextTone): string {
  return TONE_COLOR[tone] ?? COLOR.dim;
}

function shortTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return `${value}`;
}

function percent(ratio: number): string {
  const value = ratio * 100;
  return value > 0 && value < 0.1 ? "<0.1%" : `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

type LegendLine = { dot?: ContextTone; text: string; color: string };

export function ContextRow(props: ContextRowProps): JSX.Element {
  const report = () => props.row.report;
  const columns = () => Math.max(1, report().columns);
  const gridRows = () => {
    const cells = report().grid;
    const width = columns();
    const rows: ContextTone[][] = [];
    for (let index = 0; index < cells.length; index += width) rows.push(cells.slice(index, index + width));
    return rows;
  };
  const legend = (): LegendLine[] => {
    const current = report();
    const lines: LegendLine[] = [
      { text: current.model || "context", color: COLOR.text },
      { text: `${shortTokens(current.used)}/${shortTokens(current.window)} tokens (${percent(current.ratio)})`, color: COLOR.dim },
      { text: "", color: COLOR.dim },
      { text: "by category", color: COLOR.dim }
    ];
    for (const slice of current.slices) {
      lines.push({ dot: slice.tone, text: `${slice.label}: ${shortTokens(slice.tokens)} tokens (${percent(slice.ratio)})`, color: COLOR.dim });
    }
    lines.push({ dot: "free", text: `free space: ${shortTokens(current.free)} (${percent(current.free / current.window)})`, color: COLOR.dim });
    return lines;
  };
  const outputRows = () => Math.max(gridRows().length, legend().length);

  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <box style={{ flexDirection: "row" }}>
        <TranscriptMarker color={COLOR.accent} />
        <text fg={COLOR.accent}>{"context usage"}</text>
      </box>
      <box style={{ height: 1 }} />
      <box style={{ flexDirection: "column", paddingLeft: 2 }}>
        <For each={Array.from({ length: outputRows() })}>{(_, index) => {
          const grid = () => gridRows()[index()];
          const line = () => legend()[index()];
          return (
            <box style={{ flexDirection: "row" }}>
              <Show when={grid()} fallback={<text>{" ".repeat(columns() * 2)}</text>}>
                <For each={grid()!}>{(tone) => (
                  <text fg={toneColor(tone)}>{tone === "free" ? "⛶ " : "⛁ "}</text>
                )}</For>
                <Show when={grid()!.length < columns()}>
                  <text>{" ".repeat((columns() - grid()!.length) * 2)}</text>
                </Show>
              </Show>
              <Show when={line()}>
                <text>{"  "}</text>
                <Show when={line()!.dot}>
                  <text fg={toneColor(line()!.dot!)}>{"⛁ "}</text>
                </Show>
                <text fg={line()!.color}>{line()!.text}</text>
              </Show>
            </box>
          );
        }}</For>
      </box>
    </box>
  );
}
