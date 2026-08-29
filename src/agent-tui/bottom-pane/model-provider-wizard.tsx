import type { InputRenderable } from "@opentui/core";
import { For, Show, createEffect, createMemo, type JSX } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { useTuiStore } from "../context/store";
import { modelProviderProtocolLabel, modelProviderWizardStep, modelProviderWizardStepCount } from "../model-provider-state";
import { COLOR } from "../theme";
import { truncateLine } from "../renderers";
import { isPrimaryClick } from "../input/mouse";

export function ModelProviderWizard(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTerminalDimensions();
  let inputRef: InputRenderable | undefined;
  let inputField: string | undefined;
  const wizard = () => tui.store.ui.modelProviderWizard!;
  const value = () => {
    if (wizard().field === "id") return wizard().id;
    if (wizard().field === "baseUrl") return wizard().baseUrl;
    if (wizard().field === "apiKey") return wizard().apiKey;
    if (wizard().field === "model") return wizard().model;
    return "";
  };
  const placeholder = () => {
    if (wizard().field === "id") return "my-provider";
    if (wizard().field === "baseUrl") return "https://api.example.com/v1";
    if (wizard().field === "apiKey") return wizard().credentialStored ? "leave empty to keep stored credential" : "optional for local endpoints";
    if (wizard().field === "model") return "optional fallback model id";
    return "";
  };
  const title = () => wizard().mode === "add" ? "add provider" : `edit ${wizard().id}`;
  const isTextField = () => ["id", "baseUrl", "apiKey", "model"].includes(wizard().field);
  const maskedSecret = createMemo(() => {
    if (wizard().apiKey.length) return "•".repeat(Math.min(24, [...wizard().apiKey].length));
    if (wizard().credentialStored && !wizard().removeCredential) return "stored ••••••••";
    if (wizard().removeCredential) return "credential will be removed";
    return "no credential";
  });

  createEffect(() => {
    const field = wizard().field;
    const active = isTextField() && !wizard().busy;
    const next = wizard().field === "apiKey" ? "" : value();
    if (inputRef && inputField === field && inputRef.value !== next) inputRef.value = next;
    if (active && inputField === field) inputRef?.focus();
    else if (!active) inputRef?.blur();
  });

  return (
    <box id="model-provider-wizard" style={{ flexShrink: 0, flexDirection: "column" }}>
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
        <text fg={COLOR.text}>{`  ${title()}`}</text>
        <text fg={COLOR.dim}>{`${modelProviderWizardStep(wizard().field)}/${modelProviderWizardStepCount()}`}</text>
      </box>
      <Show when={wizard().field === "protocol"} fallback={
        <Show when={wizard().field === "review"} fallback={
          <Show when={wizard().field} keyed>{(field) => (
            <box style={{ flexDirection: "column", marginTop: 1, paddingLeft: 2, paddingRight: 1 }}>
              <text fg={COLOR.dim}>{fieldLabel(field)}</text>
              <Show when={field === "apiKey"} fallback={
                <box style={{ height: 1, flexDirection: "row", marginTop: 1, backgroundColor: COLOR.panelActive }}>
                  <text fg={COLOR.accent}>{"› "}</text>
                  <input
                    id="model-provider-wizard-input"
                    ref={(node) => {
                      inputRef = node;
                      inputField = field;
                      if (node.value !== value()) node.value = value();
                      node.focus();
                    }}
                    value={value()}
                    placeholder={placeholder()}
                    placeholderColor={COLOR.dim}
                    textColor={COLOR.text}
                    focusedTextColor={COLOR.text}
                    cursorColor={COLOR.accent}
                    style={{ flexGrow: 1, backgroundColor: COLOR.panelActive }}
                    onInput={(next) => updateField(tui, field, next)}
                  />
                </box>
              }>
                <box style={{ height: 1, flexDirection: "row", marginTop: 1, backgroundColor: COLOR.panelActive }}>
                  <text fg={COLOR.accent}>{"› "}</text>
                  <text selectable={false} fg={wizard().removeCredential ? COLOR.warning : COLOR.text}>{maskedSecret()}</text>
                  <input
                    id="model-provider-api-key-input"
                    ref={(node) => {
                      inputRef = node;
                      inputField = field;
                      if (node.value) node.value = "";
                      node.focus();
                    }}
                    selectable={false}
                    value=""
                    placeholder=""
                    textColor={COLOR.panelActive}
                    focusedTextColor={COLOR.panelActive}
                    cursorColor={COLOR.accent}
                    style={{ width: 1, backgroundColor: COLOR.panelActive }}
                    onInput={(next) => {
                      if (!next) return;
                      if (inputRef) inputRef.value = "";
                      tui.actions.modelProviderWizardPatch({ apiKey: `${wizard().apiKey}${next}`, removeCredential: false });
                    }}
                  />
                </box>
              </Show>
            </box>
          )}</Show>
        }>
          <ProviderReview />
        </Show>
      }>
        <box style={{ flexDirection: "column", marginTop: 1 }}>
          <For each={[
            ["auto", "auto-detect", "choose from endpoint conventions"],
            ["openai-chat", "openai chat", "openai-compatible /v1 endpoints"],
            ["anthropic-messages", "anthropic messages", "native anthropic messages api"]
          ] as const}>{(row) => {
            const selected = () => wizard().protocol === row[0];
            return (
              <box
                style={{ flexDirection: "row" }}
                onMouseUp={(event) => {
                  if (isPrimaryClick(event)) tui.actions.modelProviderWizardPatch({ protocol: row[0] });
                }}
              >
                <text selectable={false} fg={selected() ? COLOR.accent : COLOR.dim}>{selected() ? "› " : "  "}</text>
                <text selectable={false} fg={COLOR.text}>{row[1]}</text>
                <Show when={dims().width >= 56}>
                  <text selectable={false} fg={COLOR.dim}>{`  ${row[2]}`}</text>
                </Show>
              </box>
            );
          }}</For>
        </box>
      </Show>
      <Show when={wizard().error}><box style={{ marginTop: 1 }}><text fg={COLOR.error}>{`  ${truncateLine(wizard().error ?? "", Math.max(8, dims().width - 4))}`}</text></box></Show>
      <box style={{ marginTop: 1 }}><text fg={COLOR.dim}>{`  ${truncateLine(wizardHint(wizard().field, wizard().busy), Math.max(1, dims().width - 2))}`}</text></box>
    </box>
  );
}

function ProviderReview(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTerminalDimensions();
  const wizard = () => tui.store.ui.modelProviderWizard!;
  const width = () => Math.max(1, dims().width - 2);
  return (
    <box style={{ flexDirection: "column", marginTop: 1, paddingLeft: 2 }}>
      <text fg={COLOR.text}>{truncateLine(wizard().id || "unnamed provider", width())}</text>
      <text fg={COLOR.dim}>{truncateLine(wizard().baseUrl || "base url missing", width())}</text>
      <text fg={COLOR.dim}>{truncateLine(`${modelProviderProtocolLabel(wizard().protocol)} · ${wizard().model || "discover models automatically"}`, width())}</text>
      <text fg={COLOR.dim}>{truncateLine(wizard().apiKey
        ? "new api key will be stored securely"
        : wizard().removeCredential
          ? "stored api key will be removed"
          : wizard().credentialStored
            ? "stored api key will be retained"
            : "no api key", width())}</text>
      <Show when={wizard().probe}><text fg={wizard().probe?.ok ? COLOR.success : COLOR.error}>{truncateLine(wizard().probe?.ok
        ? `probe ready · ${wizard().probe?.models.length} models · ${wizard().probe?.latencyMs}ms`
        : `probe failed · ${wizard().probe?.error ?? "unknown error"}`, width())}</text></Show>
      <Show when={wizard().busy}><text fg={COLOR.accent}>testing provider…</text></Show>
    </box>
  );
}

function updateField(tui: ReturnType<typeof useTuiStore>, field: string, value: string): void {
  if (field === "id") tui.actions.modelProviderWizardPatch({ id: value });
  if (field === "baseUrl") tui.actions.modelProviderWizardPatch({ baseUrl: value, probe: undefined });
  if (field === "model") tui.actions.modelProviderWizardPatch({ model: value });
}

function fieldLabel(field: string): string {
  if (field === "id") return "provider id";
  if (field === "baseUrl") return "base url";
  if (field === "apiKey") return "api key · optional · ctrl+r remove stored key";
  if (field === "model") return "fallback model · optional";
  return field;
}

function wizardHint(field: string, busy: boolean): string {
  if (busy) return "testing connection · esc cancel";
  if (field === "protocol") return "↑↓ select · enter continue · esc back";
  if (field === "apiKey") return "type secret · backspace erase · ctrl+r remove · enter continue · esc back";
  if (field === "review") return "enter test and save · ctrl+s save without test · esc back";
  return "enter continue · esc back";
}
