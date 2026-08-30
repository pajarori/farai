import { Show, type JSX } from "solid-js";
import { isPrimaryClick } from "../input/mouse";
import { truncateLine } from "../renderers";
import { COLOR } from "../theme";
import { clipTerminal, terminalWidth } from "../terminal-text";
import { useTuiDimensions } from "../context/terminal";

export type SelectionRowLayoutItem = {
  number?: number;
  title: string;
  current?: boolean | undefined;
  badge?: string | undefined;
};

export type SelectionRowProps = SelectionRowLayoutItem & {
  description?: string | undefined;
  selected: boolean;
  disabled?: boolean | undefined;
  width: number;
  descriptionColumn: number;
  titleColor?: string | undefined;
  onSelect?: (() => void) | undefined;
};

export function SelectionMenuHint(props: { text: string; color?: string | undefined }): JSX.Element {
  const dims = useTuiDimensions();
  return (
    <box style={{ height: 2, flexShrink: 0, paddingTop: 1 }}>
      <text fg={props.color ?? COLOR.dim}>{`  ${truncateLine(props.text, Math.max(1, dims().width - 2))}`}</text>
    </box>
  );
}

export function SelectionRow(props: SelectionRowProps): JSX.Element {
  const title = () => `${props.title}${props.current ? " (current)" : props.badge ? ` (${props.badge})` : ""}`;
  const prefix = () => props.number === undefined
    ? `${props.selected ? "›" : " "}   `
    : `${props.selected ? "›" : " "} ${props.number}. `;
  const descriptionVisible = () => Boolean(props.description && props.width - props.descriptionColumn - 1 >= 8);
  const leftLimit = () => Math.max(0, Math.min(props.width, descriptionVisible() ? props.descriptionColumn : props.width));
  const prefixText = () => clipTerminal(prefix(), leftLimit());
  const prefixWidth = () => terminalWidth(prefixText());
  const titleWidth = () => Math.max(0, leftLimit() - prefixWidth());
  const visibleTitle = () => truncateLine(title(), titleWidth());
  const leftWidth = () => prefixWidth() + terminalWidth(visibleTitle());
  const gap = () => Math.max(1, props.descriptionColumn - leftWidth());
  const descriptionWidth = () => Math.max(0, props.width - leftWidth() - gap());

  return (
    <box
      style={{ flexDirection: "row" }}
      onMouseUp={(event) => {
        if (!isPrimaryClick(event) || props.disabled) return;
        props.onSelect?.();
      }}
    >
      <text selectable={false} fg={props.selected ? COLOR.accent : COLOR.dim}>{prefixText()}</text>
      <Show when={titleWidth() > 0}>
        <text selectable={false} fg={props.disabled ? COLOR.dim : props.titleColor ?? COLOR.text}>{visibleTitle()}</text>
      </Show>
      <Show when={descriptionVisible() ? props.description : undefined}>
        {(description) => (
          <text selectable={false} fg={COLOR.dim}>
            {`${" ".repeat(gap())}${truncateLine(description(), descriptionWidth())}`}
          </text>
        )}
      </Show>
    </box>
  );
}

export function selectionDescriptionColumn(rows: SelectionRowLayoutItem[], width: number): number {
  const longest = rows.reduce((max, row) => Math.max(
    max,
    terminalWidth(`${row.number === undefined ? "" : `${row.number}. `}${row.title}${row.current ? " (current)" : row.badge ? ` (${row.badge})` : ""}`) + 2
  ), 0);
  const maxLeft = Math.max(1, Math.min(width, Math.max(18, Math.floor(width * 0.46))));
  return Math.min(Math.max(24, longest + 2), maxLeft);
}
