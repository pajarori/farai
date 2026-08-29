import { Show, type JSX } from "solid-js";
import { isPrimaryClick } from "../input/mouse";
import { truncateLine } from "../renderers";
import { COLOR } from "../theme";
import { terminalWidth } from "../terminal-text";

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

export function SelectionMenuHint(props: { text: string }): JSX.Element {
  return (
    <box style={{ marginTop: 1 }}>
      <text fg={COLOR.dim}>{`  ${props.text}`}</text>
    </box>
  );
}

export function SelectionRow(props: SelectionRowProps): JSX.Element {
  const title = () => `${props.title}${props.current ? " (current)" : props.badge ? ` (${props.badge})` : ""}`;
  const prefix = () => props.number === undefined
    ? `${props.selected ? "›" : " "}   `
    : `${props.selected ? "›" : " "} ${props.number}. `;
  const left = () => `${prefix()}${title()}`;
  const leftWidth = () => Math.min(props.descriptionColumn - 2, terminalWidth(left()));
  const gap = () => Math.max(2, props.descriptionColumn - leftWidth());
  const descriptionWidth = () => Math.max(8, props.width - props.descriptionColumn - 1);

  return (
    <box
      style={{ flexDirection: "row" }}
      onMouseUp={(event) => {
        if (!isPrimaryClick(event) || props.disabled) return;
        props.onSelect?.();
      }}
    >
      <text selectable={false} fg={props.selected ? COLOR.accent : COLOR.dim}>{prefix()}</text>
      <text selectable={false} fg={props.disabled ? COLOR.dim : props.titleColor ?? COLOR.text}>
        {truncateLine(title(), Math.max(4, props.descriptionColumn - terminalWidth(prefix()) - 2))}
      </text>
      <Show when={props.description}>
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
  const maxLeft = Math.max(18, Math.floor(width * 0.46));
  return Math.min(Math.max(24, longest + 2), maxLeft);
}
