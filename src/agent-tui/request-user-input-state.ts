import type { PendingUserInput, UserInputQuestion } from "../types";

export type RequestUserInputUiState = {
  requestId: string;
  questionIndex: number;
  optionIndices: Record<string, number>;
  answers: Record<string, string>;
  drafts: Record<string, string>;
  textModeQuestionId: string | undefined;
  submitting: boolean;
};

export function createRequestUserInputUiState(request: PendingUserInput): RequestUserInputUiState {
  const first = request.questions[0];
  const optionIndices = Object.fromEntries(request.questions.flatMap((question) => {
    const recommended = recommendedChoiceIndex(question);
    return recommended === undefined ? [] : [[question.id, recommended]];
  }));
  return {
    requestId: request.id,
    questionIndex: 0,
    optionIndices,
    answers: {},
    drafts: {},
    textModeQuestionId: first && !first.choices?.length ? first.id : undefined,
    submitting: false
  };
}

export function syncRequestUserInputUiState(
  current: RequestUserInputUiState | undefined,
  request: PendingUserInput | undefined
): RequestUserInputUiState | undefined {
  if (!request) return undefined;
  if (!current || current.requestId !== request.id) return createRequestUserInputUiState(request);
  const questionIndex = clampIndex(current.questionIndex, request.questions.length);
  const question = request.questions[questionIndex];
  return {
    ...current,
    questionIndex,
    ...(question && !question.choices?.length ? { textModeQuestionId: question.id } : {})
  };
}

export function requestQuestion(
  request: PendingUserInput,
  state: RequestUserInputUiState
): UserInputQuestion | undefined {
  return request.questions[state.questionIndex];
}

export function requestOptionCount(question: UserInputQuestion | undefined): number {
  return question?.choices?.length ? question.choices.length + 1 : 0;
}

export function requestOptionIndex(question: UserInputQuestion | undefined, state: RequestUserInputUiState): number {
  if (!question) return 0;
  return clampIndex(state.optionIndices[question.id] ?? recommendedChoiceIndex(question) ?? 0, requestOptionCount(question));
}

export function recommendedChoiceIndex(question: UserInputQuestion | undefined): number | undefined {
  if (!question?.choices?.length || !question.recommended) return undefined;
  const index = question.choices.findIndex((choice) => choice.label === question.recommended);
  return index >= 0 ? index : undefined;
}

export function requestInputComplete(request: PendingUserInput, state: RequestUserInputUiState): boolean {
  return request.questions.every((question) => Boolean(state.answers[question.id]?.trim()));
}

export function nextQuestionIndex(request: PendingUserInput, state: RequestUserInputUiState): number | undefined {
  for (let index = state.questionIndex + 1; index < request.questions.length; index += 1) {
    if (!state.answers[request.questions[index]!.id]?.trim()) return index;
  }
  for (let index = 0; index < state.questionIndex; index += 1) {
    if (!state.answers[request.questions[index]!.id]?.trim()) return index;
  }
  return undefined;
}

export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.floor(index)));
}

export function wrapIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  const normalized = Math.floor(index) % count;
  return normalized < 0 ? normalized + count : normalized;
}
