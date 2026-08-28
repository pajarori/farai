import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { For, Show, createEffect, createMemo, type JSX } from "solid-js";
import { useTuiStore } from "../context/store";
import { formatPayload, truncateLine, type TimelineRow } from "../renderers";
import { formatCompactSummary } from "../../agent-core/loop/compaction";
import { COLOR } from "../theme";
import { FaraiRow } from "./cells";

export function Transcript(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTerminalDimensions();
  let scrollRef!: ScrollBoxRenderable;
  let navigationIndex = -1;
  const rowCache = new Map<string, TimelineRow>();

  const transcriptRows = createMemo(() => {
    const boundary = tui.store.snapshot.compactionBoundary;
    const summary = boundary ? formatCompactSummary(boundary.summary) : "";
    const compactRow: TimelineRow[] = boundary ? [{
      kind: "compaction",
      id: boundary.id,
      text: boundary.preCompactTokens !== undefined && boundary.postCompactTokens !== undefined
        ? `${boundary.preCompactTokens} → ${boundary.postCompactTokens} tokens`
        : "",
      ...(summary ? { summary } : {})
    }] : [];
    return [...compactRow, ...tui.timelineRows()];
  });
  const indexedRows = createMemo(() => {
    const ids: string[] = [];
    const projectedById = new Map<string, TimelineRow>();
    for (const row of transcriptRows()) {
      if (!projectedById.has(row.id)) ids.push(row.id);
      projectedById.set(row.id, row);
    }
    const byId = new Map<string, TimelineRow>();
    for (const id of ids) {
      const row = projectedById.get(id)!;
      const cached = rowCache.get(row.id);
      const stable = cached && timelineRowsEqual(cached, row) ? cached : row;
      if (stable === row) rowCache.set(row.id, row);
      byId.set(row.id, stable);
    }
    for (const id of rowCache.keys()) if (!projectedById.has(id)) rowCache.delete(id);
    return { ids, byId };
  });
  const rawRows = createMemo(() => tui.store.snapshot.messages.flatMap((message) => (
    message.parts.map((part) => `${message.role}.${part.type} ${formatPayload(part.payload, 16_000)}`)
  )));

  createEffect(() => {
    const request = tui.store.ui.messageNavigation;
    if (request.sequence === 0 || !scrollRef) return;
    const users = transcriptRows().filter((row) => row.kind === "user");
    if (users.length === 0) return;
    navigationIndex = nextNavigationIndex(request.direction, navigationIndex, users.length);
    try { scrollRef.scrollChildIntoView(users[navigationIndex]!.id); } catch {  }
  });

  return (
    <scrollbox
      ref={scrollRef}
      stickyScroll
      stickyStart="bottom"
      scrollbarOptions={{ visible: false }}
      style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column" }}
    >
      <Show
        when={indexedRows().ids.length > 0}
        fallback={
          <box style={{ flexDirection: "column", marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
            <text fg={COLOR.dim}>{"› message farai to get started"}</text>
            <text fg={COLOR.dim}>{"  / opens commands · ? shows shortcuts"}</text>
          </box>
        }
      >
        <Show when={tui.store.ui.rawOutput} fallback={
          <For each={indexedRows().ids}>{(id) => <TranscriptRow row={indexedRows().byId.get(id)!} />}</For>
        }>
          <For each={rawRows()}>{(row) => (
            <box style={{ flexDirection: "column", marginBottom: 1, paddingLeft: 1, paddingRight: 1 }}>
              <For each={row.split("\n")}>{(line) => <text fg={COLOR.dim}>{truncateLine(line, Math.max(1, dims().width - 4))}</text>}</For>
            </box>
          )}</For>
        </Show>
      </Show>
    </scrollbox>
  );
}

function nextNavigationIndex(direction: "next" | "prev", currentIndex: number, itemCount: number): number {
  if (direction === "next") return Math.min(itemCount - 1, currentIndex + 1);
  if (currentIndex < 0) return itemCount - 1;
  return Math.max(0, currentIndex - 1);
}

function timelineRowsEqual(left: TimelineRow, right: TimelineRow): boolean {
  return left.kind === right.kind && left.id === right.id && valuesEqual(left, right, new WeakMap());
}

function valuesEqual(left: unknown, right: unknown, seen: WeakMap<object, WeakSet<object>>): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!valuesEqual(left[index], right[index], seen)) return false;
    }
    return true;
  }
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  const paired = seen.get(left);
  if (paired?.has(right)) return true;
  if (paired) paired.add(right);
  else seen.set(left, new WeakSet([right]));
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
    if (!valuesEqual(leftRecord[key], rightRecord[key], seen)) return false;
  }
  return true;
}

type TranscriptRowProps = {
  row: TimelineRow;
};

function TranscriptRow(props: TranscriptRowProps): JSX.Element {
  const isUser = props.row.kind === "user";
  return (
    <box
      id={props.row.id}
      style={{
        flexDirection: "column",
        paddingLeft: isUser ? 0 : 1,
        paddingRight: isUser ? 0 : 1
      }}
    >
      <FaraiRow row={props.row} />
    </box>
  );
}
