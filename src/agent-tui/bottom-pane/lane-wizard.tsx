import type { InputRenderable, TextareaRenderable } from "@opentui/core";
import { Show, createEffect, onCleanup, type JSX } from "solid-js";
import { useTuiStore } from "../context/store";
import { filteredToolNames, laneWizardStep, laneWizardStepCount, type LaneWizardField } from "../lane-state";
import { COLOR } from "../theme";
import { truncateLine } from "../renderers";
import { fitTerminalPair } from "../terminal-text";
import { useTuiDimensions } from "../context/terminal";
import { InputField, InputFieldPrompt, inputFieldHeight } from "./input-field";
import { MultiSelectRows } from "./multi-select-rows";

const TEXT_FIELDS: LaneWizardField[] = ["id", "description", "model"];

export function LaneWizard(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  let inputRef: InputRenderable | undefined;
  let inputField: LaneWizardField | undefined;
  let promptRef: TextareaRenderable | undefined;
  const wizard = () => tui.store.ui.laneWizard!;
  const value = () => {
    const field = wizard().field;
    if (field === "id") return wizard().id;
    if (field === "description") return wizard().description;
    if (field === "model") return wizard().model;
    return "";
  };
  const placeholder = () => {
    const field = wizard().field;
    if (field === "id") return "osint";
    if (field === "description") return "short role summary shown when picking a lane";
    if (field === "model") return "optional model id · empty inherits parent";
    return "";
  };
  const title = () => wizard().mode === "add" ? "add lane" : `edit ${wizard().id}`;
  const step = () => `${laneWizardStep(wizard().field)}/${laneWizardStepCount()}`;
  const header = () => fitTerminalPair(title(), step(), Math.max(1, dims().width - 4), 4, 1);
  const isTextField = () => TEXT_FIELDS.includes(wizard().field);
  const visibleTools = () => filteredToolNames(tui.store.ui.toolNames, wizard().toolFilter);
  const bodyHeight = () => wizard().field === "prompt"
    ? inputFieldHeight(dims().height) + 6
    : isTextField()
      ? inputFieldHeight(dims().height) + 4
      : 9;
  const wizardHeight = () => bodyHeight() + 3;
  const status = () => wizard().error ?? tui.store.ui.lastError ?? (wizard().busy ? "saving lane…" : "");
  const statusColor = () => wizard().error || tui.store.ui.lastError ? COLOR.error : COLOR.accent;

  createEffect(() => {
    const field = wizard().field;
    const activeText = isTextField() && !wizard().busy;
    if (activeText) {
      if (inputRef && inputField === field && inputRef.value !== value()) inputRef.value = value();
      if (inputField === field) { try { inputRef?.focus(); } catch { } }
    } else {
      try { inputRef?.blur(); } catch { }
    }
    if (field === "prompt" && !wizard().busy) { try { promptRef?.focus(); } catch { } }
    else { try { promptRef?.blur(); } catch { } }
  });

  onCleanup(() => {
    try { inputRef?.blur(); } catch { }
    try { promptRef?.blur(); } catch { }
    inputRef = undefined;
    inputField = undefined;
    promptRef = undefined;
  });

  return (
    <box id="lane-wizard" style={{ height: wizardHeight(), flexShrink: 0, flexDirection: "column", overflow: "hidden" }}>
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between", paddingLeft: 2, paddingRight: 2 }}>
        <text fg={COLOR.text}>{header().left}</text>
        <text fg={COLOR.dim}>{header().right}</text>
      </box>
      <box style={{ height: bodyHeight(), flexShrink: 0, flexDirection: "column", overflow: "hidden" }}>
        <Show when={wizard().field === "tools"} fallback={
          <Show when={wizard().field === "prompt"} fallback={
            <Show when={wizard().field === "review"} fallback={
              <Show when={wizard().field} keyed>{(field) => (
                <box style={{ flexDirection: "column", paddingTop: 1, paddingLeft: 2, paddingRight: 1 }}>
                  <text fg={COLOR.dim}>{truncateLine(fieldLabel(field), Math.max(1, dims().width - 3))}</text>
                  <InputField marginTop={1}>
                    <InputFieldPrompt />
                    <input
                      id="lane-wizard-input"
                      ref={(node) => { inputRef = node; inputField = field; if (node.value !== value()) node.value = value(); node.focus(); }}
                      value={value()}
                      placeholder={placeholder()}
                      placeholderColor={COLOR.dim}
                      textColor={COLOR.text}
                      focusedTextColor={COLOR.text}
                      cursorColor={COLOR.accent}
                      style={{ flexGrow: 1, backgroundColor: COLOR.panelActive }}
                      onInput={(next) => updateField(tui, field, next)}
                    />
                  </InputField>
                </box>
              )}</Show>
            }>
              <LaneReview />
            </Show>
          }>
            <box style={{ flexDirection: "column", paddingTop: 1, paddingLeft: 2, paddingRight: 1 }}>
              <text fg={COLOR.dim}>{"role prompt · optional · injected into the subagent"}</text>
              <box style={{ flexDirection: "row", marginTop: 1, paddingTop: 1, paddingBottom: 1, paddingLeft: 1, paddingRight: 1, backgroundColor: COLOR.panelActive }}>
                <textarea
                  id="lane-prompt-input"
                  ref={(node) => { promptRef = node; try { node.setText(wizard().prompt); } catch { } node.focus(); }}
                  placeholder="describe how this role should work"
                  placeholderColor={COLOR.dim}
                  textColor={COLOR.text}
                  focusedTextColor={COLOR.text}
                  cursorColor={COLOR.accent}
                  wrapMode="word"
                  style={{ height: Math.max(3, inputFieldHeight(dims().height)), flexGrow: 1, backgroundColor: "transparent" }}
                  onContentChange={() => { tui.actions.laneWizardPatch({ prompt: promptRef?.plainText ?? "", error: undefined }); }}
                />
              </box>
            </box>
          </Show>
        }>
          <box style={{ flexDirection: "column", paddingTop: 1, paddingLeft: 2, paddingRight: 1 }}>
            <text fg={COLOR.dim}>{truncateLine(`tools · ${wizard().tools.length} selected · omit to inherit${wizard().toolFilter ? ` · filter: ${wizard().toolFilter}` : ""}`, Math.max(1, dims().width - 3))}</text>
            <box style={{ marginTop: 1 }}>
              <MultiSelectRows items={visibleTools()} selected={(name) => wizard().tools.includes(name)} cursor={wizard().toolCursor} />
            </box>
          </box>
        </Show>
      </box>
      <box style={{ height: 1, paddingLeft: 2, paddingRight: 1 }}>
        <text fg={statusColor()}>{truncateLine(status(), Math.max(1, dims().width - 3))}</text>
      </box>
      <box style={{ height: 1, paddingLeft: 2, paddingRight: 1 }}>
        <text fg={COLOR.dim}>{truncateLine(wizardHint(wizard().field), Math.max(1, dims().width - 3))}</text>
      </box>
    </box>
  );
}

function LaneReview(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  const wizard = () => tui.store.ui.laneWizard!;
  const width = () => Math.max(1, dims().width - 2);
  return (
    <box style={{ flexDirection: "column", paddingTop: 1, paddingLeft: 2 }}>
      <text fg={COLOR.text}>{truncateLine(wizard().id || "unnamed lane", width())}</text>
      <text fg={COLOR.dim}>{truncateLine(wizard().description || "no description", width())}</text>
      <text fg={COLOR.dim}>{truncateLine(wizard().tools.length ? `tools: ${wizard().tools.join(", ")}` : "tools: inherit parent scope", width())}</text>
      <text fg={COLOR.dim}>{truncateLine(wizard().model ? `model: ${wizard().model}` : "model: inherit parent", width())}</text>
      <text fg={COLOR.dim}>{truncateLine(wizard().prompt ? `prompt: ${wizard().prompt.split("\n")[0]}` : "prompt: none", width())}</text>
    </box>
  );
}

function updateField(tui: ReturnType<typeof useTuiStore>, field: LaneWizardField, value: string): void {
  tui.actions.errorSet(undefined);
  if (field === "id") tui.actions.laneWizardPatch({ id: value, error: undefined });
  if (field === "description") tui.actions.laneWizardPatch({ description: value, error: undefined });
  if (field === "model") tui.actions.laneWizardPatch({ model: value, error: undefined });
}

function fieldLabel(field: LaneWizardField): string {
  if (field === "id") return "lane id";
  if (field === "description") return "description · optional";
  if (field === "model") return "model · optional · empty inherits parent";
  return field;
}

function wizardHint(field: LaneWizardField): string {
  if (field === "prompt") return "type · enter newline · ctrl+s continue · esc back";
  if (field === "tools") return "↑↓ move · space toggle · ctrl+a all · type filter · enter continue · esc back";
  if (field === "review") return "enter save · esc back";
  return "enter continue · esc back";
}
