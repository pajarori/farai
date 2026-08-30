import type { UserInputAnswer } from "../../types";
import type { TuiCapabilities, TuiRuntimePort } from "../runtime-port";
import type { FaraiTuiStore, StoreActions } from "../store";
import { isAgentBusy } from "../store";
import type { createStoreSessionController } from "./store-session-controller";

type SessionController = ReturnType<typeof createStoreSessionController>;

type StorePromptControllerInput = {
  port: TuiRuntimePort;
  capabilities: TuiCapabilities;
  store: FaraiTuiStore;
  actions: StoreActions;
  sessions: SessionController;
  setStatusDetail(detail: string | undefined, timeoutMs?: number): void;
  isDisposed(): boolean;
};

export function createStorePromptController(input: StorePromptControllerInput) {
  const { port, capabilities, store, actions, sessions } = input;
  const submissions = new Map<string, { generation: number }>();

  function onSessionActivated(sessionId: string): void {
    const pending = submissions.get(sessionId);
    if (pending) pending.generation = actions.promptSubmissionStarted();
  }

  function submitPrompt(text: string): boolean {
    if (input.isDisposed()) return false;
    const owner = sessions.captureOwner();
    if (!owner || !text.trim()) return false;
    const sessionId = owner.sessionId;
    if (submissions.has(sessionId) || isAgentBusy(store) || port.getRunningTurnId(sessionId)) {
      if (port.steer?.(sessionId, text)) {
        actions.promptHistoryAdd(text);
        input.setStatusDetail("steering submitted", 1_500);
        return true;
      }
      return queuePrompt(text);
    }
    actions.promptHistoryAdd(text);
    const submission = { generation: actions.promptSubmissionStarted() };
    submissions.set(sessionId, submission);
    void (async () => {
      try {
        await port.prompt(sessionId, text);
      } catch (error) {
        if (isActiveSession(sessionId)) actions.errorSet(errorMessage(error));
      } finally {
        if (submissions.get(sessionId) !== submission) return;
        submissions.delete(sessionId);
        if (!isActiveSession(sessionId)) return;
        actions.promptSubmissionFinished(submission.generation);
        try {
          await sessions.requestSnapshotRefresh(sessionId);
        } catch (error) {
          if (isActiveSession(sessionId)) actions.errorSet(errorMessage(error));
        }
      }
    })();
    return true;
  }

  async function submitMcpPrompt(server: string, prompt: string, args: string[]): Promise<boolean> {
    const owner = sessions.captureOwner();
    if (!owner) return false;
    const status = `loading ${server}:${prompt}`;
    actions.errorSet(undefined);
    input.setStatusDetail(status);
    try {
      const text = await port.invokeMcpPrompt(owner.sessionId, server, prompt, args);
      if (!sessions.owns(owner)) return false;
      const submitted = submitPrompt(text);
      if (!submitted) actions.errorSet(`could not submit mcp prompt ${server}:${prompt}`);
      return submitted;
    } catch (error) {
      if (sessions.owns(owner)) actions.errorSet(errorMessage(error));
      return false;
    } finally {
      if (sessions.owns(owner) && store.ui.statusDetail === status) input.setStatusDetail(undefined);
    }
  }

  async function submitUserInput(answer: UserInputAnswer): Promise<boolean> {
    const owner = sessions.captureOwner();
    const request = store.snapshot.pendingUserInput;
    if (!owner || !request || request.sessionId !== owner.sessionId || store.ui.requestUserInput?.submitting) return false;
    const requestId = request.id;
    actions.requestUserInputSubmittingSet(true);
    actions.errorSet(undefined);
    try {
      await port.answerUserInputStructured(owner.sessionId, answer);
      if (!sessions.owns(owner) || store.snapshot.pendingUserInput?.id !== requestId) return true;
      actions.snapshotPatched({ pendingUserInput: undefined });
      await sessions.requestSnapshotRefresh(owner.sessionId);
      return true;
    } catch (error) {
      if (sessions.owns(owner) && store.snapshot.pendingUserInput?.id === requestId) {
        actions.requestUserInputSubmittingSet(false);
        actions.errorSet(errorMessage(error));
      }
      return false;
    }
  }

  async function answerUserInputQuestion(questionId: string, rawAnswer: string): Promise<boolean> {
    const request = store.snapshot.pendingUserInput;
    const state = store.ui.requestUserInput;
    const answer = rawAnswer.trim();
    if (!request || !state || state.requestId !== request.id || state.submitting || !answer) return false;
    if (!request.questions.some((question) => question.id === questionId)) return false;
    const answers = { ...state.answers, [questionId]: answer };
    actions.requestUserInputAnswerSet(questionId, answer);
    const nextIndex = request.questions.findIndex((question) => !answers[question.id]?.trim());
    if (nextIndex >= 0) {
      actions.requestUserInputQuestionSet(nextIndex);
      return true;
    }
    return submitUserInput({ answers });
  }

  async function cancelUserInput(): Promise<void> {
    const owner = sessions.captureOwner();
    const request = store.snapshot.pendingUserInput;
    if (!owner || !request || request.sessionId !== owner.sessionId) return;
    const requestId = request.id;
    try {
      await port.cancelUserInput(owner.sessionId);
      if (!sessions.owns(owner) || store.snapshot.pendingUserInput?.id !== requestId) return;
      actions.snapshotPatched({ pendingUserInput: undefined });
      await sessions.requestSnapshotRefresh(owner.sessionId);
    } catch (error) {
      if (sessions.owns(owner) && store.snapshot.pendingUserInput?.id === requestId) actions.errorSet(errorMessage(error));
    }
  }

  function queuePrompt(text: string): boolean {
    const owner = sessions.captureOwner();
    try {
      if (!owner || !text.trim()) return false;
      const queued = port.queueInput(owner.sessionId, text);
      if (!queued) return false;
      actions.snapshotPatched({ queuedPrompts: mergeQueuedPrompts(store.snapshot.queuedPrompts, queued) });
      actions.promptHistoryAdd(text);
      return true;
    } catch (error) {
      if (owner && sessions.owns(owner)) actions.errorSet(errorMessage(error));
      return false;
    }
  }

  async function compact(instructions?: string): Promise<void> {
    if (!capabilities.compact) {
      actions.errorSet("context compaction is unavailable in this TUI session");
      return;
    }
    const owner = sessions.captureOwner();
    if (!owner || store.ui.compacting) return;
    if (store.ui.submitting || store.snapshot.runningTurnId || port.getRunningTurnId(owner.sessionId)) {
      queuePrompt(`/compact${instructions ? ` ${instructions}` : ""}`);
      return;
    }
    actions.compactStarted();
    try {
      await port.compact(owner.sessionId, instructions);
      if (!sessions.owns(owner)) return;
      await sessions.refreshSnapshot();
      input.setStatusDetail("context compacted", 1_500);
    } catch (error) {
      if (!sessions.owns(owner)) return;
      const message = errorMessage(error);
      if (!/abort|cancel/i.test(message)) actions.errorSet(message);
    } finally {
      if (sessions.owns(owner)) actions.compactFinished();
    }
  }

  async function clearCurrentSession(): Promise<void> {
    const owner = sessions.captureOwner();
    if (!owner) return;
    if (isAgentBusy(store) || port.getRunningTurnId(owner.sessionId)) {
      queuePrompt("/clear");
      return;
    }
    try {
      await port.clearSession(owner.sessionId);
      if (!sessions.owns(owner)) return;
      await sessions.refreshSnapshot();
      actions.chatCleared();
      input.setStatusDetail("conversation cleared", 1_500);
    } catch (error) {
      if (sessions.owns(owner)) actions.errorSet(errorMessage(error));
    }
  }

  async function cancelCurrentTurn(): Promise<void> {
    if (!capabilities.cancel) {
      actions.errorSet("turn cancellation is unavailable in this TUI session");
      return;
    }
    const owner = sessions.captureOwner();
    if (!owner) return;
    if (store.ui.compacting) {
      port.cancelCompaction(owner.sessionId);
      actions.compactFinished();
      return;
    }
    const turnId = store.snapshot.runningTurnId ?? port.getRunningTurnId(owner.sessionId);
    if (!turnId) return;
    try {
      await port.cancelTurn(turnId, "cancelled by user");
    } catch (error) {
      if (sessions.owns(owner)) actions.errorSet(errorMessage(error));
    }
    if (!sessions.owns(owner)) return;
    try {
      await sessions.requestSnapshotRefresh(owner.sessionId);
    } catch (error) {
      if (sessions.owns(owner)) actions.errorSet(errorMessage(error));
    }
  }

  return {
    onSessionActivated,
    submitPrompt,
    submitMcpPrompt,
    submitUserInput,
    answerUserInputQuestion,
    cancelUserInput,
    queuePrompt,
    compact,
    clearCurrentSession,
    cancelCurrentTurn
  };

  function isActiveSession(sessionId: string): boolean {
    return !input.isDisposed() && store.activeSessionId === sessionId;
  }
}

function mergeQueuedPrompts(
  current: FaraiTuiStore["snapshot"]["queuedPrompts"],
  queued: FaraiTuiStore["snapshot"]["queuedPrompts"][number]
): FaraiTuiStore["snapshot"]["queuedPrompts"] {
  if (current.some((item) => item.id === queued.id)) return current;
  return [...current, queued].sort((left, right) => left.sequence - right.sequence);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
