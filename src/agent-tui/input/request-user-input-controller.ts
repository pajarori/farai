import type { TuiStoreValue } from "../context/store";
import { requestOptionCount, requestOptionIndex, requestQuestion } from "../request-user-input-state";

export function createRequestUserInputController(tui: TuiStoreValue, focusComposer: () => void) {
  function current() {
    const request = tui.store.snapshot.pendingUserInput;
    const state = tui.store.ui.requestUserInput;
    if (!request || !state || state.requestId !== request.id) return undefined;
    const question = requestQuestion(request, state);
    return question ? { request, state, question } : undefined;
  }

  async function choose(explicitIndex?: number): Promise<void> {
    const active = current();
    if (!active || active.state.submitting) return;
    const choices = active.question.choices ?? [];
    if (choices.length === 0) {
      tui.actions.requestUserInputTextModeSet(active.question.id);
      return;
    }
    const index = explicitIndex ?? requestOptionIndex(active.question, active.state);
    tui.actions.requestUserInputOptionSet(active.question.id, index, requestOptionCount(active.question));
    const choice = choices[index];
    if (!choice) {
      tui.actions.requestUserInputTextModeSet(active.question.id);
      return;
    }
    await tui.answerUserInputQuestion(active.question.id, choice.label);
  }

  function moveOption(delta: number): void {
    const active = current();
    if (active) tui.actions.requestUserInputOptionMove(active.question.id, delta, requestOptionCount(active.question));
  }

  function enterTextMode(): void {
    const active = current();
    if (!active) return;
    if (!active.state.drafts[active.question.id] && active.state.answers[active.question.id]) {
      tui.actions.requestUserInputDraftSet(active.question.id, active.state.answers[active.question.id]!);
    }
    tui.actions.requestUserInputTextModeSet(active.question.id);
  }

  async function commitText(): Promise<void> {
    const active = current();
    if (!active) return;
    const draft = active.state.drafts[active.question.id]?.trim() ?? "";
    if (!draft) {
      tui.actions.errorSet("enter an answer before continuing");
      return;
    }
    await tui.answerUserInputQuestion(active.question.id, draft);
  }

  return {
    moveOption,
    choose,
    moveQuestion: (delta: number) => tui.actions.requestUserInputQuestionMove(delta),
    enterTextMode,
    exitTextMode: () => tui.actions.requestUserInputTextModeSet(undefined),
    commitText,
    dismiss: () => {
      tui.actions.requestUserInputDismissedSet(true);
      focusComposer();
    },
    show: () => tui.actions.requestUserInputDismissedSet(false),
    cancel: () => tui.cancelUserInput()
  };
}
