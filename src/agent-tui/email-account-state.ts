import { EMAIL_PROVIDER_PRESETS, emailProviderPreset } from "../agent-email/accounts";
import type { EmailAccountInfo, EmailCredentialStorage, EmailProviderID, SaveEmailAccountInput } from "../agent-email/types";

export type EmailAccountWizardMode = "add" | "edit";
export type EmailAccountWizardField = "provider" | "label" | "address" | "username" | "endpoint" | "credential" | "storage" | "review";

export type EmailAccountWizardState = {
  mode: EmailAccountWizardMode;
  field: EmailAccountWizardField;
  id?: string;
  provider: EmailProviderID;
  label: string;
  address: string;
  username: string;
  endpoint: string;
  credential: string;
  credentialStored: boolean;
  removeCredential: boolean;
  storage: EmailCredentialStorage;
  location: "global" | "project";
  probe: import("../agent-email/types").EmailAccountProbe | undefined;
  busy: boolean;
  busyKind?: "probe" | "save" | undefined;
  error: string | undefined;
};

const PROVIDERS = EMAIL_PROVIDER_PRESETS.map((preset) => preset.id);

export function createEmailAccountWizard(account?: EmailAccountInfo): EmailAccountWizardState {
  if (!account) {
    const preset = emailProviderPreset("gmail");
    return {
      mode: "add",
      field: "provider",
      provider: "gmail",
      label: "",
      address: "",
      username: "",
      endpoint: endpointValue(preset.host, preset.port, preset.secure),
      credential: "",
      credentialStored: false,
      removeCredential: false,
      storage: "system",
      location: "global",
      probe: undefined,
      busy: false,
      error: undefined
    };
  }
  return {
    mode: "edit",
    field: "provider",
    id: account.id,
    provider: account.provider,
    label: account.label,
    address: account.address,
    username: account.username,
    endpoint: endpointValue(account.host, account.port, account.secure),
    credential: "",
    credentialStored: account.credentialConfigured,
    removeCredential: false,
    storage: account.credentialStorage,
    location: account.location,
    probe: undefined,
    busy: false,
    error: undefined
  };
}

export function emailProviderMove(provider: EmailProviderID, delta: number): EmailProviderID {
  const index = PROVIDERS.indexOf(provider);
  return PROVIDERS[(index + delta + PROVIDERS.length) % PROVIDERS.length] ?? "gmail";
}

export function emailStorageMove(storage: EmailCredentialStorage, delta: number): EmailCredentialStorage {
  const values: EmailCredentialStorage[] = ["system", "session"];
  const index = values.indexOf(storage);
  return values[(index + delta + values.length) % values.length] ?? "system";
}

export function emailWizardFields(state: Pick<EmailAccountWizardState, "provider">): EmailAccountWizardField[] {
  return ["provider", "label", "address", "username", ...(state.provider === "custom" ? ["endpoint" as const] : []), "credential", "storage", "review"];
}

export function emailWizardFieldMove(state: EmailAccountWizardState, delta: -1 | 1): EmailAccountWizardField {
  const fields = emailWizardFields(state);
  const index = fields.indexOf(state.field);
  return fields[Math.max(0, Math.min(fields.length - 1, index + delta))] ?? state.field;
}

export function emailWizardStep(state: EmailAccountWizardState): number {
  return emailWizardFields(state).indexOf(state.field) + 1;
}

export function emailWizardSaveInput(state: EmailAccountWizardState): SaveEmailAccountInput {
  const preset = emailProviderPreset(state.provider);
  const endpoint = state.provider === "custom" ? parseEndpoint(state.endpoint) : { host: preset.host, port: preset.port, secure: preset.secure };
  return {
    ...(state.id ? { id: state.id } : {}),
    label: state.label.trim(),
    provider: state.provider,
    address: state.address.trim(),
    username: state.username.trim() || state.address.trim(),
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    auth: preset.auth,
    ...(state.credential ? { credential: state.credential, credentialAction: "replace" as const } : state.removeCredential ? { credentialAction: "remove" as const } : { credentialAction: "keep" as const }),
    credentialStorage: state.storage,
    location: state.location
  };
}

export function emailProviderDescription(provider: EmailProviderID): string {
  const preset = emailProviderPreset(provider);
  if (provider === "custom") return "custom read-only imap endpoint";
  return `${preset.host}:${preset.port} · ${preset.credentialLabel}`;
}

function endpointValue(host: string, port: number, secure: boolean): string {
  return `${secure ? "imaps" : "imap"}://${host}:${port}`;
}

function parseEndpoint(value: string): { host: string; port: number; secure: boolean } {
  const normalized = value.trim().includes("://") ? value.trim() : `imaps://${value.trim()}`;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("imap endpoint must look like imaps://mail.example.com:993");
  }
  if (url.protocol !== "imap:" && url.protocol !== "imaps:") throw new Error("imap endpoint must use imap:// or imaps://");
  if (!url.hostname) throw new Error("imap endpoint host is required");
  const secure = url.protocol === "imaps:";
  const port = url.port ? Number.parseInt(url.port, 10) : secure ? 993 : 143;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("imap endpoint port is invalid");
  return { host: url.hostname, port, secure };
}
