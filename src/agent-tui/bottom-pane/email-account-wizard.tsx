import type { InputRenderable } from "@opentui/core";
import { Show, createEffect, createMemo, onCleanup, type JSX } from "solid-js";
import { EMAIL_PROVIDER_PRESETS, emailProviderPreset } from "../../agent-email/accounts";
import type { EmailProviderID } from "../../agent-email/types";
import { emailProviderDescription, emailWizardFields, emailWizardStep } from "../email-account-state";
import { useComposerControl } from "../context/composer";
import { useTuiStore } from "../context/store";
import { useTuiDimensions } from "../context/terminal";
import { truncateLine } from "../renderers";
import { fitTerminalPair } from "../terminal-text";
import { COLOR } from "../theme";
import { InputField, InputFieldPrompt, inputFieldHeight } from "./input-field";
import { WizardChoiceRows } from "./wizard-choice-rows";

export function EmailAccountWizard(): JSX.Element {
  const tui = useTuiStore();
  const composer = useComposerControl();
  const dims = useTuiDimensions();
  let inputRef: InputRenderable | undefined;
  let inputField: string | undefined;
  const wizard = () => tui.store.ui.emailAccountWizard!;
  const value = () => {
    if (wizard().field === "label") return wizard().label;
    if (wizard().field === "address") return wizard().address;
    if (wizard().field === "username") return wizard().username;
    if (wizard().field === "endpoint") return wizard().endpoint;
    if (wizard().field === "credential") return wizard().credential;
    return "";
  };
  const isTextField = () => ["label", "address", "username", "endpoint", "credential"].includes(wizard().field);
  const bodyHeight = () => isTextField() ? inputFieldHeight(dims().height) + 4 : 7;
  const wizardHeight = () => bodyHeight() + 3;
  const header = () => fitTerminalPair(
    wizard().mode === "add" ? "add email" : `edit ${wizard().label}`,
    `${emailWizardStep(wizard())}/${emailWizardFields(wizard()).length}`,
    Math.max(1, dims().width - 4),
    4,
    1
  );
  const maskedSecret = createMemo(() => {
    if (wizard().credential.length) return "•".repeat(Math.min(24, [...wizard().credential].length));
    if (wizard().credentialStored && !wizard().removeCredential) return "stored ••••••••";
    if (wizard().removeCredential) return "credential will be removed";
    return "no credential";
  });
  const status = () => wizard().error
    ?? tui.store.ui.lastError
    ?? (wizard().busy
      ? wizard().busyKind === "save" ? "saving email…" : "testing email…"
      : wizard().probe
        ? wizard().probe!.ok
          ? `inbox ready · ${wizard().probe!.messages ?? 0} messages · ${wizard().probe!.latencyMs}ms`
          : `test failed · ${wizard().probe!.error ?? "unknown error"}`
        : "");
  const statusColor = () => wizard().error || tui.store.ui.lastError || wizard().probe?.ok === false
    ? COLOR.error
    : wizard().probe?.ok ? COLOR.success : COLOR.accent;

  createEffect(() => {
    const field = wizard().field;
    if (!isTextField() || wizard().busy) {
      try { inputRef?.blur(); } catch {
      }
      return;
    }
    const next = field === "credential" ? "" : value();
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
    composer.focus();
  });

  return (
    <box id="email-account-wizard" style={{ height: wizardHeight(), flexShrink: 0, flexDirection: "column", overflow: "hidden" }}>
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between", paddingLeft: 2, paddingRight: 2 }}>
        <text fg={COLOR.text}>{header().left}</text>
        <text fg={COLOR.dim}>{header().right}</text>
      </box>
      <box style={{ height: bodyHeight(), flexShrink: 0, flexDirection: "column", overflow: "hidden" }}>
        <Show when={wizard().field === "provider"} fallback={
          <Show when={wizard().field === "storage"} fallback={
            <Show when={wizard().field === "review"} fallback={<EmailTextField input={(node, field) => { inputRef = node; inputField = field; }} masked={maskedSecret()} />}>
              <EmailReview />
            </Show>
          }>
            <WizardChoiceRows rows={[
              ["system", "system keyring", "persists securely outside farai config"],
              ["session", "session only", "forgotten when farai exits"]
            ]} selected={() => wizard().storage} choose={(value) => tui.actions.emailAccountWizardPatch({ storage: value as "system" | "session" })} />
          </Show>
        }>
          <WizardChoiceRows
            rows={EMAIL_PROVIDER_PRESETS.map((preset) => [preset.id, preset.label, emailProviderDescription(preset.id)] as const)}
            selected={() => wizard().provider}
            choose={(value) => tui.actions.emailAccountWizardPatch({ provider: value as EmailProviderID })}
          />
        </Show>
      </box>
      <box style={{ height: 1, paddingLeft: 2, paddingRight: 1 }}><text fg={statusColor()}>{truncateLine(status(), Math.max(1, dims().width - 3))}</text></box>
      <box style={{ height: 1, paddingLeft: 2, paddingRight: 1 }}><text fg={COLOR.dim}>{truncateLine(emailHint(wizard().field, wizard().busyKind), Math.max(1, dims().width - 3))}</text></box>
    </box>
  );
}

function EmailTextField(props: { input(node: InputRenderable, field: string): void; masked: string }): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  let fieldInputRef: InputRenderable | undefined;
  const wizard = () => tui.store.ui.emailAccountWizard!;
  const field = () => wizard().field;
  const value = () => field() === "label" ? wizard().label : field() === "address" ? wizard().address : field() === "username" ? wizard().username : field() === "endpoint" ? wizard().endpoint : "";
  const credential = () => field() === "credential";
  return (
    <box style={{ flexDirection: "column", paddingTop: 1, paddingLeft: 2, paddingRight: 1 }}>
      <text fg={COLOR.dim}>{truncateLine(emailFieldLabel(field(), wizard().provider), Math.max(1, dims().width - 3))}</text>
      <InputField marginTop={1}>
        <InputFieldPrompt />
        <Show when={credential()}><text selectable={false} fg={wizard().removeCredential ? COLOR.warning : COLOR.text}>{props.masked}</text></Show>
        <input
          id="email-account-wizard-input"
          ref={(node) => {
            fieldInputRef = node;
            props.input(node, field());
            if (!credential() && node.value !== value()) node.value = value();
            if (credential() && node.value) node.value = "";
            node.focus();
          }}
          selectable={!credential()}
          value={credential() ? "" : value()}
          placeholder={emailPlaceholder(field())}
          placeholderColor={COLOR.dim}
          textColor={credential() ? COLOR.panelActive : COLOR.text}
          focusedTextColor={credential() ? COLOR.panelActive : COLOR.text}
          cursorColor={COLOR.accent}
          style={{ flexGrow: credential() ? 0 : 1, ...(credential() ? { width: 1 } : {}), backgroundColor: COLOR.panelActive }}
          onInput={(next) => {
            tui.actions.errorSet(undefined);
            if (credential()) {
              if (!next) return;
              if (fieldInputRef) fieldInputRef.value = "";
              const node = tui.store.ui.emailAccountWizard;
              if (node) tui.actions.emailAccountWizardPatch({ credential: `${node.credential}${next}`, removeCredential: false, error: undefined });
              return;
            }
            if (field() === "label") tui.actions.emailAccountWizardPatch({ label: next, error: undefined });
            if (field() === "address") tui.actions.emailAccountWizardPatch({ address: next, probe: undefined, error: undefined });
            if (field() === "username") tui.actions.emailAccountWizardPatch({ username: next, probe: undefined, error: undefined });
            if (field() === "endpoint") tui.actions.emailAccountWizardPatch({ endpoint: next, probe: undefined, error: undefined });
          }}
        />
      </InputField>
    </box>
  );
}

function EmailReview(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  const wizard = () => tui.store.ui.emailAccountWizard!;
  const preset = () => emailProviderPreset(wizard().provider);
  const width = () => Math.max(1, dims().width - 2);
  return (
    <box style={{ flexDirection: "column", paddingTop: 1, paddingLeft: 2 }}>
      <text fg={COLOR.text}>{truncateLine(`${wizard().label || "unnamed email"} · ${wizard().address || "address missing"}`, width())}</text>
      <text fg={COLOR.dim}>{truncateLine(`${preset().label} · ${wizard().username || wizard().address}`, width())}</text>
      <text fg={COLOR.dim}>{truncateLine(wizard().provider === "custom" ? wizard().endpoint : `${preset().host}:${preset().port}`, width())}</text>
      <text fg={COLOR.dim}>{truncateLine(`${wizard().storage === "system" ? "system keyring" : "session only"} · ${wizard().credential ? "new credential" : wizard().credentialStored ? "keep stored credential" : "credential missing"}`, width())}</text>
    </box>
  );
}

function emailFieldLabel(field: string, provider: string): string {
  if (field === "label") return "label";
  if (field === "address") return "email address";
  if (field === "username") return "imap username · defaults to email address";
  if (field === "endpoint") return "imap endpoint";
  if (field === "credential") return `${emailProviderPreset(provider as Parameters<typeof emailProviderPreset>[0]).credentialLabel} · ctrl+r remove stored credential`;
  return field;
}

function emailPlaceholder(field: string): string {
  if (field === "label") return "personal";
  if (field === "address") return "you@example.com";
  if (field === "username") return "you@example.com";
  if (field === "endpoint") return "imaps://mail.example.com:993";
  return "";
}

function emailHint(field: string, busyKind: "probe" | "save" | undefined): string {
  if (busyKind === "probe") return "testing connection · esc cancel";
  if (busyKind === "save") return "saving email";
  if (field === "provider" || field === "storage") return "↑↓ select · enter continue · esc back";
  if (field === "credential") return "type secret · backspace erase · ctrl+r remove · enter continue · esc back";
  if (field === "review") return "enter test and save · ctrl+s save without test · esc back";
  return "enter continue · esc back";
}
