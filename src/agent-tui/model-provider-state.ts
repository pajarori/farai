import type { ModelProviderInfo, ModelProviderProbe, ModelProviderProtocol } from "../agent-core/model-provider-management";

export type ModelProviderWizardMode = "add" | "edit";
export type ModelProviderWizardField = "id" | "protocol" | "baseUrl" | "apiKey" | "model" | "review";

export type ModelProviderWizardState = {
  mode: ModelProviderWizardMode;
  field: ModelProviderWizardField;
  id: string;
  originalID?: string;
  protocol: ModelProviderProtocol;
  baseUrl: string;
  apiKey: string;
  credentialStored: boolean;
  removeCredential: boolean;
  model: string;
  location: "global" | "project";
  probe: ModelProviderProbe | undefined;
  busy: boolean;
  error: string | undefined;
};

const FIELD_ORDER: ModelProviderWizardField[] = ["id", "protocol", "baseUrl", "apiKey", "model", "review"];
const PROTOCOL_ORDER: ModelProviderProtocol[] = ["auto", "openai-chat", "anthropic-messages"];

export function createModelProviderWizard(provider?: ModelProviderInfo): ModelProviderWizardState {
  if (!provider) {
    return {
      mode: "add",
      field: "id",
      id: "",
      protocol: "auto",
      baseUrl: "",
      apiKey: "",
      credentialStored: false,
      removeCredential: false,
      model: "",
      location: "global",
      busy: false,
      probe: undefined,
      error: undefined
    };
  }
  return {
    mode: "edit",
    field: "protocol",
    id: provider.id,
    originalID: provider.id,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: "",
    credentialStored: provider.credentialSource === "stored",
    removeCredential: false,
    model: provider.configuredModel ?? "",
    location: provider.location ?? "global",
    busy: false,
    probe: undefined,
    error: undefined
  };
}

export function modelProviderWizardFieldMove(field: ModelProviderWizardField, delta: -1 | 1): ModelProviderWizardField {
  const index = FIELD_ORDER.indexOf(field);
  return FIELD_ORDER[Math.max(0, Math.min(FIELD_ORDER.length - 1, index + delta))] ?? field;
}

export function modelProviderProtocolMove(protocol: ModelProviderProtocol, delta: number): ModelProviderProtocol {
  const index = PROTOCOL_ORDER.indexOf(protocol);
  return PROTOCOL_ORDER[(index + delta + PROTOCOL_ORDER.length) % PROTOCOL_ORDER.length] ?? "auto";
}

export function modelProviderProtocolLabel(protocol: ModelProviderProtocol): string {
  if (protocol === "openai-chat") return "openai chat";
  if (protocol === "anthropic-messages") return "anthropic messages";
  return "auto-detect";
}

export function modelProviderWizardStep(field: ModelProviderWizardField): number {
  return FIELD_ORDER.indexOf(field) + 1;
}

export function modelProviderWizardStepCount(): number {
  return FIELD_ORDER.length;
}
