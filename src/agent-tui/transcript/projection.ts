import { createMemo, type Accessor } from "solid-js";
import type { FaraiTuiStore } from "../store";
import { projectMessagesToRows, type TimelineRow } from "../renderers";

export function createTranscriptProjection(
  store: FaraiTuiStore,
  width: Accessor<number>
): Accessor<TimelineRow[]> {
  const historyMessages = createMemo(() => {
    const runningTurnId = store.snapshot.runningTurnId;
    return runningTurnId
      ? store.snapshot.messages.filter((message) => message.turnId !== runningTurnId)
      : store.snapshot.messages;
  });
  const activeMessages = createMemo(() => {
    const runningTurnId = store.snapshot.runningTurnId;
    return runningTurnId
      ? store.snapshot.messages.filter((message) => message.turnId === runningTurnId)
      : [];
  });
  const activeMessageIds = createMemo(() => new Set(activeMessages().map((message) => message.id)));
  const historyToolCalls = createMemo(() => {
    const runningTurnId = store.snapshot.runningTurnId;
    return runningTurnId
      ? store.snapshot.toolCalls.filter((toolCall) => (
          toolCall.turnId !== runningTurnId
          && (!toolCall.messageId || !activeMessageIds().has(toolCall.messageId))
        ))
      : store.snapshot.toolCalls;
  });
  const activeToolCalls = createMemo(() => {
    const runningTurnId = store.snapshot.runningTurnId;
    return runningTurnId
      ? store.snapshot.toolCalls.filter((toolCall) => (
          toolCall.turnId === runningTurnId
          || (toolCall.messageId ? activeMessageIds().has(toolCall.messageId) : toolCall.turnId === undefined)
        ))
      : [];
  });
  const historyRows = createMemo(() => projectMessagesToRows(
    historyMessages(),
    width(),
    undefined,
    historyToolCalls()
  ));
  const activeRows = createMemo(() => projectMessagesToRows(
    activeMessages(),
    width(),
    store.snapshot.runningTurnId,
    activeToolCalls(),
    store.snapshot.toolInputPreviews
  ));
  return createMemo(() => [...historyRows(), ...activeRows()]);
}
