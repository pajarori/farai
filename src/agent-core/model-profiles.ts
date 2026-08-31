import { resolveDefaultModel, type ResolvedModel } from "./model-registry";
import { configPath, loadRawConfig, updateConfig, writeConfig, type ConfigLocation } from "./config";
import { readCredential, readCredentialSync, writeCredential, writeCredentialSync } from "./credential-store";
import {
  isEnvironmentVariableName,
  normalizeEnvironmentVariableName,
  normalizeModelProviderBaseUrl,
  normalizeModelProviderID
} from "./model-provider-validation";

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

type ModelProfileScope = {
  location: ConfigLocation;
  workspace: string;
};

const profileScopes = new WeakMap<ModelProfile, ModelProfileScope>();

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function profileFromEntry(name: string, entry: Record<string, unknown>, workspace?: string, location?: ConfigLocation): ModelProfile {
  const configuredApiKeyEnv = str(entry.env_key) ?? str(entry.apiKeyEnv);
  const apiKeyEnv = configuredApiKeyEnv && isEnvironmentVariableName(configuredApiKeyEnv) ? configuredApiKeyEnv : undefined;
  const inlineApiKey = str(entry.api_key) ?? str(entry.apiKey);
  const model = str(entry.model);
  const baseUrl = str(entry.base_url) ?? str(entry.baseUrl);
  const protocol = str(entry.protocol);
  const contextWindow = num(entry.context_window ?? entry.contextWindow);
  const maxOutputTokens = num(entry.max_output_tokens ?? entry.maxOutputTokens);
  const models = Array.isArray(entry.models) ? entry.models.filter((item): item is string => typeof item === "string") : undefined;
  const profile: ModelProfile = {
    name,
    ...(model ? { model } : {}),
    ...(models?.length ? { models } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(inlineApiKey ? { apiKey: inlineApiKey } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(protocol ? { protocol } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {})
  };
  if (workspace && location) profileScopes.set(profile, { workspace, location });
  return profile;
}

export function loadModelProfiles(workspace: string): ModelProfile[] {
  const global = loadRawConfig(configPath("global")).modelProviders ?? {};
  const project = loadRawConfig(configPath("project", workspace)).modelProviders ?? {};
  migrateInlineProviderCredentials(global, "global", workspace);
  migrateInlineProviderCredentials(project, "project", workspace);
  const providers = { ...global, ...project };
  return Object.entries(providers).map(([name, entry]) => profileFromEntry(name, entry, workspace, name in project ? "project" : "global"));
}

export function modelProfilePaths(workspace: string): string[] {
  return [configPath("global"), configPath("project", workspace)];
}

export async function addModelProfile(workspace: string, input: AddModelProfileInput, location: ModelProfileLocation = "global"): Promise<{ path: string; profile: ModelProfile }> {
  const name = normalizeModelProviderID(input.name);
  const model = input.model?.trim();
  const baseUrl = input.baseUrl === undefined ? undefined : normalizeModelProviderBaseUrl(input.baseUrl);
  const apiKeyEnv = input.apiKeyEnv === undefined ? undefined : normalizeEnvironmentVariableName(input.apiKeyEnv);
  const previous = loadRawConfig(configPath(location, workspace));
  const path = updateConfig((config) => {
    const providers = { ...(config.modelProviders ?? {}) };
    const current = providers[name] ?? {};
    providers[name] = {
      ...current,
      ...(model ? { model } : {}),
      ...(baseUrl !== undefined ? { base_url: baseUrl } : {}),
      ...(apiKeyEnv !== undefined ? { env_key: apiKeyEnv } : {}),
      ...(input.contextWindow !== undefined ? { context_window: input.contextWindow } : {}),
      ...(input.maxOutputTokens !== undefined ? { max_output_tokens: input.maxOutputTokens } : {})
    };
    return { ...config, modelProviders: providers };
  }, location, workspace);
  try {
    if (input.apiKey) await writeCredential("model-provider", name, input.apiKey, location, workspace);
  } catch (error) {
    writeConfig(previous, location, workspace);
    throw error;
  }
  return { path, profile: loadModelProfiles(workspace).find((profile) => profile.name === name)! };
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

async function resolvedProfileModelAsync(profile: ModelProfile, model: string): Promise<ResolvedModel> {
  const defaultModel = resolveDefaultModel();
  const apiKey = await resolveProfileApiKeyAsync(profile);
  return {
    baseUrl: profile.baseUrl ?? defaultModel.baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(profile.protocol ? { protocol: profile.protocol } : {}),
    ...(profile.contextWindow ? { contextWindow: profile.contextWindow } : {}),
    ...(profile.maxOutputTokens ? { maxOutputTokens: profile.maxOutputTokens } : {})
  };
}

export async function resolveProfileAsync(profiles: ModelProfile[], name: string): Promise<ResolvedModel | undefined> {
  const qualified = parseQualifiedModelName(name);
  if (qualified) {
    const profile = findProfile(profiles, qualified.profile);
    if (!profile) return undefined;
    return await resolvedProfileModelAsync(profile, qualified.model);
  }
  const profile = findProfile(profiles, name);
  if (!profile || !profile.model) return undefined;
  return await resolvedProfileModelAsync(profile, profile.model);
}

export function resolveProfileApiKey(profile: ModelProfile): string | undefined {
  const scope = profileScopes.get(profile);
  if (!scope) return profile.apiKey ?? environmentCredential(profile.apiKeyEnv);
  const stored = readCredentialSync("model-provider", profile.name, scope.location, scope.workspace);
  return stored ?? environmentCredential(profile.apiKeyEnv) ?? profile.apiKey;
}

export async function resolveProfileApiKeyAsync(profile: ModelProfile): Promise<string | undefined> {
  const scope = profileScopes.get(profile);
  if (!scope) return profile.apiKey ?? environmentCredential(profile.apiKeyEnv);
  const stored = await readCredential("model-provider", profile.name, scope.location, scope.workspace);
  return stored ?? environmentCredential(profile.apiKeyEnv) ?? profile.apiKey;
}

function parseQualifiedModelName(name: string): { profile: string; model: string } | undefined {
  const separator = name.indexOf(":");
  if (separator <= 0 || separator === name.length - 1) return undefined;
  return { profile: name.slice(0, separator), model: name.slice(separator + 1) };
}

function environmentCredential(name: string | undefined): string | undefined {
  return name && isEnvironmentVariableName(name) ? process.env[name] : undefined;
}

function migrateInlineProviderCredentials(providers: Record<string, Record<string, unknown>>, location: ConfigLocation, workspace: string): void {
  for (const [name, entry] of Object.entries(providers)) {
    const inline = str(entry.api_key) ?? str(entry.apiKey);
    const configuredApiKeyEnv = str(entry.env_key) ?? str(entry.apiKeyEnv);
    const legacyEnvSecret = configuredApiKeyEnv && !isEnvironmentVariableName(configuredApiKeyEnv) ? configuredApiKeyEnv : undefined;
    const credential = inline ?? legacyEnvSecret;
    if (!credential) continue;
    try {
      writeCredentialSync("model-provider", name, credential, location, workspace);
      if (inline) {
        delete entry.api_key;
        delete entry.apiKey;
      }
      if (legacyEnvSecret) {
        delete entry.env_key;
        delete entry.apiKeyEnv;
      }
      entry.credential_configured = true;
      const config = loadRawConfig(configPath(location, workspace));
      const configured = { ...(config.modelProviders ?? {}) };
      configured[name] = { ...(configured[name] ?? {}) };
      if (inline) {
        delete configured[name]!.api_key;
        delete configured[name]!.apiKey;
      }
      if (legacyEnvSecret) {
        delete configured[name]!.env_key;
        delete configured[name]!.apiKeyEnv;
      }
      configured[name]!.credential_configured = true;
      writeConfig({ ...config, modelProviders: configured }, location, workspace);
    } catch {
    }
  }
}
