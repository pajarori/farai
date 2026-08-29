import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_MODEL_BASE_URL, DEFAULT_MODEL_ID, DEFAULT_MODEL_PROVIDER_ID, DEFAULT_MODEL_PUBLIC_API_KEY } from "./default-model";
import { globalDataDir, loadGlobalConfig } from "./global-config";
import { loadConfig, updateConfig } from "./config";
import { fetchAvailableModelIds, HEURISTIC_MODEL_ID, resolveModel, type ConcreteResolvedModel, type ResolvedModel } from "./model-registry";
import { loadModelProfiles, resolveProfile, resolveProfileApiKey, type ModelProfile } from "./model-profiles";
import type { ModelPricingSnapshot } from "../types";

export type ModelProviderCatalog = {
  id: string;
  name?: string;
  baseUrl: string;
  protocol?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  configuredModel?: string;
  models: string[];
  checked: boolean;
  source: "config" | "profile" | "models.dev";
};

export type CatalogModelChoice = {
  id: string;
  providerID: string;
  modelID: string;
  model: string;
  label: string;
  baseUrl: string;
  verified: boolean;
  checked: boolean;
  free?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  apiKey?: string;
};

export type ModelCatalog = {
  providers: ModelProviderCatalog[];
  models: CatalogModelChoice[];
};

const DEFAULT_PROVIDER_ID = "default";
const OPENCODE_PROVIDER_ID = DEFAULT_MODEL_PROVIDER_ID;
const OPENCODE_DEFAULT_MODEL_ID = DEFAULT_MODEL_ID;
const OPENCODE_PUBLIC_API_KEY = DEFAULT_MODEL_PUBLIC_API_KEY;
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MODELS_DEV_STALE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MODELS_DEV_FETCH_TIMEOUT_MS = 4_000;
const RECENT_MODEL_LIMIT = 12;
const modelsDevRefreshes = new Map<string, Promise<Record<string, ModelsDevProvider> | undefined>>();

export async function buildModelCatalog(workspace: string, profiles = loadModelProfiles(workspace)): Promise<ModelCatalog> {
  const providers: ModelProviderCatalog[] = [];
  const models: CatalogModelChoice[] = [];
  const seenModels = new Set<string>();

  const pushChoice = (choice: CatalogModelChoice): void => {
    if (seenModels.has(choice.id)) return;
    seenModels.add(choice.id);
    models.push(choice);
  };

  const definitions = await providerDefinitions(workspace, profiles);
  const discoveries = await Promise.all(definitions.map((provider) =>
    provider.source === "models.dev"
      ? Promise.resolve(undefined)
      : fetchAvailableModelIds(provider.baseUrl, provider.apiKey, provider.protocol ? { protocol: provider.protocol } : {})
  ));
  for (const [index, provider] of definitions.entries()) {
    const discovered = discoveries[index];
    const checked = discovered !== undefined;
    const catalogModels = provider.catalogModels ?? [];
    const providerModels = discovered ?? (catalogModels.length ? catalogModels.map((model) => model.id) : provider.configuredModel ? [provider.configuredModel] : []);
    providers.push({
      id: provider.id,
      ...(provider.name ? { name: provider.name } : {}),
      baseUrl: provider.baseUrl,
      ...(provider.protocol ? { protocol: provider.protocol } : {}),
      ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      ...(provider.configuredModel ? { configuredModel: provider.configuredModel } : {}),
      models: providerModels,
      checked,
      source: provider.source
    });

    if (provider.configuredModel) {
      pushChoice(toConfiguredChoice(
        provider.id,
        provider.configuredModel,
        provider.baseUrl,
        discovered ? discovered.includes(provider.configuredModel) : false,
        checked,
        provider.apiKey
      ));
      continue;
    }

    if (discovered?.length) {
      for (const modelID of discovered) {
        const catalogModel = catalogModels.find((model) => model.id === modelID);
        pushChoice(toChoice(provider.id, modelID, provider.baseUrl, true, true, catalogModel, provider.apiKey));
      }
      continue;
    }

    if (catalogModels.length) {
      for (const model of catalogModels) {
        pushChoice(toChoice(provider.id, model.id, provider.baseUrl, true, checked, model, provider.apiKey));
      }
      continue;
    }

  }

  return { providers, models: sortModelChoices(models) };
}

export async function resolveModelSelection(workspace: string, selection?: string): Promise<ConcreteResolvedModel> {
  if (selection === HEURISTIC_MODEL_ID) return { baseUrl: resolveModel().baseUrl, model: HEURISTIC_MODEL_ID };
  if (selection) {
    const selected = (await buildModelCatalog(workspace)).models.find((model) => model.id === selection);
    if (selected) return withSavedModelLimits(modelChoiceToResolved(selected), selection, workspace);
    const profileResolved = resolveProfile(loadModelProfiles(workspace), selection);
    if (profileResolved?.model) return withSavedModelLimits(profileResolved as ConcreteResolvedModel, selection, workspace);
    return withSavedModelLimits(ensureConcrete(resolveModel({ model: selection })), selection, workspace);
  }
  return resolveDefaultCatalogModel(workspace);
}

export async function resolveDefaultCatalogModel(workspace: string): Promise<ConcreteResolvedModel> {
  const config = loadGlobalConfig();
  const catalog = await buildModelCatalog(workspace);
  const recent = readRecentModelSelections();
  for (const selection of recent) {
    const match = catalog.models.find((model) => model.id === selection);
    if (match) return withSavedModelLimits(modelChoiceToResolved(match), selection, workspace);
  }

  if (config.model) return resolveModelSelection(workspace, config.model);

  const openCodeDefault = catalog.models.find((model) => model.providerID === DEFAULT_PROVIDER_ID && model.modelID === OPENCODE_DEFAULT_MODEL_ID);
  if (openCodeDefault) return withSavedModelLimits(modelChoiceToResolved(openCodeDefault), openCodeDefault.id, workspace);

  const first = sortModelChoices(catalog.models).find((model) => model.verified) ?? sortModelChoices(catalog.models)[0];
  if (first) return withSavedModelLimits(modelChoiceToResolved(first), first.id, workspace);

  const fallback = resolveModel();
  throw new Error(
    `No planner model configured and no usable models were found from ${MODELS_DEV_URL} or configured /models endpoints. ` +
      `Last checked endpoint: ${fallback.baseUrl.replace(/\/$/, "")}/models.`
  );
}

export async function rememberModelSelection(selection: string, hint: {
  modelID?: string;
  providerID?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  workspace?: string;
} = {}): Promise<void> {
  if (!selection || selection === HEURISTIC_MODEL_ID) return;
  const recent = [selection, ...readRecentModelSelections().filter((item) => item !== selection)].slice(0, RECENT_MODEL_LIMIT);
  const profile = hint.workspace ? resolveProfile(loadModelProfiles(hint.workspace), selection) : undefined;
  const lookupModel = hint.modelID ?? profile?.model ?? selection;
  const providerHint = normalizeModelsDevProviderHint(hint.providerID, profile);
  const fetched = hint.contextWindow
    ? {
        canonicalModel: lookupModel,
        contextWindow: hint.contextWindow,
        ...(hint.maxOutputTokens ? { maxOutputTokens: hint.maxOutputTokens } : {})
      }
    : await lookupModelsDevLimits(lookupModel, providerHint ?? (profile ? selection : undefined), profile?.baseUrl);
  updateConfig((config) => ({
    ...config,
    model: selection,
    recentModels: recent,
    ...(fetched ? {
      modelLimits: {
        ...(config.modelLimits ?? {}),
        [selection]: {
          contextWindow: fetched.contextWindow,
          ...(fetched.maxOutputTokens ? { maxOutputTokens: fetched.maxOutputTokens } : {}),
          source: "models.dev",
          canonicalModel: fetched.canonicalModel
        }
      }
    } : {})
  }));
}

function normalizeModelsDevProviderHint(providerID: string | undefined, profile: ResolvedModel | undefined): string | undefined {
  if (providerID !== DEFAULT_PROVIDER_ID) return providerID;
  if (!profile && resolveModel().baseUrl === DEFAULT_MODEL_BASE_URL) return OPENCODE_PROVIDER_ID;
  return undefined;
}

export function readRecentModelSelections(): string[] {
  return loadConfig().recentModels ?? [];
}

export function defaultModelSelection(): string | undefined {
  return readRecentModelSelections()[0] ?? loadConfig().model;
}

export function displayModelSelection(workspace: string, selection?: string): string {
  if (selection) {
    const profile = loadModelProfiles(workspace).find((candidate) => candidate.name === selection);
    return profile?.model ?? selection;
  }
  return defaultModelSelection() ?? "auto";
}

type CatalogModelMetadata = {
  id: string;
  name?: string;
  free?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  releaseDate?: string;
};

type ProviderDefinition = {
  id: string;
  name?: string;
  baseUrl: string;
  protocol?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  configuredModel?: string;
  source: ModelProviderCatalog["source"];
  catalogModels?: CatalogModelMetadata[];
};

async function providerDefinitions(workspace: string, profiles: ModelProfile[]): Promise<ProviderDefinition[]> {
  const config = loadGlobalConfig();
  const defaultModel = resolveModel();
  const modelsDev = await readModelsDevCatalog();
  const definitions: ProviderDefinition[] = [];
  if (config.baseUrl && config.baseUrl !== DEFAULT_MODEL_BASE_URL) {
    definitions.push({
      id: DEFAULT_PROVIDER_ID,
      baseUrl: defaultModel.baseUrl,
      ...(config.apiKeyEnv ? { apiKeyEnv: config.apiKeyEnv } : {}),
      ...(defaultModel.apiKey ? { apiKey: defaultModel.apiKey } : {}),
      ...(defaultModel.model && !defaultModel.model.includes(":") ? { configuredModel: defaultModel.model } : {}),
      source: "config"
    });
  }
  for (const profile of profiles) {
    const definition = profileToProvider(profile, defaultModel, modelsDev);
    if (definition) definitions.push(definition);
  }
  const openCode = modelsDev?.[OPENCODE_PROVIDER_ID];
  const configuredOpenCode = definitions.some((provider) => provider.id === DEFAULT_PROVIDER_ID);
  if (openCode && !configuredOpenCode) {
    const hasApiKey = openCode.env.some((name) => Boolean(process.env[name]));
    const freeModels = Object.values(openCode.models).filter((model) => hasApiKey || isFreeModel(model));
    if (freeModels.length) {
      definitions.push({
        id: DEFAULT_PROVIDER_ID,
        name: openCode.name,
        baseUrl: openCode.api,
        ...(openCode.env[0] ? { apiKeyEnv: openCode.env[0] } : {}),
        apiKey: openCode.env.map((name) => process.env[name]).find(Boolean) ?? OPENCODE_PUBLIC_API_KEY,
        source: "models.dev",
        catalogModels: freeModels.map((model) => ({
          id: model.id,
          ...(model.name ? { name: model.name } : {}),
          free: isFreeModel(model),
          ...(model.limit?.context ? { contextWindow: model.limit.context } : {}),
          ...(model.limit?.output ? { maxOutputTokens: model.limit.output } : {}),
          ...(model.release_date ? { releaseDate: model.release_date } : {})
        }))
      });
    }
  }
  return definitions;
}

function profileToProvider(
  profile: ModelProfile,
  defaultModel: ResolvedModel,
  modelsDev?: Record<string, ModelsDevProvider>
): ProviderDefinition | undefined {
  if (profile.model === HEURISTIC_MODEL_ID) return undefined;
  const apiKey = resolveProfileApiKey(profile);
  const baseUrl = profile.baseUrl ?? defaultModel.baseUrl;
  const endpointProvider = modelsDevProviderForEndpoint(modelsDev, baseUrl);
  const catalogModels = profile.models?.map((model) => catalogModelMetadata(model, endpointProvider?.models[model])).filter((model) => model.id)
    ?? (endpointProvider ? Object.values(endpointProvider.models).map((model) => catalogModelMetadata(model.id, model)) : undefined);
  return {
    id: profile.name,
    baseUrl,
    ...(profile.protocol ? { protocol: profile.protocol } : {}),
    ...(profile.apiKeyEnv ? { apiKeyEnv: profile.apiKeyEnv } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(profile.model ? { configuredModel: profile.model } : {}),
    ...(catalogModels?.length ? { catalogModels } : {}),
    source: "profile"
  };
}

function modelsDevProviderForEndpoint(
  catalog: Record<string, ModelsDevProvider> | undefined,
  baseUrl: string
): ModelsDevProvider | undefined {
  const endpoint = normalizeEndpoint(baseUrl);
  return Object.values(catalog ?? {}).find((provider) => normalizeEndpoint(provider.api) === endpoint);
}

function catalogModelMetadata(id: string, model?: ModelsDevModel): CatalogModelMetadata {
  return {
    id,
    ...(model?.name ? { name: model.name } : {}),
    ...(model ? { free: isFreeModel(model) } : {}),
    ...(model?.limit?.context ? { contextWindow: model.limit.context } : {}),
    ...(model?.limit?.output ? { maxOutputTokens: model.limit.output } : {}),
    ...(model?.release_date ? { releaseDate: model.release_date } : {})
  };
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function toChoice(providerID: string, modelID: string, baseUrl: string, verified: boolean, checked: boolean, metadata?: CatalogModelMetadata, apiKey?: string): CatalogModelChoice {
  const id = providerID === DEFAULT_PROVIDER_ID ? modelID : `${providerID}:${modelID}`;
  return {
    id,
    providerID,
    modelID,
    model: id,
    label: metadata?.name ?? modelID,
    baseUrl,
    verified,
    checked,
    ...(metadata?.free !== undefined ? { free: metadata.free } : {}),
    ...(metadata?.contextWindow ? { contextWindow: metadata.contextWindow } : {}),
    ...(metadata?.maxOutputTokens ? { maxOutputTokens: metadata.maxOutputTokens } : {}),
    ...(apiKey ? { apiKey } : {})
  };
}

function toConfiguredChoice(providerID: string, modelID: string, baseUrl: string, verified: boolean, checked: boolean, apiKey?: string): CatalogModelChoice {
  if (providerID === DEFAULT_PROVIDER_ID) return toChoice(providerID, modelID, baseUrl, verified, checked, undefined, apiKey);
  return {
    id: providerID,
    providerID,
    modelID,
    model: providerID,
    label: providerID,
    baseUrl,
    verified,
    checked,
    ...(apiKey ? { apiKey } : {})
  };
}

function modelChoiceToResolved(choice: CatalogModelChoice): ConcreteResolvedModel {
  return {
    baseUrl: choice.baseUrl,
    model: choice.modelID,
    ...(choice.apiKey ? { apiKey: choice.apiKey } : {}),
    ...(choice.contextWindow ? { contextWindow: choice.contextWindow } : {}),
    ...(choice.maxOutputTokens ? { maxOutputTokens: choice.maxOutputTokens } : {})
  };
}

function sortModelChoices(models: CatalogModelChoice[]): CatalogModelChoice[] {
  const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"];
  return models.slice().sort((a, b) => {
    if (a.free !== b.free) return a.free ? -1 : 1;
    const aPriority = priority.findIndex((filter) => a.modelID.includes(filter));
    const bPriority = priority.findIndex((filter) => b.modelID.includes(filter));
    if (aPriority !== bPriority) return bPriority - aPriority;
    const aLatest = a.modelID.includes("latest") ? 0 : 1;
    const bLatest = b.modelID.includes("latest") ? 0 : 1;
    if (aLatest !== bLatest) return aLatest - bLatest;
    return b.modelID.localeCompare(a.modelID);
  });
}

type ModelsDevModel = {
  id: string;
  name?: string;
  release_date?: string;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
};

type ModelsDevProvider = {
  id: string;
  name: string;
  api: string;
  env: string[];
  models: Record<string, ModelsDevModel>;
};

export type ModelsDevModelLimits = {
  canonicalModel: string;
  contextWindow: number;
  maxOutputTokens?: number;
};

export async function lookupModelsDevPricing(model: string, providerHint?: string, baseUrlHint?: string): Promise<ModelPricingSnapshot | undefined> {
  const catalog = await readModelsDevCatalog();
  if (!catalog) return undefined;
  const candidates = modelLookupCandidates(model);
  const providerHints = providerLookupCandidates(model, providerHint);
  const endpointProviderID = baseUrlHint
    ? Object.entries(catalog).find(([, provider]) => normalizeEndpoint(provider.api) === normalizeEndpoint(baseUrlHint))?.[0]
    : undefined;
  const matches = Object.entries(catalog).flatMap(([providerID, provider]) => {
    const entry = matchModelsDevEntry(provider.models, candidates);
    return entry?.cost?.input !== undefined && entry.cost.output !== undefined ? [{ providerID, entry }] : [];
  });
  if (!matches.length) return undefined;
  const canonicalProvider = canonicalProviderForModel(longestCanonicalModel(matches));
  const selected = (endpointProviderID ? matches.find((match) => match.providerID === endpointProviderID) : undefined)
    ?? providerHints.map((hint) => matches.find((match) => match.providerID === hint)).find(Boolean)
    ?? (canonicalProvider ? matches.find((match) => match.providerID === canonicalProvider) : undefined)
    ?? consensusPricingMatch(matches);
  if (!selected?.entry.cost) return undefined;
  return {
    source: "models.dev",
    currency: "USD",
    unitTokens: 1_000_000,
    providerId: selected.providerID,
    model: selected.entry.id,
    inputPerMillion: selected.entry.cost.input!,
    outputPerMillion: selected.entry.cost.output!,
    ...(selected.entry.cost.cache_read !== undefined ? { cacheReadPerMillion: selected.entry.cost.cache_read } : {}),
    ...(selected.entry.cost.cache_write !== undefined ? { cacheWritePerMillion: selected.entry.cost.cache_write } : {})
  };
}

export async function lookupModelsDevLimits(model: string, providerHint?: string, baseUrlHint?: string): Promise<ModelsDevModelLimits | undefined> {
  const catalog = await readModelsDevCatalog();
  if (!catalog) return undefined;
  const candidates = modelLookupCandidates(model);
  const providerHints = providerLookupCandidates(model, providerHint);
  const endpointProviderID = baseUrlHint
    ? Object.entries(catalog).find(([, provider]) => normalizeEndpoint(provider.api) === normalizeEndpoint(baseUrlHint))?.[0]
    : undefined;
  const matches = Object.entries(catalog).flatMap(([providerID, provider]) => {
    const entry = matchModelsDevEntry(provider.models, candidates);
    return entry?.limit?.context ? [{ providerID, entry }] : [];
  });
  if (!matches.length) return undefined;
  const canonicalProvider = canonicalProviderForModel(longestCanonicalModel(matches));
  const selected = (endpointProviderID ? matches.find((match) => match.providerID === endpointProviderID) : undefined)
    ?? providerHints.map((hint) => matches.find((match) => match.providerID === hint)).find(Boolean)
    ?? (canonicalProvider ? matches.find((match) => match.providerID === canonicalProvider) : undefined)
    ?? consensusLimitMatch(matches);
  if (!selected) return undefined;
  return {
    canonicalModel: selected.entry.id,
    contextWindow: selected.entry.limit!.context!,
    ...(selected.entry.limit?.output ? { maxOutputTokens: selected.entry.limit.output } : {})
  };
}

function withSavedModelLimits(resolved: ConcreteResolvedModel, selection: string, workspace: string): ConcreteResolvedModel {
  const saved = loadConfig(workspace).modelLimits?.[selection];
  if (!saved) return resolved;
  return {
    ...resolved,
    ...(resolved.contextWindow ? {} : saved.contextWindow ? { contextWindow: saved.contextWindow } : {}),
    ...(resolved.maxOutputTokens ? {} : saved.maxOutputTokens ? { maxOutputTokens: saved.maxOutputTokens } : {})
  };
}

function modelLookupCandidates(model: string): string[] {
  const normalized = model.trim().toLowerCase().replace(/^models\//, "");
  if (!normalized) return [];
  const candidates: string[] = [];
  const add = (value: string): void => {
    const clean = value.replace(/^\/+|\/+$/g, "");
    if (clean && !candidates.includes(clean)) candidates.push(clean);
  };
  add(normalized);
  const slashParts = normalized.split("/").filter(Boolean);
  for (let index = 1; index < slashParts.length; index += 1) add(slashParts.slice(index).join("/"));
  const current = [...candidates];
  for (const candidate of current) {
    const colon = candidate.indexOf(":");
    if (colon > 0 && colon < candidate.length - 1) add(candidate.slice(colon + 1));
  }
  return candidates;
}

function matchModelsDevEntry(models: Record<string, ModelsDevModel>, candidates: string[]): ModelsDevModel | undefined {
  for (const candidate of candidates) {
    const exact = models[candidate] ?? Object.values(models).find((entry) => entry.id.toLowerCase() === candidate);
    if (exact) return exact;
  }
  return Object.values(models)
    .filter((entry) => candidates.some((candidate) => containsCanonicalModel(candidate, entry.id)))
    .sort((a, b) => b.id.length - a.id.length || a.id.localeCompare(b.id))[0];
}

function containsCanonicalModel(selection: string, model: string): boolean {
  const candidate = selection.toLowerCase();
  const canonical = model.toLowerCase();
  let offset = candidate.indexOf(canonical);
  while (offset >= 0) {
    const before = offset === 0 ? "" : candidate[offset - 1]!;
    const afterOffset = offset + canonical.length;
    const after = afterOffset === candidate.length ? "" : candidate[afterOffset]!;
    if ((!before || isModelBoundary(before)) && (!after || isModelBoundary(after))) return true;
    offset = candidate.indexOf(canonical, offset + 1);
  }
  return false;
}

function isModelBoundary(value: string): boolean {
  return /[-_.:/@\s()[\]{}]/.test(value);
}

function longestCanonicalModel(matches: Array<{ entry: ModelsDevModel }>): string {
  return matches.map((match) => match.entry.id).sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? "";
}

function providerLookupCandidates(model: string, providerHint?: string): string[] {
  const candidates: string[] = [];
  const add = (value: string | undefined): void => {
    const clean = value?.trim().toLowerCase();
    if (clean && !candidates.includes(clean)) candidates.push(clean);
  };
  add(providerHint);
  const normalized = model.trim().toLowerCase().replace(/^models\//, "");
  add(normalized.split("/")[0]);
  const colon = normalized.indexOf(":");
  if (colon > 0) add(normalized.slice(0, colon));
  return candidates;
}

function canonicalProviderForModel(model: string): string | undefined {
  if (/^(gpt-|o\d|chatgpt-|codex-)/.test(model)) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "google";
  if (/^(llama-|meta-llama)/.test(model)) return "meta";
  if (model.startsWith("mistral-") || model.startsWith("codestral-")) return "mistral";
  if (model.startsWith("command-")) return "cohere";
  return undefined;
}

function consensusLimitMatch(matches: Array<{ providerID: string; entry: ModelsDevModel }>): { providerID: string; entry: ModelsDevModel } | undefined {
  const counts = new Map<string, number>();
  for (const match of matches) {
    const key = `${match.entry.limit?.context ?? 0}:${match.entry.limit?.output ?? 0}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return matches.slice().sort((a, b) => {
    const aKey = `${a.entry.limit?.context ?? 0}:${a.entry.limit?.output ?? 0}`;
    const bKey = `${b.entry.limit?.context ?? 0}:${b.entry.limit?.output ?? 0}`;
    const countDelta = (counts.get(bKey) ?? 0) - (counts.get(aKey) ?? 0);
    if (countDelta !== 0) return countDelta;
    return (b.entry.limit?.context ?? 0) - (a.entry.limit?.context ?? 0);
  })[0];
}

function consensusPricingMatch(matches: Array<{ providerID: string; entry: ModelsDevModel }>): { providerID: string; entry: ModelsDevModel } | undefined {
  const counts = new Map<string, number>();
  for (const match of matches) {
    const cost = match.entry.cost;
    const key = `${cost?.input ?? 0}:${cost?.output ?? 0}:${cost?.cache_read ?? 0}:${cost?.cache_write ?? 0}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return matches.slice().sort((a, b) => {
    const aCost = a.entry.cost;
    const bCost = b.entry.cost;
    const aKey = `${aCost?.input ?? 0}:${aCost?.output ?? 0}:${aCost?.cache_read ?? 0}:${aCost?.cache_write ?? 0}`;
    const bKey = `${bCost?.input ?? 0}:${bCost?.output ?? 0}:${bCost?.cache_read ?? 0}:${bCost?.cache_write ?? 0}`;
    return (counts.get(bKey) ?? 0) - (counts.get(aKey) ?? 0) || a.providerID.localeCompare(b.providerID);
  })[0];
}

async function readModelsDevCatalog(): Promise<Record<string, ModelsDevProvider> | undefined> {
  const cache = readCachedModelsDevCatalog();
  if (cache && Date.now() - cache.fetchedAt <= MODELS_DEV_CACHE_TTL_MS) return cache.providers;
  const cachePath = modelsDevCachePath();
  let refresh = modelsDevRefreshes.get(cachePath);
  if (!refresh) {
    refresh = fetchModelsDevCatalog().then((providers) => {
      if (providers) writeCachedModelsDevCatalog(providers);
      return providers;
    }).finally(() => {
      modelsDevRefreshes.delete(cachePath);
    });
    modelsDevRefreshes.set(cachePath, refresh);
  }
  return await refresh ?? cache?.providers;
}

export async function fetchModelsDevCatalog(
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = MODELS_DEV_FETCH_TIMEOUT_MS
): Promise<Record<string, ModelsDevProvider> | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("models.dev request timed out")), Math.max(1, timeoutMs));
  try {
    const response = await fetchImpl(MODELS_DEV_URL, {
      headers: { "user-agent": "farai" },
      signal: controller.signal
    });
    if (!response.ok) return undefined;
    return normalizeModelsDevCatalog(await response.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function readCachedModelsDevCatalog(): { fetchedAt: number; providers: Record<string, ModelsDevProvider> } | undefined {
  try {
    const path = modelsDevCachePath();
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { fetchedAt?: number; providers?: unknown };
    if (typeof parsed.fetchedAt !== "number" || Date.now() - parsed.fetchedAt > MODELS_DEV_STALE_TTL_MS) return undefined;
    const providers = normalizeModelsDevCatalog(parsed.providers);
    return providers ? { fetchedAt: parsed.fetchedAt, providers } : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedModelsDevCatalog(providers: Record<string, ModelsDevProvider>): void {
  const path = modelsDevCachePath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ fetchedAt: Date.now(), providers })}\n`);
  renameSync(temporary, path);
}

function normalizeModelsDevCatalog(value: unknown): Record<string, ModelsDevProvider> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, ModelsDevProvider> = {};
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const provider = entry as Record<string, unknown>;
    const valid = typeof provider.id === "string" &&
      typeof provider.name === "string" &&
      typeof provider.api === "string" &&
      Array.isArray(provider.env) &&
      provider.env.every((item) => typeof item === "string") &&
      provider.models !== undefined &&
      typeof provider.models === "object" &&
      !Array.isArray(provider.models);
    if (!valid) continue;
    const id = provider.id as string;
    result[id] = provider as ModelsDevProvider;
  }
  return Object.keys(result).length ? result : undefined;
}

function isFreeModel(model: ModelsDevModel): boolean {
  return (model.cost?.input ?? 0) === 0 && (model.cost?.output ?? 0) === 0;
}

function ensureConcrete(resolved: ResolvedModel): ConcreteResolvedModel {
  if (!resolved.model) {
    throw new Error(
      `No planner model configured for ${resolved.baseUrl}. Set model in config or choose one from /model.`
    );
  }
  return resolved as ConcreteResolvedModel;
}

function modelsDevCachePath(): string {
  return join(globalDataDir(), "cache", "models-dev.json");
}
