import { resolveDefaultModel, type ResolvedModel } from "./model-registry";
import { configPath, loadConfig, resolveApiKey, updateConfig, writeAuthEntry, type ConfigLocation } from "./config";

export type ModelProfile = {
  name: string;
  model?: string;
  models?: string[];
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  protocol?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
};

export type ModelProfileLocation = ConfigLocation;

export type AddModelProfileInput = {
  name: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function profileFromEntry(name: string, entry: Record<string, unknown>, workspace?: string): ModelProfile {
  const apiKeyEnv = str(entry.env_key) ?? str(entry.apiKeyEnv);
  const inlineApiKey = str(entry.api_key) ?? str(entry.apiKey);
  const apiKey = resolveApiKey(name, { ...(apiKeyEnv ? { apiKeyEnv } : {}), ...(inlineApiKey ? { inlineApiKey } : {}), ...(workspace ? { workspace } : {}) });
  const model = str(entry.model);
  const baseUrl = str(entry.base_url) ?? str(entry.baseUrl);
  const protocol = str(entry.protocol);
  const contextWindow = num(entry.context_window ?? entry.contextWindow);
  const maxOutputTokens = num(entry.max_output_tokens ?? entry.maxOutputTokens);
  const models = Array.isArray(entry.models) ? entry.models.filter((item): item is string => typeof item === "string") : undefined;
  return {
    name,
    ...(model ? { model } : {}),
    ...(models?.length ? { models } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(protocol ? { protocol } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {})
  };
}

export function loadModelProfiles(workspace: string): ModelProfile[] {
  const providers = loadConfig(workspace).modelProviders ?? {};
  return Object.entries(providers).map(([name, entry]) => profileFromEntry(name, entry, workspace));
}

export function modelProfilePaths(workspace: string): string[] {
  return [configPath("global"), configPath("project", workspace)];
}

export function addModelProfile(workspace: string, input: AddModelProfileInput, location: ModelProfileLocation = "global"): { path: string; profile: ModelProfile } {
  const name = normalizeProviderID(input.name);
  if (!name) throw new Error("Model provider name is required.");
  const path = updateConfig((config) => {
    const providers = { ...(config.modelProviders ?? {}) };
    const current = providers[name] ?? {};
    providers[name] = {
      ...current,
      ...(input.model ? { model: input.model } : {}),
      ...(input.baseUrl !== undefined ? { base_url: input.baseUrl } : {}),
      ...(input.apiKeyEnv !== undefined ? { env_key: input.apiKeyEnv } : {}),
      ...(input.contextWindow !== undefined ? { context_window: input.contextWindow } : {}),
      ...(input.maxOutputTokens !== undefined ? { max_output_tokens: input.maxOutputTokens } : {})
    };
    return { ...config, modelProviders: providers };
  }, location, workspace);
  if (input.apiKey) writeAuthEntry(name, { apiKey: input.apiKey }, location, workspace);
  return { path, profile: profileFromEntry(name, loadConfig(workspace).modelProviders?.[name] ?? {}, workspace) };
}

export function findProfile(profiles: ModelProfile[], name: string): ModelProfile | undefined {
  return profiles.find((profile) => profile.name === name);
}

export function resolveProfile(profiles: ModelProfile[], name: string): ResolvedModel | undefined {
  const qualified = parseQualifiedModelName(name);
  if (qualified) {
    const profile = findProfile(profiles, qualified.profile);
    if (!profile) return undefined;
    return resolvedProfileModel(profile, qualified.model);
  }
  const profile = findProfile(profiles, name);
  if (!profile || !profile.model) return undefined;
  return resolvedProfileModel(profile, profile.model);
}

function resolvedProfileModel(profile: ModelProfile, model: string): ResolvedModel {
  const defaultModel = resolveDefaultModel();
  const apiKey = resolveProfileApiKey(profile);
  return {
    baseUrl: profile.baseUrl ?? defaultModel.baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(profile.protocol ? { protocol: profile.protocol } : {}),
    ...(profile.contextWindow ? { contextWindow: profile.contextWindow } : {}),
    ...(profile.maxOutputTokens ? { maxOutputTokens: profile.maxOutputTokens } : {})
  };
}

export function resolveProfileApiKey(profile: ModelProfile): string | undefined {
  return profile.apiKey ?? resolveApiKey(profile.name, {
    ...(profile.apiKeyEnv ? { apiKeyEnv: profile.apiKeyEnv } : {})
  });
}

function parseQualifiedModelName(name: string): { profile: string; model: string } | undefined {
  const separator = name.indexOf(":");
  if (separator <= 0 || separator === name.length - 1) return undefined;
  return { profile: name.slice(0, separator), model: name.slice(separator + 1) };
}

function normalizeProviderID(value: string): string {
  return value.trim().replace(/\s+/g, "-").toLowerCase();
}
