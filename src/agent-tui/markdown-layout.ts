import {
  StyledText,
  TextRenderable,
  TextTableRenderable,
  createTextAttributes,
  parseColor,
  type BaseRenderable,
  type TextChunk
} from "@opentui/core";
import { terminalWidth } from "./terminal-text";
import { COLOR } from "./theme";

const tableRuleColor = parseColor(COLOR.dim);
const unorderedListMarkerColors = [parseColor(COLOR.accent), parseColor(COLOR.muted), parseColor(COLOR.dim)] as const;
const unorderedListMarkers = ["•", "›", "·"] as const;
const tableResizeHooks = new WeakSet<TextTableRenderable>();
const enhancedTables = new WeakMap<TextTableRenderable, {
  source: TextChunk[][][];
  decorated: TextChunk[][][];
  width: number;
  scheduled: boolean;
}>();

function tableCellText(cell: TextChunk[] | null | undefined): string {
  return cell?.map((chunk) => chunk.text).join("") ?? "";
}

function tableSeparatorRow(source: TextChunk[][][], availableWidth: number): TextChunk[][] {
  const columnCount = source[0]?.length ?? 0;
  if (columnCount === 0) return [];
  const contentWidth = Math.max(1, availableWidth - Math.max(0, columnCount - 1) * 2 - columnCount * 2);
  const widthPerColumn = Math.max(3, Math.floor(contentWidth / columnCount));
  return Array.from({ length: columnCount }, (_, columnIndex) => {
    const intrinsicWidth = Math.max(3, ...source.map((row) => terminalWidth(tableCellText(row[columnIndex]))));
    return [{
      __isChunk: true,
      text: "━".repeat(Math.min(intrinsicWidth, widthPerColumn)),
      fg: tableRuleColor,
      attributes: createTextAttributes({ dim: true })
    }];
  });
}

function applyTableHeaderRule(table: TextTableRenderable): void {
  let state = enhancedTables.get(table);
  const current = table.content as TextChunk[][][];
  if (!state || current !== state.decorated) {
    state = { source: current, decorated: current, width: -1, scheduled: false };
    enhancedTables.set(table, state);
  }

  table.columnWidthMode = "content";
  table.columnFitter = "balanced";
  table.wrapMode = "word";
  table.cellPaddingX = 1;
  table.cellPaddingY = 0;
  table.columnGap = 2;
  table.border = false;
  table.outerBorder = false;
  table.showBorders = false;

  if (state.source.length < 2) return;
  const width = Math.max(1, table.width || table.ctx.width);
  if (state.decorated !== state.source && state.width === width && table.content === state.decorated) return;
  state.width = width;
  state.decorated = [state.source[0]!, tableSeparatorRow(state.source, width), ...state.source.slice(1)];
  table.content = state.decorated;

  if (tableResizeHooks.has(table)) return;
  tableResizeHooks.add(table);
  const previousSizeChange = table.onSizeChange;
  table.onSizeChange = function () {
    previousSizeChange?.call(table);
    const active = enhancedTables.get(table);
    if (!active || active.scheduled) return;
    active.scheduled = true;
    queueMicrotask(() => {
      active.scheduled = false;
      if (!table.isDestroyed) applyTableHeaderRule(table);
    });
  };
}

function decorateUnorderedListMarker(renderable: TextRenderable): void {
  if (!renderable.id.endsWith("-marker")) return;
  if (renderable.chunks.map((chunk) => chunk.text).join("").trim() !== "-") return;
  const depth = Math.max(0, (renderable.id.match(/-item-\d+/g)?.length ?? 1) - 1);
  const index = depth % unorderedListMarkers.length;
  renderable.content = new StyledText([{
    __isChunk: true,
    text: `${unorderedListMarkers[index]!} `,
    fg: unorderedListMarkerColors[index]!
  }]);
}

export function decorateMarkdownLayout(renderable: BaseRenderable): boolean {
  if (renderable instanceof TextTableRenderable) {
    applyTableHeaderRule(renderable);
    return true;
  }
  if (renderable instanceof TextRenderable) {
    decorateUnorderedListMarker(renderable);
    return true;
  }
  return false;
}
