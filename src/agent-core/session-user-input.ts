import type { PendingUserInput, SessionEvent, UserInputAnswer, UserInputRequest } from "../types";
import { id, nowIso } from "../utils";

type PendingEntry = {
  request: PendingUserInput;
  resolve: (answer: UserInputAnswer) => void;
  reject: (error: Error) => void;
  recovered?: boolean;
  settling?: boolean;
  timeout?: ReturnType<typeof setTimeout>;
};

type SessionUserInputCallbacks = {
  emitControl: (sessionId: string, payload: unknown) => void;
  queueRecoveredAnswer: (sessionId: string, text: string, requestId: string) => void;
};

export class SessionUserInputCoordinator {
  private readonly pending = new Map<string, PendingEntry>();

  constructor(private readonly callbacks: SessionUserInputCallbacks) {}

  get(sessionId: string): PendingUserInput | undefined {
    return this.pending.get(sessionId)?.request;
  }

  request(sessionId: string, input: UserInputRequest, signal?: AbortSignal): Promise<UserInputAnswer> {
    if (this.pending.has(sessionId)) throw new Error("this session already has a pending user question");
    if (signal?.aborted) return Promise.reject(new Error("user input request cancelled"));

    const createdAt = nowIso();
    const expiresAt = input.timeoutSeconds
      ? new Date(Date.parse(createdAt) + input.timeoutSeconds * 1_000).toISOString()
      : undefined;
    const request: PendingUserInput = { ...input, id: id(), sessionId, createdAt, ...(expiresAt ? { expiresAt } : {}) };
    return new Promise<UserInputAnswer>((resolve, reject) => {
      const detach = () => signal?.removeEventListener("abort", abort);
      const abort = () => {
        if (this.pending.get(sessionId)?.request.id !== request.id) return;
        this.callbacks.emitControl(sessionId, { kind: "user_input_cancelled", requestId: request.id });
        this.deleteEntry(sessionId);
        detach();
        reject(new Error("user input request cancelled"));
      };
      const entry: PendingEntry = {
        request,
        resolve: (answer) => { detach(); resolve(answer); },
        reject: (error) => { detach(); reject(error); }
      };
      this.pending.set(sessionId, entry);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.callbacks.emitControl(sessionId, { kind: "user_input_requested", request });
        this.scheduleTimeout(sessionId, entry);
      } catch (error) {
        this.deleteEntry(sessionId);
        detach();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  answer(sessionId: string, raw: string): UserInputAnswer {
    const entry = this.pending.get(sessionId);
    if (!entry) throw new Error("no pending user question for this session");
    return this.answerStructured(sessionId, parseUserInputAnswer(entry.request, raw));
  }

  answerStructured(sessionId: string, supplied: UserInputAnswer): UserInputAnswer {
    return this.settleAnswer(sessionId, supplied, "user");
  }

  private settleAnswer(sessionId: string, supplied: UserInputAnswer, resolution: "user" | "timeout"): UserInputAnswer {
    const entry = this.pending.get(sessionId);
    if (!entry) throw new Error("no pending user question for this session");
    if (entry.settling) throw new Error("user input request is already being resolved");
    entry.settling = true;
    try {
      const validated = validateUserInputAnswer(entry.request, supplied);
      const answer: UserInputAnswer = resolution === "timeout"
        ? { ...validated, resolution }
        : validated;
      if (entry.recovered) {
        this.callbacks.queueRecoveredAnswer(
          sessionId,
          recoveredUserInputAnswer(entry.request, answer),
          entry.request.id
        );
      }
      this.callbacks.emitControl(sessionId, {
        kind: "user_input_answered",
        requestId: entry.request.id,
        answers: answer.answers,
        resolution
      });
      this.deleteEntry(sessionId);
      if (!entry.recovered) entry.resolve(answer);
      return answer;
    } finally {
      if (this.pending.get(sessionId) === entry) entry.settling = false;
    }
  }

  cancel(sessionId: string): PendingUserInput {
    const entry = this.pending.get(sessionId);
    if (!entry) throw new Error("no pending user question for this session");
    this.callbacks.emitControl(sessionId, { kind: "user_input_cancelled", requestId: entry.request.id });
    this.deleteEntry(sessionId);
    if (!entry.recovered) entry.reject(new Error("user input request cancelled"));
    return entry.request;
  }

  recover(sessionId: string, events: readonly SessionEvent[]): PendingUserInput | undefined {
    if (this.pending.has(sessionId)) return this.pending.get(sessionId)?.request;
    const request = unresolvedUserInputRequest(events);
    if (!request) return undefined;
    const entry: PendingEntry = {
      request,
      recovered: true,
      resolve: () => {},
      reject: () => {}
    };
    this.pending.set(sessionId, entry);
    this.scheduleTimeout(sessionId, entry);
    return request;
  }

  rejectAll(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      if (entry.timeout) clearTimeout(entry.timeout);
      entry.reject(error);
    }
  }

  private scheduleTimeout(sessionId: string, entry: PendingEntry, retryDelayMs?: number): void {
    if (!entry.request.expiresAt) return;
    if (entry.timeout) clearTimeout(entry.timeout);
    const expiresAt = Date.parse(entry.request.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const delay = retryDelayMs ?? Math.max(0, expiresAt - Date.now());
    entry.timeout = setTimeout(() => {
      delete entry.timeout;
      if (this.pending.get(sessionId) !== entry) return;
      try {
        this.settleAnswer(sessionId, recommendedUserInputAnswer(entry.request), "timeout");
      } catch {
        if (this.pending.get(sessionId) === entry) this.scheduleTimeout(sessionId, entry, 1_000);
      }
    }, delay);
  }

  private deleteEntry(sessionId: string): PendingEntry | undefined {
    const entry = this.pending.get(sessionId);
    if (!entry) return undefined;
    if (entry.timeout) clearTimeout(entry.timeout);
    this.pending.delete(sessionId);
    return entry;
  }
}

export function parseUserInputAnswer(request: PendingUserInput, raw: string): UserInputAnswer {
  if (request.questions.length === 1) {
    const question = request.questions[0]!;
    const supplied = raw.trim();
    return {
      answers: {
        [question.id]: parseChoiceOrText(question, supplied)
      }
    };
  }
  const values = raw.split("|").map((value) => value.trim());
  const answers: Record<string, string> = {};
  request.questions.forEach((question, index) => {
    const supplied = values[index] ?? "";
    answers[question.id] = parseChoiceOrText(question, supplied);
  });
  return { answers };
}

function parseChoiceOrText(question: UserInputRequest["questions"][number], supplied: string): string {
  if (!/^[1-9]\d*$/.test(supplied)) return supplied;
  const choiceIndex = Number.parseInt(supplied, 10);
  return choiceIndex <= (question.choices?.length ?? 0)
    ? question.choices![choiceIndex - 1]!.label
    : supplied;
}

export function validateUserInputAnswer(request: PendingUserInput, supplied: UserInputAnswer): UserInputAnswer {
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied) || !supplied.answers || typeof supplied.answers !== "object" || Array.isArray(supplied.answers)) {
    throw new Error("user input answer must contain an answers object");
  }
  const answers: Record<string, string> = {};
  for (const question of request.questions) {
    const value = supplied.answers[question.id];
    if (typeof value !== "string" || !value.trim()) throw new Error(`missing answer for question: ${question.id}`);
    answers[question.id] = value.trim();
  }
  return { answers };
}

export function recommendedUserInputAnswer(request: PendingUserInput): UserInputAnswer {
  const answers: Record<string, string> = {};
  for (const question of request.questions) {
    const recommended = question.recommended?.trim();
    if (!recommended) throw new Error(`missing recommended answer for question: ${question.id}`);
    if (question.choices?.length && !question.choices.some((choice) => choice.label === recommended)) {
      throw new Error(`recommended answer no longer matches a choice: ${question.id}`);
    }
    answers[question.id] = recommended;
  }
  return { answers, resolution: "timeout" };
}

export function unresolvedUserInputRequest(events: readonly SessionEvent[]): PendingUserInput | undefined {
  const requests = new Map<string, PendingUserInput>();
  const settled = new Set<string>();
  for (const event of events) {
    if (event.type !== "control" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) continue;
    const payload = event.payload as Record<string, unknown>;
    if ((payload.kind === "user_input_answered" || payload.kind === "user_input_cancelled") && typeof payload.requestId === "string") {
      settled.add(payload.requestId);
      requests.delete(payload.requestId);
      continue;
    }
    if (payload.kind !== "user_input_requested" || !isPendingUserInput(payload.request)) continue;
    requests.set(payload.request.id, payload.request);
  }
  return [...requests.values()].reverse().find((request) => !settled.has(request.id));
}

function isPendingUserInput(value: unknown): value is PendingUserInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (typeof request.id !== "string" || typeof request.sessionId !== "string" || typeof request.createdAt !== "string") return false;
  if (request.expiresAt !== undefined && typeof request.expiresAt !== "string") return false;
  if (request.timeoutSeconds !== undefined && (typeof request.timeoutSeconds !== "number" || !Number.isFinite(request.timeoutSeconds))) return false;
  if (!Array.isArray(request.questions) || request.questions.length === 0) return false;
  return request.questions.every((question) => {
    if (!question || typeof question !== "object" || Array.isArray(question)) return false;
    const item = question as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.question !== "string") return false;
    if (item.recommended !== undefined && typeof item.recommended !== "string") return false;
    return item.choices === undefined || (Array.isArray(item.choices) && item.choices.every((choice) => (
      Boolean(choice) && typeof choice === "object" && !Array.isArray(choice) && typeof (choice as Record<string, unknown>).label === "string"
    )));
  });
}

function recoveredUserInputAnswer(request: PendingUserInput, answer: UserInputAnswer): string {
  const lines = request.questions.map((question) => `- ${question.question}: ${answer.answers[question.id] ?? ""}`);
  return [
    "Answer to the user-input request that was interrupted by a runtime restart:",
    ...lines,
    "Continue the prior task from the persisted transcript. Do not repeat completed tool work."
  ].join("\n");
}
