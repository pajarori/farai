import type { InputRenderable } from "@opentui/core";
import { Show, createEffect, createMemo, onCleanup, type JSX } from "solid-js";
import { useTuiStore } from "../context/store";
import { useTuiDimensions } from "../context/terminal";
import { mcpWizardFields, mcpWizardStep } from "../mcp-server-state";
import { truncateLine } from "../renderers";
import { fitTerminalPair } from "../terminal-text";
import { COLOR } from "../theme";
import { InputField, InputFieldPrompt, inputFieldHeight } from "./input-field";
import { WizardChoiceRows } from "./wizard-choice-rows";

export function McpServerWizard(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  let inputRef: InputRenderable | undefined;
  let inputField: string | undefined;
  const wizard = () => tui.store.ui.mcpServerWizard!;
  const fields = () => mcpWizardFields(wizard());
  const title = () => wizard().mode === "add" ? "add mcp server" : `edit ${wizard().id}`;
  const header = () => fitTerminalPair(title(), `${mcpWizardStep(wizard())}/${fields().length}`, Math.max(1, dims().width - 4), 4, 1);
  const value = () => {
    const field = wizard().field;
    if (field === "id") return wizard().id;
    if (field === "endpoint") return wizard().endpoint;
    if (field === "credential") return wizard().credential;
    if (field === "oauth") return wizard().oauth;
    if (field === "environment") return wizard().environment;
    if (field === "behavior") return wizard().behavior;
    if (field === "tools") return wizard().tools;
    return "";
  };
  const isTextField = () => ["id", "endpoint", "credential", "oauth", "environment", "behavior", "tools"].includes(wizard().field);
  const bodyHeight = () => isTextField() ? inputFieldHeight(dims().height) + 4 : 7;
  const wizardHeight = () => bodyHeight() + 3;
  const maskedSecret = createMemo(() => {
    if (wizard().credential.length) return "•".repeat(Math.min(24, [...wizard().credential].length));
    if (wizard().credentialStored && !wizard().removeCredential) return "stored ••••••••";
    if (wizard().removeCredential) return "credential will be removed";
    return "no credential";
  });
  const status = () => wizard().error
    ?? tui.store.ui.lastError
    ?? (wizard().busy
      ? wizard().busyKind === "save" ? "saving mcp server…" : "testing mcp server…"
      : wizard().probe
        ? wizard().probe!.ok
          ? `ready · ${wizard().probe!.tools.length} tools · ${wizard().probe!.prompts.length} prompts · ${wizard().probe!.resources} resources · ${wizard().probe!.latencyMs}ms`
          : `test failed · ${wizard().probe!.error ?? "unknown error"}`
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
    inputField = undefined;
  });

  return (
    <box id="mcp-server-wizard" style={{ height: wizardHeight(), flexShrink: 0, flexDirection: "column", overflow: "hidden" }}>
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between", paddingLeft: 2, paddingRight: 2 }}>
        <text fg={COLOR.text}>{header().left}</text>
        <text fg={COLOR.dim}>{header().right}</text>
      </box>
      <box style={{ height: bodyHeight(), flexShrink: 0, flexDirection: "column", overflow: "hidden" }}>
        <Show when={wizard().field === "transport"} fallback={
          <Show when={wizard().field === "authentication"} fallback={
            <Show when={wizard().field === "review"} fallback={<WizardInput />}>
              <McpReview />
            </Show>
          }>
            <WizardChoiceRows rows={[
              ["none", "no auth", "anonymous connection"],
              ["bearer", "bearer token", "stored token, environment token, or authorization header"],
              ["oauth", "oauth", "authorization code flow with persistent credentials"]
            ]} selected={() => wizard().auth} choose={(auth) => tui.actions.mcpServerWizardPatch({ auth: auth as "none" | "bearer" | "oauth", error: undefined })} descriptionMinWidth={64} />
          </Show>
        }>
          <WizardChoiceRows rows={[
            ["stdio", "stdio", "launch a local command or docker process"],
            ["http", "streamable http", "connect to a remote mcp endpoint"]
          ]} selected={() => wizard().transport} choose={(transport) => tui.actions.mcpServerWizardPatch({
            transport: transport as "stdio" | "http",
            auth: transport === "http" ? wizard().auth : "none",
            error: undefined
          })} descriptionMinWidth={64} />
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

  function WizardInput(): JSX.Element {
    const field = () => wizard().field;
    const secret = () => field() === "credential";
    return (
      <box style={{ flexDirection: "column", paddingTop: 1, paddingLeft: 2, paddingRight: 1 }}>
        <text fg={COLOR.dim}>{truncateLine(fieldLabel(field(), wizard().transport), Math.max(1, dims().width - 3))}</text>
        <InputField marginTop={1}>
          <InputFieldPrompt />
          <Show when={secret()}>
            <text selectable={false} fg={wizard().removeCredential ? COLOR.warning : COLOR.text}>{maskedSecret()}</text>
          </Show>
          <input
            id="mcp-server-wizard-input"
            ref={(node) => {
              inputRef = node;
              inputField = field();
              node.value = secret() ? "" : value();
              node.focus();
            }}
            selectable={!secret()}
            value={secret() ? "" : value()}
            placeholder={placeholder(field(), wizard().transport, wizard().auth)}
            placeholderColor={COLOR.dim}
            textColor={secret() ? COLOR.panelActive : COLOR.text}
            focusedTextColor={secret() ? COLOR.panelActive : COLOR.text}
            cursorColor={COLOR.accent}
            style={{ flexGrow: 1, ...(secret() ? { width: 1 } : {}), backgroundColor: COLOR.panelActive }}
            onInput={(next) => updateField(next)}
          />
        </InputField>
      </box>
    );
  }

  function updateField(next: string): void {
    const field = wizard().field;
    tui.actions.errorSet(undefined);
    if (field === "credential") {
      if (!next) return;
      if (inputRef) inputRef.value = "";
      tui.actions.mcpServerWizardPatch({ credential: `${wizard().credential}${next}`, removeCredential: false, error: undefined });
      return;
    }
    if (field === "id") tui.actions.mcpServerWizardPatch({ id: next, error: undefined });
    if (field === "endpoint") tui.actions.mcpServerWizardPatch({ endpoint: next, probe: undefined, error: undefined });
    if (field === "oauth") tui.actions.mcpServerWizardPatch({ oauth: next, probe: undefined, error: undefined });
    if (field === "environment") tui.actions.mcpServerWizardPatch({ environment: next, probe: undefined, error: undefined });
    if (field === "behavior") tui.actions.mcpServerWizardPatch({ behavior: next, probe: undefined, error: undefined });
    if (field === "tools") tui.actions.mcpServerWizardPatch({ tools: next, probe: undefined, error: undefined });
  }
}

function McpReview(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  const wizard = () => tui.store.ui.mcpServerWizard!;
  const width = () => Math.max(1, dims().width - 2);
  return (
    <box style={{ flexDirection: "column", paddingTop: 1, paddingLeft: 2 }}>
      <text fg={COLOR.text}>{truncateLine(wizard().id || "unnamed mcp server", width())}</text>
      <text fg={COLOR.dim}>{truncateLine(`${wizard().transport} · ${wizard().endpoint || "endpoint missing"}`, width())}</text>
      <text fg={COLOR.dim}>{truncateLine(`${wizard().transport === "http" ? wizard().auth : "local process"} · ${wizard().behavior}`, width())}</text>
      <text fg={COLOR.dim}>{truncateLine(wizard().tools || "all discovered tools enabled", width())}</text>
    </box>
  );
}

function fieldLabel(field: string, transport: "stdio" | "http"): string {
  if (field === "id") return "server id";
  if (field === "endpoint") return transport === "http" ? "streamable http url" : "stdio command and arguments";
  if (field === "credential") return "bearer token · optional · ctrl+r remove stored token";
  if (field === "oauth") return "oauth · client_id=…; callback_url=…; scopes=a,b";
  if (field === "environment") return transport === "http"
    ? "headers · Name=value; Name=$ENV; Name=!stored-secret; bearer=$TOKEN_ENV"
    : "environment · cwd=/path; KEY=value; KEY=!stored-secret; $FORWARDED_ENV";
  if (field === "behavior") return "behavior · auto_start=true required=false startup=10 tool=60 container=true";
  if (field === "tools") return "tool filters · allow=tool_a,tool_b deny=tool_c";
  return field;
}

function placeholder(field: string, transport: "stdio" | "http", auth: "none" | "bearer" | "oauth"): string {
  if (field === "id") return "my-mcp-server";
  if (field === "endpoint") return transport === "http" ? "https://mcp.example.com/mcp" : "npx -y @example/mcp-server";
  if (field === "credential") return auth === "bearer" ? "type a token or leave empty" : "";
  if (field === "oauth") return "client_id=my-client; scopes=read,write";
  if (field === "environment") return transport === "http" ? "X-Api-Key=$API_KEY" : "cwd=/workspace; $API_KEY";
  if (field === "behavior") return "auto_start=true required=false startup=10 tool=60 container=true";
  if (field === "tools") return "allow=search,fetch deny=delete";
  return "";
}

function wizardHint(field: string, busyKind: "probe" | "save" | undefined): string {
  if (busyKind === "probe") return "testing server · esc cancel";
  if (busyKind === "save") return "saving mcp server";
  if (field === "transport" || field === "authentication") return "↑↓ select · enter continue · esc back";
  if (field === "credential") return "type secret · backspace erase · ctrl+r remove · enter continue · esc back";
  if (field === "review") return "enter test and save · ctrl+s save without test · esc back";
  return "enter continue · esc back";
}
