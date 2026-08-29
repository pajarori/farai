import { authPath, configPath, loadRawConfig, readAuth, removeAuthEntry, resolveApiKey, writeAuthEntry, writeConfig, type ConfigLocation, type FaraiConfig } from "./config";
import { buildModelCatalog, type ModelCatalog } from "./model-catalog";
import { loadModelProfiles, resolveProfileApiKey } from "./model-profiles";
import { resolveProtocol } from "./provider/registry";

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

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]*$/;
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

export async function listModelProviders(workspace: string, catalog?: ModelCatalog): Promise<ModelProviderInfo[]> {
  const resolvedCatalog = catalog ?? await buildModelCatalog(workspace);
  const profiles = new Map(loadModelProfiles(workspace).map((profile) => [profile.name, profile]));
  const globalProviders = loadRawConfig(configPath("global")).modelProviders ?? {};
  const projectProviders = loadRawConfig(configPath("project", workspace)).modelProviders ?? {};
  const globalAuth = readAuth(authPath("global"));
  const projectAuth = readAuth(authPath("project", workspace));

  return resolvedCatalog.providers.map((provider) => {
    const profile = profiles.get(provider.id);
    const location = provider.id in projectProviders ? "project" : provider.id in globalProviders ? "global" : undefined;
    const stored = Boolean(projectAuth[provider.id]?.apiKey ?? globalAuth[provider.id]?.apiKey);
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
  });
}

export async function probeModelProvider(
  workspace: string,
  input: ProbeModelProviderInput,
  signal?: AbortSignal
): Promise<ModelProviderProbe> {
  const profile = input.providerID
    ? loadModelProfiles(workspace).find((candidate) => candidate.name === input.providerID)
    : undefined;
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? profile?.baseUrl ?? "");
  const configuredProbeProtocol = input.protocol ?? profile?.protocol;
  const resolvedProtocol = resolveProtocol({
    baseUrl,
    ...(configuredProbeProtocol ? { protocol: configuredProbeProtocol } : {})
  });
  const protocol = resolvedProtocol === "anthropic-messages" ? "anthropic-messages" : "openai-chat";
  const apiKey = input.apiKey ?? (profile ? resolveProfileApiKey(profile) : input.providerID ? resolveApiKey(input.providerID, { workspace }) : undefined);
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

export function saveModelProvider(workspace: string, input: SaveModelProviderInput): { id: string; location: ConfigLocation; path: string } {
  const id = normalizeModelProviderID(input.id);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const protocol = configuredProtocol(input.protocol);
  const location = input.location ?? "global";
  const previousConfig = loadRawConfig(configPath(location, workspace));
  const previousAuth = readAuth(authPath(location, workspace))[id];
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
  providers[id] = entry;
  const nextConfig = { ...previousConfig, modelProviders: providers };

  const path = writeConfig(nextConfig, location, workspace);
  try {
    if (input.credentialAction === "replace") {
      const apiKey = input.apiKey?.trim();
      if (!apiKey) throw new Error("api key cannot be empty when replacing a credential.");
      writeAuthEntry(id, { apiKey }, location, workspace);
    }
    if (input.credentialAction === "remove") removeAuthEntry(id, location, workspace);
  } catch (error) {
    writeConfig(previousConfig, location, workspace);
    restoreCredential(id, previousAuth, location, workspace);
    throw error;
  }
  return { id, location, path };
}

export function removeModelProvider(
  workspace: string,
  providerID: string,
  location?: ConfigLocation
): { id: string; location: ConfigLocation; providerRemains: boolean } {
  const id = normalizeModelProviderID(providerID);
  const resolvedLocation = location ?? providerLocation(workspace, id);
  if (!resolvedLocation) throw new Error(`provider ${id} is built in and cannot be removed.`);
  const previousConfigs = {
    global: loadRawConfig(configPath("global")),
    project: loadRawConfig(configPath("project", workspace))
  };
  const previousCredential = readAuth(authPath(resolvedLocation, workspace))[id];
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
    removeAuthEntry(id, resolvedLocation, workspace);
  } catch (error) {
    for (const scope of changedLocations) writeConfig(previousConfigs[scope], scope, workspace);
    restoreCredential(id, previousCredential, resolvedLocation, workspace);
    throw error;
  }
  return { id, location: resolvedLocation, providerRemains };
}

export function normalizeModelProviderID(value: string): string {
  const normalized = value.trim().replace(/\s+/g, "-").toLowerCase();
  if (!PROVIDER_ID.test(normalized)) {
    throw new Error("provider id must start with a letter or number and contain only lowercase letters, numbers, hyphens, or underscores.");
  }
  return normalized;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new Error("provider base url must be a valid http or https url."); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("provider base url must use http or https.");
  if (parsed.username || parsed.password) throw new Error("provider credentials must not be embedded in the base url.");
  return trimmed;
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

function restoreCredential(id: string, previous: { apiKey?: string; token?: string } | undefined, location: ConfigLocation, workspace: string): void {
  if (previous) writeAuthEntry(id, previous, location, workspace);
  else removeAuthEntry(id, location, workspace);
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
