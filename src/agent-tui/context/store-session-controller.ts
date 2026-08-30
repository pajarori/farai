import type { TuiRuntimePort } from "../runtime-port";
import type { FaraiTuiStore, StoreActions } from "../store";
import type { TranscriptStreamEngine } from "../transcript/stream-engine";

export type StoreSessionOwner = { sessionId: string; epoch: number };

type StoreSessionControllerInput = {
  port: TuiRuntimePort;
  store: FaraiTuiStore;
  actions: StoreActions;
  transcript: TranscriptStreamEngine;
  isDisposed(): boolean;
  onActiveSessionChange?(sessionId: string, title?: string): void;
  onSessionActivated?(sessionId: string): void;
  onSessionReady?(sessionId: string): void;
};

export function createStoreSessionController(input: StoreSessionControllerInput) {
  const { port, store, actions, transcript } = input;
  const snapshotRefreshes = new Map<string, { generation: number; promise: Promise<void> }>();
  const snapshotGenerations = new Map<string, number>();
  let sessionRefreshGeneration = 0;
  let selectionIntent = 0;

  function captureOwner(sessionId = store.activeSessionId): StoreSessionOwner | undefined {
    if (input.isDisposed() || !sessionId || store.activeSessionId !== sessionId) return undefined;
    return { sessionId, epoch: selectionIntent };
  }

  function owns(owner: StoreSessionOwner): boolean {
    return !input.isDisposed() && store.activeSessionId === owner.sessionId && selectionIntent === owner.epoch;
  }

  async function refreshSessions(): Promise<void> {
    if (input.isDisposed()) return;
    const generation = ++sessionRefreshGeneration;
    const items = await port.listSessionItems();
    if (input.isDisposed() || sessionRefreshGeneration !== generation) return;
    actions.sessionItemsLoaded(items);
  }

  async function refreshSnapshot(): Promise<void> {
    const owner = captureOwner();
    if (!owner) return;
    await requestSnapshotRefresh(owner.sessionId);
  }

  function invalidateSnapshot(sessionId: string): number {
    const generation = (snapshotGenerations.get(sessionId) ?? 0) + 1;
    snapshotGenerations.set(sessionId, generation);
    return generation;
  }

  function requestSnapshotRefresh(sessionId: string): Promise<void> {
    if (input.isDisposed()) return Promise.resolve();
    return refreshSnapshotFor(sessionId, invalidateSnapshot(sessionId));
  }

  function refreshSnapshotFor(sessionId: string, generation = snapshotGenerations.get(sessionId) ?? 0): Promise<void> {
    if (input.isDisposed()) return Promise.resolve();
    const existing = snapshotRefreshes.get(sessionId);
    if (existing?.generation === generation) return existing.promise;
    const refresh = (async () => {
      const snapshot = await port.loadSnapshot(sessionId);
      if (input.isDisposed() || store.activeSessionId !== sessionId || snapshotGenerations.get(sessionId) !== generation) return;
      actions.snapshotApplied(snapshot);
      transcript.reconcile(snapshot.messages, snapshot.runningTurnId);
      for (const entry of promptHistoryFromMessages(snapshot.messages)) actions.promptHistoryAdd(entry, "session");
    })();
    const entry = { generation, promise: refresh };
    snapshotRefreshes.set(sessionId, entry);
    const cleanup = () => {
      if (snapshotRefreshes.get(sessionId) === entry) snapshotRefreshes.delete(sessionId);
    };
    void refresh.then(cleanup, cleanup);
    return refresh;
  }

  async function selectSession(sessionId: string): Promise<void> {
    if (input.isDisposed() || sessionId === store.activeSessionId) return;
    const intent = ++selectionIntent;
    await selectSessionForIntent(sessionId, intent);
  }

  async function selectSessionForIntent(sessionId: string, intent: number): Promise<void> {
    if (input.isDisposed() || selectionIntent !== intent || sessionId === store.activeSessionId) return;
    transcript.reset();
    actions.activeSessionSet(sessionId);
    input.onSessionActivated?.(sessionId);
    input.onActiveSessionChange?.(sessionId);
    port.setActiveSession(sessionId);
    const runningTurnId = port.getRunningTurnId?.(sessionId);
    if (runningTurnId) transcript.beginTurn(runningTurnId);
    try {
      await requestSnapshotRefresh(sessionId);
    } catch (error) {
      if (input.isDisposed() || selectionIntent !== intent || store.activeSessionId !== sessionId) return;
      actions.errorSet(error instanceof Error ? error.message : String(error));
    }
    if (!input.isDisposed() && selectionIntent === intent && store.activeSessionId === sessionId) {
      input.onSessionReady?.(sessionId);
    }
  }

  async function createSession(): Promise<void> {
    if (input.isDisposed()) return;
    const intent = ++selectionIntent;
    try {
      const session = await port.createSession();
      if (input.isDisposed() || selectionIntent !== intent) return;
      await refreshSessions();
      await selectSessionForIntent(session.id, intent);
    } catch (error) {
      if (input.isDisposed() || selectionIntent !== intent) return;
      actions.errorSet(error instanceof Error ? error.message : String(error));
    }
  }

  async function forkCurrentSession(): Promise<void> {
    const owner = captureOwner();
    if (!owner) return;
    const intent = ++selectionIntent;
    try {
      const session = await port.forkSession(owner.sessionId);
      if (input.isDisposed() || selectionIntent !== intent) return;
      await refreshSessions();
      await selectSessionForIntent(session.id, intent);
    } catch (error) {
      if (input.isDisposed() || selectionIntent !== intent) return;
      actions.errorSet(error instanceof Error ? error.message : String(error));
    }
  }

  function dispose(): void {
    selectionIntent += 1;
    sessionRefreshGeneration += 1;
    snapshotRefreshes.clear();
  }

  return {
    captureOwner,
    owns,
    refreshSessions,
    refreshSnapshot,
    requestSnapshotRefresh,
    invalidateSnapshot,
    selectSession,
    createSession,
    forkCurrentSession,
    dispose
  };
}

function promptHistoryFromMessages(messages: Array<{ role: string; parts: Array<{ type: string; payload: unknown }> }>): string[] {
  const values: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of message.parts) {
      if (part.type !== "text") continue;
      const text = textFromPayload(part.payload);
      if (typeof text === "string" && text.trim()) values.push(text);
    }
  }
  return values;
}

function textFromPayload(payload: unknown): unknown {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && "text" in payload) return (payload as { text?: unknown }).text;
  return undefined;
}
