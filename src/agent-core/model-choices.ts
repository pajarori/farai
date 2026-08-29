import { buildModelCatalog, type ModelCatalog } from "./model-catalog";
import type { ModelProfile } from "./model-profiles";

export type ModelChoiceInfo = {
  id: string;
  model: string;
  label?: string;
  baseUrl?: string;
  providerID?: string;
  verified: boolean;
  checked: boolean;
  free?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
};

export async function listModelChoices(profiles: ModelProfile[], workspace = process.cwd()): Promise<ModelChoiceInfo[]> {
  return modelChoicesFromCatalog(await buildModelCatalog(workspace, profiles));
}

export function modelChoicesFromCatalog(catalog: ModelCatalog): ModelChoiceInfo[] {
  return catalog.models.map((choice): ModelChoiceInfo => ({
      id: choice.id,
      model: choice.model,
      label: choice.label,
      baseUrl: choice.baseUrl,
      providerID: choice.providerID,
      verified: choice.verified,
      checked: choice.checked,
      ...(choice.free !== undefined ? { free: choice.free } : {}),
      ...(choice.contextWindow !== undefined ? { contextWindow: choice.contextWindow } : {}),
      ...(choice.maxOutputTokens !== undefined ? { maxOutputTokens: choice.maxOutputTokens } : {})
  }));
}
