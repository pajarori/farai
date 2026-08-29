import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { For, Show, createEffect, createMemo, type JSX } from "solid-js";
import { useTuiStore } from "../context/store";
import { formatPayload, truncateLine, type TimelineRow } from "../renderers";
import { formatCompactSummary } from "../../agent-core/loop/compaction";
import { COLOR } from "../theme";
import { FaraiRow } from "./cells";
import { FARAI_BANNER_LINES } from "../../branding";

export function Transcript(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTerminalDimensions();
  let scrollRef!: ScrollBoxRenderable;
  const navigation = createMessageNavigationState(tui.store.ui.messageNavigation.sequence);
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
    message.parts.map((part) => {
      const streamText = tui.store.ui.streamTextByPartId[part.id];
      const streamReasoning = tui.store.ui.streamReasoningByPartId[part.id];
      const payload = streamText !== undefined
        ? { text: streamText }
        : streamReasoning !== undefined
          ? { rationale: streamReasoning }
          : part.payload;
      return `${message.role}.${part.type} ${formatPayload(payload, 16_000)}`;
    })
  )));

  createEffect(() => {
    const request = tui.store.ui.messageNavigation;
    const userIds = transcriptRows().filter((row) => row.kind === "user").map((row) => row.id);
    const targetId = resolveMessageNavigationTarget(navigation, tui.store.activeSessionId, request, userIds);
    if (!targetId || !scrollRef) return;
    try { scrollRef.scrollChildIntoView(targetId); } catch {  }
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
            <box style={{ flexDirection: "column", marginBottom: 1 }}>
              <For each={FARAI_BANNER_LINES}>{(line) => (
                <text fg={COLOR.dim}>{truncateLine(line, Math.max(1, dims().width - 4))}</text>
              )}</For>
            </box>
            <text fg={COLOR.dim}>{"› message farai to get started"}</text>
            <text fg={COLOR.dim}>{"  / opens commands · ? shows shortcuts"}</text>
          </box>
        }
      >
        <Show when={tui.store.ui.rawOutput} fallback={
          <For each={indexedRows().ids}>{(id) => (
            <TranscriptRow
              row={indexedRows().byId.get(id)!}
              streamedText={tui.store.ui.streamTextByPartId[id]}
              streamedReasoning={tui.store.ui.streamReasoningByPartId[id]}
            />
          )}</For>
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

export type MessageNavigationState = {
  sessionId: string | undefined;
  handledSequence: number;
  index: number;
};

export function createMessageNavigationState(handledSequence = 0): MessageNavigationState {
  return { sessionId: undefined, handledSequence, index: -1 };
}

export function resolveMessageNavigationTarget(
  state: MessageNavigationState,
  sessionId: string | undefined,
  request: { sequence: number; direction: "next" | "prev" },
  userIds: readonly string[]
): string | undefined {
  if (state.sessionId !== sessionId) {
    state.sessionId = sessionId;
    state.index = -1;
  }
  if (request.sequence === 0 || request.sequence === state.handledSequence) return undefined;
  state.handledSequence = request.sequence;
  if (userIds.length === 0) {
    state.index = -1;
    return undefined;
  }
  const currentIndex = state.index >= 0 && state.index < userIds.length ? state.index : -1;
  state.index = nextNavigationIndex(request.direction, currentIndex, userIds.length);
  return userIds[state.index];
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
  streamedText?: string | undefined;
  streamedReasoning?: string | undefined;
};

function TranscriptRow(props: TranscriptRowProps): JSX.Element {
  const isUser = props.row.kind === "user";
  return (
    <box
      id={props.row.id}
      style={{
        flexDirection: "column",
        flexShrink: 0,
        paddingLeft: isUser ? 0 : 1,
        paddingRight: isUser ? 0 : 1
      }}
    >
      <FaraiRow row={props.row} streamedText={props.streamedText} streamedReasoning={props.streamedReasoning} />
    </box>
  );
}
