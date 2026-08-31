import { For, createMemo, type JSX } from "solid-js";
import { useTuiDimensions } from "../context/terminal";
import { SelectionRow, selectionDescriptionColumn } from "../overlays/selection-row";

export type WizardChoiceRow = readonly [value: string, title: string, description: string];

export function WizardChoiceRows(props: {
  rows: readonly WizardChoiceRow[];
  selected(): string;
  choose(value: string): void;
  visibleLimit?: number;
  descriptionMinWidth?: number;
}): JSX.Element {
  const dims = useTuiDimensions();
  const limit = () => Math.max(1, Math.min(6, props.visibleLimit ?? 6));
  const visible = createMemo(() => {
    const selected = Math.max(0, props.rows.findIndex((row) => row[0] === props.selected()));
    const start = Math.max(0, Math.min(selected - 1, props.rows.length - limit()));
    return props.rows.slice(start, start + limit()).map((row, index) => ({ row, number: start + index + 1 }));
  });
  const descriptionColumn = createMemo(() => selectionDescriptionColumn(
    props.rows.map((row, index) => ({ number: index + 1, title: row[1] })),
    dims().width
  ));
  return (
    <box style={{ height: 7, flexShrink: 0, flexDirection: "column", paddingTop: 1, overflow: "hidden" }}>
      <For each={visible()}>{(item) => {
        const selected = () => props.selected() === item.row[0];
        return <SelectionRow
          number={item.number}
          title={item.row[1]}
          description={dims().width >= (props.descriptionMinWidth ?? 58) ? item.row[2] : undefined}
          selected={selected()}
          width={dims().width}
          descriptionColumn={descriptionColumn()}
          onSelect={() => props.choose(item.row[0])}
        />;
      }}</For>
    </box>
  );
}
