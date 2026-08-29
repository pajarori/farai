import { createStore, produce } from "solid-js/store";
import type { MessageWithParts } from "../../types";

export type TranscriptStreamKind = "text" | "reasoning";

export type TranscriptStreamEntry = {
  content: string;
  revision: number;
};

export type TranscriptStreamDiagnostics = {
  revision: number;
  flushes: number;
  coalescedUpdates: number;
  lastIntervalMs: number;
  lastFlushAt: number | undefined;
};

export type TranscriptStreamState = {
  text: Record<string, TranscriptStreamEntry>;
  reasoning: Record<string, TranscriptStreamEntry>;
  diagnostics: TranscriptStreamDiagnostics;
};

export type TranscriptStreamEngine = {
  state: TranscriptStreamState;
  beginTurn(turnId: string): void;
  finishTurn(turnId: string): void;
  update(kind: TranscriptStreamKind, partId: string, content: string, turnId: string): void;
  updateText(partId: string, content: string, turnId: string): void;
  updateReasoning(partId: string, content: string, turnId: string): void;
  reconcile(messages: readonly MessageWithParts[], runningTurnId: string | undefined): void;
  reset(): void;
  flush(): void;
  dispose(): void;
};

type PendingEntry = {
  kind: TranscriptStreamKind;
  partId: string;
  content: string;
};

const MIN_FRAME_INTERVAL_MS = 24;
const BASE_FRAME_INTERVAL_MS = 24;
const MAX_FRAME_INTERVAL_MS = 96;

export function createTranscriptStreamEngine(): TranscriptStreamEngine {
  const [state, setState] = createStore<TranscriptStreamState>({
    text: {},
    reasoning: {},
    diagnostics: {
      revision: 0,
      flushes: 0,
      coalescedUpdates: 0,
      lastIntervalMs: BASE_FRAME_INTERVAL_MS,
      lastFlushAt: undefined
    }
  });
  const pending = new Map<string, PendingEntry>();
  let activeTurnId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerDueAt = 0;
  let lastFlushAt = 0;
  let updatesSinceFlush = 0;
  let coalescedUpdates = 0;
  let currentInterval = BASE_FRAME_INTERVAL_MS;
  let acceptingUpdates = false;
  let disposed = false;

  function key(kind: TranscriptStreamKind, partId: string): string {
    return `${kind}:${partId}`;
  }

  function intervalFor(contentLength: number, updateCount: number): number {
    const sizePressure = Math.log2(1 + contentLength / 4_096) * 8;
    const updatePressure = Math.max(0, updateCount - 3) * 2;
    return Math.round(Math.max(
      MIN_FRAME_INTERVAL_MS,
      Math.min(MAX_FRAME_INTERVAL_MS, BASE_FRAME_INTERVAL_MS + sizePressure + updatePressure)
    ));
  }

  function schedule(): void {
    if (disposed || pending.size === 0) return;
    const now = Date.now();
    const maxLength = Math.max(0, ...[...pending.values()].map((entry) => entry.content.length));
    const interval = intervalFor(maxLength, updatesSinceFlush);
    currentInterval = interval;
    const elapsed = now - lastFlushAt;
    if (lastFlushAt === 0 || elapsed >= interval) {
      flush();
      return;
    }
    const dueAt = lastFlushAt + interval;
    if (timer && dueAt <= timerDueAt) return;
    if (timer) clearTimeout(timer);
    timerDueAt = dueAt;
    timer = setTimeout(flush, Math.max(0, dueAt - now));
  }

  function flush(): void {
    if (disposed) return;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    timerDueAt = 0;
    if (pending.size === 0) return;
    const entries = [...pending.values()];
    pending.clear();
    const now = Date.now();
    lastFlushAt = now;
    updatesSinceFlush = 0;
    setState(produce((draft) => {
      draft.diagnostics.revision += 1;
      draft.diagnostics.flushes += 1;
      draft.diagnostics.coalescedUpdates = coalescedUpdates;
      draft.diagnostics.lastIntervalMs = currentInterval;
      draft.diagnostics.lastFlushAt = now;
      const revision = draft.diagnostics.revision;
      for (const entry of entries) {
        const target = entry.kind === "text" ? draft.text : draft.reasoning;
        target[entry.partId] = { content: entry.content, revision };
      }
    }));
  }

  function clearVisible(): void {
    pending.clear();
    updatesSinceFlush = 0;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    timerDueAt = 0;
    setState(produce((draft) => {
      draft.text = {};
      draft.reasoning = {};
    }));
  }

  function update(kind: TranscriptStreamKind, partId: string, content: string, turnId: string): void {
    if (disposed || !acceptingUpdates || turnId !== activeTurnId) return;
    const pendingKey = key(kind, partId);
    const existing = pending.get(pendingKey);
    const visible = kind === "text" ? state.text[partId]?.content : state.reasoning[partId]?.content;
    if (existing?.content === content || (!existing && visible === content)) return;
    if (existing) coalescedUpdates += 1;
    pending.set(pendingKey, { kind, partId, content });
    updatesSinceFlush += 1;
    schedule();
  }

  function durableContent(messages: readonly MessageWithParts[], partId: string, kind: TranscriptStreamKind): string | undefined {
    for (const message of messages) {
      const part = message.parts.find((candidate) => candidate.id === partId);
      if (!part) continue;
      if (kind === "text") {
        if (typeof part.payload === "string") return part.payload;
        if (part.payload && typeof part.payload === "object" && "text" in part.payload) {
          const value = (part.payload as { text?: unknown }).text;
          return typeof value === "string" ? value : undefined;
        }
        return undefined;
      }
      if (part.payload && typeof part.payload === "object") {
        const payload = part.payload as { rationale?: unknown; text?: unknown };
        if (typeof payload.rationale === "string") return payload.rationale;
        if (typeof payload.text === "string") return payload.text;
      }
      return typeof part.payload === "string" ? part.payload : undefined;
    }
    return undefined;
  }

  function reconciliationRemovals(
    kind: TranscriptStreamKind,
    visible: Record<string, TranscriptStreamEntry>,
    messages: readonly MessageWithParts[]
  ): string[] {
    const removals: string[] = [];
    for (const [partId, entry] of Object.entries(visible)) {
      const durable = durableContent(messages, partId, kind);
      if (durable === entry.content) removals.push(partId);
    }
    return removals;
  }

  function reconcile(messages: readonly MessageWithParts[], runningTurnId: string | undefined): void {
    if (disposed) return;
    if (!runningTurnId) {
      clearVisible();
      activeTurnId = undefined;
      acceptingUpdates = false;
      return;
    }
    if (activeTurnId && activeTurnId !== runningTurnId) {
      clearVisible();
      lastFlushAt = 0;
      currentInterval = BASE_FRAME_INTERVAL_MS;
    }
    if (activeTurnId !== runningTurnId) acceptingUpdates = true;
    activeTurnId = runningTurnId;
    const textRemovals = reconciliationRemovals("text", state.text, messages);
    const reasoningRemovals = reconciliationRemovals("reasoning", state.reasoning, messages);
    if (textRemovals.length === 0 && reasoningRemovals.length === 0) return;
    setState(produce((draft) => {
      for (const partId of textRemovals) delete draft.text[partId];
      for (const partId of reasoningRemovals) delete draft.reasoning[partId];
    }));
  }

  function beginTurn(turnId: string): void {
    if (disposed) return;
    if (activeTurnId !== turnId) {
      clearVisible();
      lastFlushAt = 0;
      currentInterval = BASE_FRAME_INTERVAL_MS;
    }
    activeTurnId = turnId;
    acceptingUpdates = true;
  }

  function finishTurn(turnId: string): void {
    if (disposed || activeTurnId !== turnId) return;
    flush();
    acceptingUpdates = false;
  }

  function reset(): void {
    if (disposed) return;
    clearVisible();
    activeTurnId = undefined;
    acceptingUpdates = false;
    lastFlushAt = 0;
    coalescedUpdates = 0;
    currentInterval = BASE_FRAME_INTERVAL_MS;
    setState("diagnostics", {
      revision: 0,
      flushes: 0,
      coalescedUpdates: 0,
      lastIntervalMs: BASE_FRAME_INTERVAL_MS,
      lastFlushAt: undefined
    });
  }

  function dispose(): void {
    if (disposed) return;
    clearVisible();
    disposed = true;
  }

  return {
    state,
    beginTurn,
    finishTurn,
    update,
    updateText(partId, content, turnId): void {
      update("text", partId, content, turnId);
    },
    updateReasoning(partId, content, turnId): void {
      update("reasoning", partId, content, turnId);
    },
    reconcile,
    reset,
    flush,
    dispose
  };
}
