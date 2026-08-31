import { parseArgs } from "node:util";
import {
  normalizeEnvironmentVariableName,
  normalizeModelProviderBaseUrl,
  normalizeModelProviderID
} from "../agent-core/model-provider-validation";

type OptionDefinition = {
  type: "string" | "boolean";
  short?: string;
};

type ParsedValues = Record<string, string | boolean | undefined>;

type ParsedArguments = {
  values: ParsedValues;
  positionals: string[];
};

export type SetupArguments = {
  skipDocker: boolean;
  skipKnowledge: boolean;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKeyStdin: boolean;
};

export type ModelAddArguments = {
  provider: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKeyStdin: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  setDefault: boolean;
  project: boolean;
};

export type ModelArguments =
  | { kind: "list" }
  | { kind: "path" }
  | ({ kind: "add" } & ModelAddArguments);

export type InitArguments = {
  name: string;
  target?: string;
  model?: string;
};

export type RunArguments = {
  sessionId?: string;
  text: string;
  json: boolean;
};

export type BenchmarkArguments =
  | { kind: "csi-generate"; configPath: string; materialRoot: string; output: string }
  | { kind: "run"; manifestPath: string; output?: string; workspace?: string; artifactsDir?: string }
  | { kind: "suite"; manifestPath: string; artifactsDir?: string };

export function parseNoArguments(command: string, args: string[]): void {
  if (args.length > 0) throw new Error(`${command} does not accept arguments`);
}

export function parseSetupArguments(args: string[]): SetupArguments {
  const { values, positionals } = parseStrict(args, {
    model: { type: "string" },
    "base-url": { type: "string" },
    baseURL: { type: "string" },
    "api-key-env": { type: "string" },
    "api-key": { type: "string" },
    "api-key-stdin": { type: "boolean" },
    "no-docker": { type: "boolean" },
    "no-kb": { type: "boolean" },
    "no-knowledge": { type: "boolean" }
  });
  requirePositionals("setup", positionals, 0, 0);
  rejectInlineApiKey(values);
  const configuredBaseUrl = aliasedString(values, "base-url", "baseURL");
  const configuredApiKeyEnv = optionalString(values, "api-key-env");
  const baseUrl = configuredBaseUrl === undefined ? undefined : normalizeModelProviderBaseUrl(configuredBaseUrl);
  const apiKeyEnv = configuredApiKeyEnv === undefined ? undefined : normalizeEnvironmentVariableName(configuredApiKeyEnv);
  const apiKeyStdin = optionalBoolean(values, "api-key-stdin");
  const model = optionalString(values, "model");
  if (apiKeyEnv && apiKeyStdin) throw new Error("choose one api key source: --api-key-env or --api-key-stdin");
  if (!model && (baseUrl || apiKeyEnv || apiKeyStdin)) throw new Error("--base-url and api key options require --model");
  return {
    skipDocker: optionalBoolean(values, "no-docker"),
    skipKnowledge: aliasedBoolean(values, "no-kb", "no-knowledge"),
    ...optionalProperty("model", model),
    ...optionalProperty("baseUrl", baseUrl),
    ...optionalProperty("apiKeyEnv", apiKeyEnv),
    apiKeyStdin
  };
}

export function parseModelArguments(args: string[]): ModelArguments {
  const subcommand = args[0];
  if (!subcommand) return { kind: "list" };
  if (subcommand === "path") {
    parseNoArguments("model path", args.slice(1));
    return { kind: "path" };
  }
  if (subcommand !== "add") throw new Error(`unknown model command: ${subcommand}`);
  return { kind: "add", ...parseModelAddArguments(args.slice(1)) };
}

export function parseModelAddArguments(args: string[]): ModelAddArguments {
  const { values, positionals } = parseStrict(args, {
    "base-url": { type: "string" },
    baseURL: { type: "string" },
    "api-key-env": { type: "string" },
    "api-key": { type: "string" },
    "api-key-stdin": { type: "boolean" },
    "context-window": { type: "string" },
    "max-output-tokens": { type: "string" },
    "set-default": { type: "boolean" },
    default: { type: "boolean" },
    project: { type: "boolean" }
  });
  requirePositionals("model add", positionals, 1, 1, "model add requires <provider[/model]>");
  rejectInlineApiKey(values);
  const configuredApiKeyEnv = optionalString(values, "api-key-env");
  const apiKeyEnv = configuredApiKeyEnv === undefined ? undefined : normalizeEnvironmentVariableName(configuredApiKeyEnv);
  const apiKeyStdin = optionalBoolean(values, "api-key-stdin");
  if (apiKeyEnv && apiKeyStdin) throw new Error("choose one api key source: --api-key-env or --api-key-stdin");
  const setDefault = aliasedBoolean(values, "set-default", "default");
  const parsed = parseProviderModel(positionals[0]!);
  return {
    ...parsed,
    ...optionalProperty("baseUrl", normalizedBaseUrl(values)),
    ...optionalProperty("apiKeyEnv", apiKeyEnv),
    apiKeyStdin,
    ...optionalProperty("contextWindow", positiveInteger(values, "context-window")),
    ...optionalProperty("maxOutputTokens", positiveInteger(values, "max-output-tokens")),
    setDefault,
    project: optionalBoolean(values, "project")
  };
}

export function parseInitArguments(args: string[]): InitArguments {
  const { values, positionals } = parseStrict(args, {
    name: { type: "string" },
    target: { type: "string" },
    model: { type: "string" }
  });
  requirePositionals("init", positionals, 0, 0);
  return {
    name: optionalString(values, "name") ?? "lab",
    ...optionalProperty("target", optionalString(values, "target")),
    ...optionalProperty("model", optionalString(values, "model"))
  };
}

export function parseResumeArguments(args: string[]): string | undefined {
  const { values, positionals } = parseStrict(args, { session: { type: "string" } });
  requirePositionals("resume", positionals, 0, 1);
  const positional = positionals[0];
  const option = optionalString(values, "session");
  if (positional && option) throw new Error("resume accepts a session as either a positional argument or --session, not both");
  return positional ?? option;
}

export function parseRunArguments(args: string[]): RunArguments {
  const { values, positionals } = parseStrict(args, {
    session: { type: "string" },
    text: { type: "string" },
    json: { type: "boolean" }
  });
  const flaggedText = optionalString(values, "text");
  if (flaggedText !== undefined && positionals.length > 0) throw new Error("run accepts prompt text as either positional arguments or --text, not both");
  const text = flaggedText ?? positionals.join(" ");
  if (!text.trim()) throw new Error("run requires text");
  return {
    ...optionalProperty("sessionId", optionalString(values, "session")),
    text,
    json: optionalBoolean(values, "json")
  };
}

export function parseBenchmarkArguments(args: string[]): BenchmarkArguments {
  const subcommand = args[0] ?? "run";
  if (subcommand === "csi") {
    if (args[1] !== "generate") throw new Error(`unknown bench command: ${args.slice(0, 2).join(" ").trim() || "csi"}`);
    const { values, positionals } = parseStrict(args.slice(2), {
      config: { type: "string" },
      materials: { type: "string" },
      output: { type: "string" }
    });
    requirePositionals("bench csi generate", positionals, 0, 1);
    const configPath = positionalOrOption("bench csi generate", positionals[0], optionalString(values, "config"), "--config");
    const materialRoot = optionalString(values, "materials");
    const output = optionalString(values, "output");
    if (!configPath) throw new Error("bench csi generate requires a campaign config json path");
    if (!materialRoot) throw new Error("bench csi generate requires --materials <protected-dir>");
    if (!output) throw new Error("bench csi generate requires --output <suite.json>");
    return { kind: "csi-generate", configPath, materialRoot, output };
  }
  if (subcommand === "run") {
    const { values, positionals } = parseStrict(args.slice(1), {
      manifest: { type: "string" },
      output: { type: "string" },
      workspace: { type: "string" },
      artifacts: { type: "string" }
    });
    requirePositionals("bench run", positionals, 0, 1);
    const manifestPath = positionalOrOption("bench run", positionals[0], optionalString(values, "manifest"), "--manifest");
    if (!manifestPath) throw new Error("bench run requires a manifest json path");
    return {
      kind: "run",
      manifestPath,
      ...optionalProperty("output", optionalString(values, "output")),
      ...optionalProperty("workspace", optionalString(values, "workspace")),
      ...optionalProperty("artifactsDir", optionalString(values, "artifacts"))
    };
  }
  if (subcommand === "suite") {
    const { values, positionals } = parseStrict(args.slice(1), {
      manifest: { type: "string" },
      artifacts: { type: "string" }
    });
    requirePositionals("bench suite", positionals, 0, 1);
    const manifestPath = positionalOrOption("bench suite", positionals[0], optionalString(values, "manifest"), "--manifest");
    if (!manifestPath) throw new Error("bench suite requires a suite manifest json path");
    return {
      kind: "suite",
      manifestPath,
      ...optionalProperty("artifactsDir", optionalString(values, "artifacts"))
    };
  }
  throw new Error(`unknown bench command: ${subcommand}`);
}

function parseStrict(args: string[], options: Record<string, OptionDefinition>): ParsedArguments {
  try {
    const parsed = parseArgs({ args, options, strict: true, allowPositionals: true, tokens: true });
    const seen = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== "option") continue;
      if (seen.has(token.name)) throw new Error(`option may only be specified once: --${token.name}`);
      seen.add(token.name);
    }
    return { values: parsed.values as ParsedValues, positionals: parsed.positionals };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new Error(lowercaseFirst(error.message));
  }
}

function requirePositionals(command: string, positionals: string[], minimum: number, maximum: number, missingMessage?: string): void {
  if (positionals.length < minimum) throw new Error(missingMessage ?? `${command} requires an argument`);
  if (positionals.length > maximum) throw new Error(`unexpected argument: ${positionals[maximum]}`);
}

function positionalOrOption(command: string, positional: string | undefined, option: string | undefined, optionName: string): string | undefined {
  if (positional && option) throw new Error(`${command} accepts its input as either a positional argument or ${optionName}, not both`);
  return positional ?? option;
}

function optionalString(values: ParsedValues, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(values: ParsedValues, name: string): boolean {
  return values[name] === true;
}

function aliasedString(values: ParsedValues, primary: string, alias: string): string | undefined {
  const primaryValue = optionalString(values, primary);
  const aliasValue = optionalString(values, alias);
  if (primaryValue !== undefined && aliasValue !== undefined) throw new Error(`use --${primary} only; --${alias} is an alias`);
  return primaryValue ?? aliasValue;
}

function aliasedBoolean(values: ParsedValues, primary: string, alias: string): boolean {
  const primaryValue = optionalBoolean(values, primary);
  const aliasValue = optionalBoolean(values, alias);
  if (primaryValue && aliasValue) throw new Error(`use --${primary} only; --${alias} is an alias`);
  return primaryValue || aliasValue;
}

function positiveInteger(values: ParsedValues, name: string): number | undefined {
  const value = optionalString(values, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function rejectInlineApiKey(values: ParsedValues): void {
  if (optionalString(values, "api-key") !== undefined) {
    throw new Error("--api-key is not supported because command arguments can leak through shell history and process listings; pipe the key with --api-key-stdin");
  }
}

function parseProviderModel(value: string): { provider: string; model?: string } {
  const normalized = value.trim();
  if (!normalized) throw new Error("model add requires <provider[/model]>");
  const slash = normalized.indexOf("/");
  const colon = normalized.indexOf(":");
  const separators = [slash, colon].filter((index) => index > 0);
  const separator = separators.length > 0 ? Math.min(...separators) : -1;
  if (separator === -1) return { provider: normalizeModelProviderID(normalized) };
  const provider = normalizeModelProviderID(normalized.slice(0, separator));
  const model = normalized.slice(separator + 1).trim();
  if (!provider || !model) throw new Error("model must be <provider>/<model> or <provider>:<model>");
  return { provider, model };
}

function normalizedBaseUrl(values: ParsedValues): string | undefined {
  const value = aliasedString(values, "base-url", "baseURL");
  return value === undefined ? undefined : normalizeModelProviderBaseUrl(value);
}

function optionalProperty<Key extends string, Value>(key: Key, value: Value | undefined): { [Property in Key]?: Value } {
  return value === undefined ? {} : { [key]: value } as { [Property in Key]?: Value };
}

function lowercaseFirst(value: string): string {
  return value ? value[0]!.toLowerCase() + value.slice(1) : value;
}
