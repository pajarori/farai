import { configPath, loadRawConfig, writeConfig, type ConfigLocation, type FaraiConfig } from "./config";
import { deleteCredential, legacyCredentialConfigured, readCredential, writeCredential } from "./credential-store";
import { buildModelCatalog, type ModelCatalog } from "./model-catalog";
import { loadModelProfiles, resolveProfileApiKeyAsync } from "./model-profiles";
import { normalizeModelProviderBaseUrl, normalizeModelProviderID } from "./model-provider-validation";
import { resolveProtocol } from "./provider/registry";

export { normalizeModelProviderID } from "./model-provider-validation";

export type ModelProviderProtocol = "auto" | "openai-chat" | "anthropic-messages";
export type ModelProviderCredentialAction = "keep" | "replace" | "remove";

export type ModelProviderInfo = {
  id: string;
  name?: string;
  baseUrl: string;
  protocol: ModelProviderProtocol;
  configuredModel?: string;
  models: string[];
  checked: boolean;
  reachable: boolean;
  credentialConfigured: boolean;
  credentialSource: "stored" | "environment" | "public" | "none";
  source: "builtin" | "global" | "project";
  location?: ConfigLocation;
  removable: boolean;
};

export type SaveModelProviderInput = {
  id: string;
  baseUrl: string;
  protocol?: ModelProviderProtocol;
  model?: string;
  apiKey?: string;
  credentialAction?: ModelProviderCredentialAction;
  location?: ConfigLocation;
};

export type ProbeModelProviderInput = {
  providerID?: string;
  baseUrl?: string;
  protocol?: ModelProviderProtocol;
  apiKey?: string;
  timeoutMs?: number;
};

export type ModelProviderProbe = {
  ok: boolean;
  baseUrl: string;
  protocol: Exclude<ModelProviderProtocol, "auto">;
  models: string[];
  status?: number;
  latencyMs: number;
  error?: string;
};

const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

export async function listModelProviders(workspace: string, catalog?: ModelCatalog): Promise<ModelProviderInfo[]> {
  const resolvedCatalog = catalog ?? await buildModelCatalog(workspace);
  const profiles = new Map(loadModelProfiles(workspace).map((profile) => [profile.name, profile]));
  const globalProviders = loadRawConfig(configPath("global")).modelProviders ?? {};
  const projectProviders = loadRawConfig(configPath("project", workspace)).modelProviders ?? {};
  return await Promise.all(resolvedCatalog.providers.map(async (provider) => {
    const profile = profiles.get(provider.id);
    const location = provider.id in projectProviders ? "project" : provider.id in globalProviders ? "global" : undefined;
    const configuredEntry = location === "project" ? projectProviders[provider.id] : location === "global" ? globalProviders[provider.id] : undefined;
    const stored = Boolean(configuredEntry?.credential_configured === true
      || typeof configuredEntry?.api_key === "string"
      || typeof configuredEntry?.apiKey === "string"
      || location && await readCredential("model-provider", provider.id, location, workspace).catch(() => undefined));
    const environment = Boolean(profile?.apiKeyEnv && process.env[profile.apiKeyEnv]);
    const publicCredential = !location && Boolean(provider.apiKey);
    const credentialSource = stored ? "stored" : environment ? "environment" : publicCredential ? "public" : "none";
    return {
      id: provider.id,
      ...(provider.name ? { name: provider.name } : {}),
      baseUrl: provider.baseUrl,
      protocol: configuredProtocol(provider.protocol),
      ...(provider.configuredModel ? { configuredModel: provider.configuredModel } : {}),
      models: provider.models,
      checked: provider.checked,
      reachable: provider.checked,
      credentialConfigured: credentialSource !== "none",
      credentialSource,
      source: location ?? "builtin",
      ...(location ? { location } : {}),
      removable: Boolean(location)
    };
  }));
}

export async function probeModelProvider(
  workspace: string,
  input: ProbeModelProviderInput,
  signal?: AbortSignal
): Promise<ModelProviderProbe> {
  const profile = input.providerID
    ? loadModelProfiles(workspace).find((candidate) => candidate.name === input.providerID)
    : undefined;
  const baseUrl = normalizeModelProviderBaseUrl(input.baseUrl ?? profile?.baseUrl ?? "");
  const configuredProbeProtocol = input.protocol ?? profile?.protocol;
  const resolvedProtocol = resolveProtocol({
    baseUrl,
    ...(configuredProbeProtocol ? { protocol: configuredProbeProtocol } : {})
  });
  const protocol = resolvedProtocol === "anthropic-messages" ? "anthropic-messages" : "openai-chat";
  const apiKey = input.apiKey ?? (profile ? await resolveProfileApiKeyAsync(profile) : input.providerID
    ? await readProviderCredential(workspace, input.providerID)
    : undefined);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("provider probe timed out")),
    Math.max(1, input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
  );
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: protocol === "anthropic-messages"
        ? {
            "anthropic-version": "2023-06-01",
            ...(apiKey ? { "x-api-key": apiKey } : {})
          }
        : apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        ok: false,
        baseUrl,
        protocol,
        models: [],
        status: response.status,
        latencyMs,
        error: await responseError(response)
      };
    }
    const models = modelIDs(await response.json());
    if (!models) {
      return {
        ok: false,
        baseUrl,
        protocol,
        models: [],
        status: response.status,
        latencyMs,
        error: "provider returned an unsupported /models response"
      };
    }
    return { ok: true, baseUrl, protocol, models, status: response.status, latencyMs };
  } catch (error) {
    return {
      ok: false,
      baseUrl,
      protocol,
      models: [],
      latencyMs: Date.now() - startedAt,
      error: probeError(error)
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export async function saveModelProvider(workspace: string, input: SaveModelProviderInput): Promise<{ id: string; location: ConfigLocation; path: string }> {
  const id = normalizeModelProviderID(input.id);
  const baseUrl = normalizeModelProviderBaseUrl(input.baseUrl);
  const protocol = configuredProtocol(input.protocol);
  const location = input.location ?? "global";
  const previousConfig = loadRawConfig(configPath(location, workspace));
  const previousEntry = (previousConfig.modelProviders ?? {})[id];
  const previousInlineCredential = inlineModelCredential(previousEntry);
  const previousCredentialConfigured = previousEntry?.credential_configured === true
    || previousInlineCredential !== undefined
    || legacyCredentialConfigured("model-provider", id, location, workspace);
  const previousCredential = previousInlineCredential
    ?? (previousCredentialConfigured ? await readCredential("model-provider", id, location, workspace) : undefined);
  const providers = { ...(previousConfig.modelProviders ?? {}) };
  const entry = { ...(providers[id] ?? {}) };
  delete entry.api_key;
  delete entry.apiKey;
  entry.base_url = baseUrl;
  if (protocol === "auto") delete entry.protocol;
  else entry.protocol = protocol;
  const model = input.model?.trim();
  if (model) entry.model = model;
  else delete entry.model;
  if (input.credentialAction === "replace") entry.credential_configured = true;
  if (input.credentialAction === "remove") delete entry.credential_configured;
  if (input.credentialAction !== "replace" && input.credentialAction !== "remove" && previousCredential) entry.credential_configured = true;
  providers[id] = entry;
  const nextConfig = { ...previousConfig, modelProviders: providers };

  const path = writeConfig(nextConfig, location, workspace);
  try {
    if (input.credentialAction === "replace") {
      const apiKey = input.apiKey?.trim();
      if (!apiKey) throw new Error("api key cannot be empty when replacing a credential.");
      await writeCredential("model-provider", id, apiKey, location, workspace);
    }
    if (input.credentialAction === "remove" && previousCredentialConfigured) await deleteCredential("model-provider", id, location, workspace);
  } catch (error) {
    writeConfig(previousConfig, location, workspace);
    throw error;
  }
  return { id, location, path };
}

export async function removeModelProvider(
  workspace: string,
  providerID: string,
  location?: ConfigLocation
): Promise<{ id: string; location: ConfigLocation; providerRemains: boolean }> {
  const id = normalizeModelProviderID(providerID);
  const resolvedLocation = location ?? providerLocation(workspace, id);
  if (!resolvedLocation) throw new Error(`provider ${id} is built in and cannot be removed.`);
  const previousConfigs = {
    global: loadRawConfig(configPath("global")),
    project: loadRawConfig(configPath("project", workspace))
  };
  const previousEntry = (previousConfigs[resolvedLocation].modelProviders ?? {})[id];
  const previousInlineCredential = inlineModelCredential(previousEntry);
  const previousCredentialConfigured = previousEntry?.credential_configured === true
    || previousInlineCredential !== undefined
    || legacyCredentialConfigured("model-provider", id, resolvedLocation, workspace);
  let nextConfigs = {
    global: resolvedLocation === "global" ? removeProviderEntry(previousConfigs.global, id) : previousConfigs.global,
    project: resolvedLocation === "project" ? removeProviderEntry(previousConfigs.project, id) : previousConfigs.project
  };
  const providerRemains = providerExists(nextConfigs.global, id) || providerExists(nextConfigs.project, id);
  if (!providerRemains) {
    nextConfigs = {
      global: withoutProviderSelections(nextConfigs.global, id),
      project: withoutProviderSelections(nextConfigs.project, id)
    };
  }
  const changedLocations = (["global", "project"] as const).filter((scope) => !sameConfig(previousConfigs[scope], nextConfigs[scope]));
  try {
    for (const scope of changedLocations) writeConfig(nextConfigs[scope], scope, workspace);
    if (previousCredentialConfigured) await deleteCredential("model-provider", id, resolvedLocation, workspace);
  } catch (error) {
    for (const scope of changedLocations) writeConfig(previousConfigs[scope], scope, workspace);
    throw error;
  }
  return { id, location: resolvedLocation, providerRemains };
}

function configuredProtocol(value?: string): ModelProviderProtocol {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "auto") return "auto";
  if (normalized === "openai" || normalized === "openai-chat") return "openai-chat";
  if (normalized === "anthropic" || normalized === "anthropic-messages") return "anthropic-messages";
  return "auto";
}

function providerLocation(workspace: string, providerID: string): ConfigLocation | undefined {
  if (providerID in (loadRawConfig(configPath("project", workspace)).modelProviders ?? {})) return "project";
  if (providerID in (loadRawConfig(configPath("global")).modelProviders ?? {})) return "global";
  return undefined;
}

function withoutProviderSelections(config: FaraiConfig, providerID: string): FaraiConfig {
  const next = { ...config };
  if (next.model && belongsToProvider(next.model, providerID)) delete next.model;
  if (next.recentModels) {
    const recentModels = next.recentModels.filter((selection) => !belongsToProvider(selection, providerID));
    if (recentModels.length) next.recentModels = recentModels;
    else delete next.recentModels;
  }
  if (next.modelLimits) {
    const modelLimits = Object.fromEntries(Object.entries(next.modelLimits).filter(([selection]) => !belongsToProvider(selection, providerID)));
    if (Object.keys(modelLimits).length) next.modelLimits = modelLimits;
    else delete next.modelLimits;
  }
  return next;
}

function removeProviderEntry(config: FaraiConfig, providerID: string): FaraiConfig {
  const next = { ...config };
  const providers = { ...(next.modelProviders ?? {}) };
  delete providers[providerID];
  if (Object.keys(providers).length) next.modelProviders = providers;
  else delete next.modelProviders;
  return next;
}

function providerExists(config: FaraiConfig, providerID: string): boolean {
  return providerID in (config.modelProviders ?? {});
}

function sameConfig(left: FaraiConfig, right: FaraiConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function belongsToProvider(selection: string, providerID: string): boolean {
  return selection === providerID || selection.startsWith(`${providerID}:`);
}

async function readProviderCredential(workspace: string, id: string): Promise<string | undefined> {
  const project = loadRawConfig(configPath("project", workspace)).modelProviders ?? {};
  if (id in project) return await readCredential("model-provider", id, "project", workspace);
  const global = loadRawConfig(configPath("global")).modelProviders ?? {};
  if (id in global) return await readCredential("model-provider", id, "global", workspace);
  return undefined;
}

function inlineModelCredential(entry: Record<string, unknown> | undefined): string | undefined {
  const value = entry?.api_key ?? entry?.apiKey;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function responseError(response: Response): Promise<string> {
  try { await response.body?.cancel(); } catch { }
  return `provider returned http ${response.status}`;
}

function probeError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "provider probe timed out or was cancelled";
  if (error instanceof Error) return error.message;
  return String(error);
}

function modelIDs(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { data?: unknown; models?: unknown };
  const entries = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : Array.isArray(value) ? value : undefined;
  if (!entries) return undefined;
  return [...new Set(entries.flatMap((entry) => {
    if (typeof entry === "string") return entry.trim() ? [entry.trim()] : [];
    if (!entry || typeof entry !== "object") return [];
    const item = entry as { id?: unknown; name?: unknown };
    const id = item.id ?? item.name;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  }))];
}
