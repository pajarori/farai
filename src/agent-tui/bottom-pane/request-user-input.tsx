import type { InputRenderable } from "@opentui/core";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { PendingUserInput, UserInputQuestion } from "../../types";
import { useTuiStore } from "../context/store";
import { scrollWindowStart } from "../dialog/list-selection";
import { truncateLine } from "../renderers";
import { requestOptionCount, requestOptionIndex, requestQuestion } from "../request-user-input-state";
import { COLOR } from "../theme";
import { SelectionMenuHint, SelectionRow, selectionDescriptionColumn } from "../overlays/selection-row";
import { terminalWidth } from "../terminal-text";

type RequestOptionRow = {
  index: number;
  label: string;
  description?: string;
  recommended?: boolean;
};

export function RequestUserInput(props: { request: PendingUserInput }): JSX.Element {
  const tui = useTuiStore();
  const dims = useTerminalDimensions();
  const [now, setNow] = createSignal(Date.now());
  let inputRef: InputRenderable | undefined;
  const state = () => tui.store.ui.requestUserInput;
  const question = createMemo(() => {
    const current = state();
    return current?.requestId === props.request.id ? requestQuestion(props.request, current) : undefined;
  });
  const textMode = () => Boolean(question() && state()?.textModeQuestionId === question()!.id);
  const answeredCount = () => props.request.questions.filter((item) => state()?.answers[item.id]?.trim()).length;
  const optionRows = createMemo(() => requestOptionRows(question()));
  const visibleOptions = createMemo(() => {
    const item = question();
    const current = state();
    const rows = optionRows();
    if (!item || !current) return rows;
    const limit = requestVisibleOptionLimit(rows.length, dims().height);
    const selected = requestOptionIndex(item, current);
    const start = scrollWindowStart(rows.length, limit, selected);
    return rows.slice(start, start + limit);
  });
  const progressDetail = createMemo(() => requestProgressDetail(answeredCount(), props.request.questions.length, optionRows().length, visibleOptions().length));
  const progressLabel = createMemo(() => requestProgressLabel(props.request, state()?.questionIndex ?? 0));
  const countdown = createMemo(() => requestAutoResolutionCountdown(props.request, now()));
  const statusDetail = createMemo(() => requestStatusDetail(dims().width, progressDetail(), countdown()));
  const descriptionColumn = createMemo(() => selectionDescriptionColumn(optionRows().map((row) => ({
    number: row.index + 1,
    title: row.label,
    ...(row.recommended ? { badge: "recommended" } : {})
  })), dims().width));
  const hint = () => requestUserInputHint(dims().width, textMode(), Boolean(question()?.choices?.length));

  createEffect(() => {
    const active = textMode();
    queueMicrotask(() => {
      if (active) inputRef?.focus();
      else inputRef?.blur();
    });
  });

  const countdownTimer = setInterval(() => setNow(Date.now()), 250);
  onCleanup(() => clearInterval(countdownTimer));

  const choose = async (item: UserInputQuestion, index: number): Promise<void> => {
    const current = state();
    if (!current || current.submitting) return;
    tui.actions.requestUserInputOptionSet(item.id, index, requestOptionCount(item));
    const choice = item.choices?.[index];
    if (!choice) {
      tui.actions.requestUserInputTextModeSet(item.id);
      return;
    }
    await tui.answerUserInputQuestion(item.id, choice.label);
  };

  return (
    <box id="request-user-input" style={{ flexShrink: 0, flexDirection: "column" }}>
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
        <text fg={COLOR.text}>
          {`  ${truncateLine(progressLabel(), Math.max(8, dims().width - terminalWidth(statusDetail()) - 5))}`}
        </text>
        <text fg={countdown() ? COLOR.warning : COLOR.dim}>{statusDetail()}</text>
      </box>
      <Show when={question()}>{(item) => (
        <>
          <text
            fg={state()?.answers[item().id]?.trim() ? COLOR.text : COLOR.accent}
            wrapMode="word"
            truncate
            style={{ width: "100%", maxHeight: dims().height < 14 ? 1 : dims().height < 20 ? 2 : 3 }}
          >
            {`  ${item().question}`}
          </text>

          <Show when={!textMode()}>
            <box style={{ flexDirection: "column", marginTop: 1 }}>
              <For each={visibleOptions()}>{(row) => {
                const selected = () => {
                  const current = state();
                  return Boolean(current && requestOptionIndex(item(), current) === row.index);
                };
                const answered = () => state()?.answers[item().id] === row.label;
                return (
                  <SelectionRow
                    number={row.index + 1}
                    title={row.label}
                    description={row.description}
                    badge={row.recommended ? "recommended" : undefined}
                    selected={selected()}
                    width={dims().width}
                    descriptionColumn={descriptionColumn()}
                    titleColor={answered() ? COLOR.success : undefined}
                    onSelect={() => { void choose(item(), row.index); }}
                  />
                );
              }}</For>
            </box>
          </Show>

          <Show when={textMode()}>
            <box style={{ flexDirection: "column", marginTop: 1, paddingLeft: 2, paddingRight: 1 }}>
              <text fg={COLOR.dim}>{item().choices?.length
                ? "other answer"
                : item().recommended
                  ? `your answer · recommended: ${truncateLine(item().recommended!, Math.max(8, dims().width - 34))}`
                  : "your answer"}</text>
              <box style={{ height: 1, flexDirection: "row", backgroundColor: COLOR.panelActive }}>
                <text fg={COLOR.accent}>{"› "}</text>
                <input
                  id="request-user-input-text"
                  ref={(node) => { inputRef = node; }}
                  focused
                  value={state()?.drafts[item().id] ?? state()?.answers[item().id] ?? ""}
                  placeholder="type your answer"
                  placeholderColor={COLOR.dim}
                  textColor={COLOR.text}
                  focusedTextColor={COLOR.text}
                  cursorColor={COLOR.accent}
                  style={{ flexGrow: 1, backgroundColor: COLOR.panelActive }}
                  onInput={(value) => tui.actions.requestUserInputDraftSet(item().id, value)}
                />
              </box>
            </box>
          </Show>
        </>
      )}</Show>

      <SelectionMenuHint text={state()?.submitting ? "submitting answers..." : hint()} />
    </box>
  );
}

export function requestProgressLabel(request: PendingUserInput, index: number): string {
  const question = request.questions[index];
  const progress = `question ${Math.min(index + 1, request.questions.length)}/${request.questions.length}`;
  return question?.header?.trim() ? `${progress} · ${question.header.trim()}` : progress;
}

export function requestProgressDetail(answered: number, total: number, optionCount: number, visibleCount: number): string {
  const answerProgress = `${answered}/${total} answered`;
  return optionCount > visibleCount ? `${answerProgress} · ${optionCount} choices` : answerProgress;
}

export function requestVisibleOptionLimit(optionCount: number, terminalHeight: number): number {
  if (terminalHeight <= 12) return Math.min(optionCount, 2);
  if (terminalHeight <= 15) return Math.min(optionCount, 3);
  return optionCount;
}

export function requestAutoResolutionCountdown(request: PendingUserInput, now: number): string | undefined {
  if (!request.expiresAt) return undefined;
  const expiresAt = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiresAt)) return undefined;
  const remaining = Math.max(0, expiresAt - now);
  if (remaining === 0) return "selecting recommended";
  const seconds = Math.ceil(remaining / 1_000);
  if (seconds < 60) return `default in ${seconds}s`;
  return `default in ${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function requestStatusDetail(width: number, progress: string, countdown: string | undefined): string {
  if (!countdown) return progress;
  if (width >= 72) return `${progress} · ${countdown}`;
  if (width >= 44) return countdown;
  return countdown.replace("default in ", "");
}

export function requestUserInputHint(width: number, textMode: boolean, hasChoices: boolean): string {
  if (textMode) {
    if (width >= 76) return `enter continue · ${hasChoices ? "tab choices · " : ""}ctrl+p/n questions · esc ${hasChoices ? "choices" : "chat"} · ctrl+x cancel`;
    if (width >= 52) return `enter · ctrl+p/n questions · esc ${hasChoices ? "choices" : "chat"}`;
    return `enter · esc ${hasChoices ? "choices" : "chat"}`;
  }
  if (width >= 86) return "↑↓ select · 1-9 choose · ←→/ctrl+p/n questions · tab other · esc chat · ctrl+x cancel";
  if (width >= 58) return "↑↓ select · enter · ←→ questions · tab other · esc chat";
  if (width >= 42) return "↑↓ select · enter · tab other · esc chat";
  if (width >= 34) return "↑↓ select · enter · esc chat";
  return "↑↓ · enter · esc chat";
}

function requestOptionRows(question: UserInputQuestion | undefined): RequestOptionRow[] {
  if (!question?.choices?.length) return [];
  const rows = question.choices.map((choice, index) => ({
    index,
    label: choice.label,
    ...(choice.description ? { description: choice.description } : {}),
    ...(choice.label === question.recommended ? { recommended: true } : {})
  }));
  rows.push({ index: question.choices.length, label: "Other", description: "Type your own answer" });
  return rows;
}
