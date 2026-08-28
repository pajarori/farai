import type { SessionEvent } from "../../types";
import type { SqliteStore } from "../../agent-store/sqlite-store";

export type EventSubscription = {
  cursor: number;
  close(): void;
};

export function subscribeSessionEvents(
  store: SqliteStore,
  sessionId: string,
  cursor: number,
  onEvent: (event: SessionEvent) => void
): EventSubscription {
  let closed = false;
  let current = cursor;
  const pending: SessionEvent[] = [];
  let replaying = true;
  const emit = (event: SessionEvent) => {
    const sequence = event.sequence ?? 0;
    if (closed || sequence <= current) return;
    current = sequence;
    onEvent(event);
  };
  const unsubscribe = store.subscribe(sessionId, (change) => {
    if (change.kind !== "event") return;
    if (replaying) pending.push(change.event);
    else emit(change.event);
  });
  for (;;) {
    const events = store.listEventsAfter(sessionId, current, 10_000);
    for (const event of events) emit(event);
    if (events.length < 10_000) break;
  }
  replaying = false;
  for (const event of pending.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))) emit(event);
  return {
    get cursor() { return current; },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
    }
  };
}
