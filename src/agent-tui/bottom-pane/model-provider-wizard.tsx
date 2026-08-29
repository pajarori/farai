import type { InputRenderable } from "@opentui/core";
import { For, Show, createEffect, createMemo, onCleanup, type JSX } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { useTuiStore } from "../context/store";
import { modelProviderProtocolLabel, modelProviderWizardStep, modelProviderWizardStepCount } from "../model-provider-state";
import { COLOR } from "../theme";
import { truncateLine } from "../renderers";
import { isPrimaryClick } from "../input/mouse";
import { fitTerminalPair } from "../terminal-text";

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
  const step = () => `${modelProviderWizardStep(wizard().field)}/${modelProviderWizardStepCount()}`;
  const header = () => fitTerminalPair(title(), step(), Math.max(1, dims().width - 4), 4, 1);
  const isTextField = () => ["id", "baseUrl", "apiKey", "model"].includes(wizard().field);
  const maskedSecret = createMemo(() => {
    if (wizard().apiKey.length) return "•".repeat(Math.min(24, [...wizard().apiKey].length));
    if (wizard().credentialStored && !wizard().removeCredential) return "stored ••••••••";
    if (wizard().removeCredential) return "credential will be removed";
    return "no credential";
  });
  const status = () => wizard().error
    ?? tui.store.ui.lastError
    ?? (wizard().busy
      ? wizard().busyKind === "save" ? "saving provider…" : "testing provider…"
      : wizard().probe
        ? wizard().probe!.ok
          ? `probe ready · ${wizard().probe!.models.length} models · ${wizard().probe!.latencyMs}ms`
          : `probe failed · ${wizard().probe!.error ?? "unknown error"}`
        : "");
  const statusColor = () => wizard().error || tui.store.ui.lastError || wizard().probe?.ok === false
    ? COLOR.error
    : wizard().probe?.ok
      ? COLOR.success
      : COLOR.accent;

  createEffect(() => {
    const field = wizard().field;
    const active = isTextField() && !wizard().busy;
    if (!active) {
      const stale = inputRef;
      inputRef = undefined;
      inputField = undefined;
      try { stale?.blur(); } catch {
      }
      return;
    }
    const next = wizard().field === "apiKey" ? "" : value();
    if (inputRef && inputField === field && inputRef.value !== next) inputRef.value = next;
    if (inputField === field) {
      try { inputRef?.focus(); } catch {
      }
    }
  });

  onCleanup(() => {
    try { inputRef?.blur(); } catch {
    }
    inputRef = undefined;
    inputField = undefined;
  });

  return (
    <box id="model-provider-wizard" style={{ flexShrink: 0, flexDirection: "column" }}>
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between", paddingLeft: 2, paddingRight: 2 }}>
        <text fg={COLOR.text}>{header().left}</text>
        <text fg={COLOR.dim}>{header().right}</text>
      </box>
      <box style={{ height: 4, flexShrink: 0, flexDirection: "column", overflow: "hidden" }}>
        <Show when={wizard().field === "protocol"} fallback={
          <Show when={wizard().field === "review"} fallback={
            <Show when={wizard().field} keyed>{(field) => (
              <box style={{ flexDirection: "column", paddingTop: 1, paddingLeft: 2, paddingRight: 1 }}>
                <text fg={COLOR.dim}>{truncateLine(fieldLabel(field), Math.max(1, dims().width - 3))}</text>
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
                        tui.actions.errorSet(undefined);
                        tui.actions.modelProviderWizardPatch({ apiKey: `${wizard().apiKey}${next}`, removeCredential: false, error: undefined });
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
          <box style={{ flexDirection: "column", paddingTop: 1 }}>
            <For each={[
              ["auto", "auto-detect", "choose from endpoint conventions"],
              ["openai-chat", "openai chat", "openai-compatible /v1 endpoints"],
              ["anthropic-messages", "anthropic messages", "native anthropic messages api"]
            ] as const}>{(row) => {
              const selected = () => wizard().protocol === row[0];
              const content = () => fitTerminalPair(row[1], dims().width >= 56 ? row[2] : "", Math.max(1, dims().width - 2), 4, 2);
              return (
                <box
                  style={{ flexDirection: "row" }}
                  onMouseUp={(event) => {
                    if (isPrimaryClick(event)) tui.actions.modelProviderWizardPatch({ protocol: row[0] });
                  }}
                >
                  <text selectable={false} fg={selected() ? COLOR.accent : COLOR.dim}>{selected() ? "› " : "  "}</text>
                  <text selectable={false} fg={COLOR.text}>{content().left}</text>
                  <Show when={content().right}><text selectable={false} fg={COLOR.dim}>{`  ${content().right}`}</text></Show>
                </box>
              );
            }}</For>
          </box>
        </Show>
      </box>
      <box style={{ height: 1, paddingLeft: 2, paddingRight: 1 }}>
        <text fg={statusColor()}>{truncateLine(status(), Math.max(1, dims().width - 3))}</text>
      </box>
      <box style={{ height: 1, paddingLeft: 2, paddingRight: 1 }}>
        <text fg={COLOR.dim}>{truncateLine(wizardHint(wizard().field, wizard().busyKind), Math.max(1, dims().width - 3))}</text>
      </box>
    </box>
  );
}

function ProviderReview(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTerminalDimensions();
  const wizard = () => tui.store.ui.modelProviderWizard!;
  const width = () => Math.max(1, dims().width - 2);
  return (
    <box style={{ flexDirection: "column", paddingLeft: 2 }}>
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
    </box>
  );
}

function updateField(tui: ReturnType<typeof useTuiStore>, field: string, value: string): void {
  tui.actions.errorSet(undefined);
  if (field === "id") tui.actions.modelProviderWizardPatch({ id: value, error: undefined });
  if (field === "baseUrl") tui.actions.modelProviderWizardPatch({ baseUrl: value, probe: undefined, error: undefined });
  if (field === "model") tui.actions.modelProviderWizardPatch({ model: value, error: undefined });
}

function fieldLabel(field: string): string {
  if (field === "id") return "provider id";
  if (field === "baseUrl") return "base url";
  if (field === "apiKey") return "api key · optional · ctrl+r remove stored key";
  if (field === "model") return "fallback model · optional";
  return field;
}

function wizardHint(field: string, busyKind: "probe" | "save" | undefined): string {
  if (busyKind === "probe") return "testing connection · esc cancel";
  if (busyKind === "save") return "saving provider";
  if (field === "protocol") return "↑↓ select · enter continue · esc back";
  if (field === "apiKey") return "type secret · backspace erase · ctrl+r remove · enter continue · esc back";
  if (field === "review") return "enter test and save · ctrl+s save without test · esc back";
  return "enter continue · esc back";
}
