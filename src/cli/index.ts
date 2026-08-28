#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRuntime } from "../agent-core/runtime";
import { KALI_IMAGE_CONTRACT, KaliContainerBackend } from "../agent-container/kali";
import { resolveDefaultModel } from "../agent-core/model-registry";
import { buildModelCatalog, resolveDefaultCatalogModel } from "../agent-core/model-catalog";
import { addModelProfile, loadModelProfiles, modelProfilePaths, type ModelProfileLocation } from "../agent-core/model-profiles";
import { ensureDefaultUserConfig, globalConfigPath, loadGlobalConfig } from "../agent-core/global-config";
import { authPath, loadConfig, updateConfig } from "../agent-core/config";

const [, , command, ...args] = process.argv;

if (command === "--version" || command === "-v" || command === "version") {
  console.log(packageVersion());
  process.exit(0);
}

switch (command) {
  case undefined:
    await launchTui(process.cwd(), undefined);
    break;
  case "help":
  case "-h":
  case "--help":
    help(args[0]);
    break;
  case "doctor":
    if (wantsHelp(args)) { help("doctor"); break; }
    await doctor();
    break;
  case "setup":
    if (wantsHelp(args)) { help("setup"); break; }
    await setup(args);
    break;
  case "init":
  case "init-lab":
    if (wantsHelp(args)) { help("init"); break; }
    await initLab(args);
    break;
  case "resume":
    if (wantsHelp(args)) { help("resume"); break; }
    await launchTui(process.cwd(), args[0] && !args[0].startsWith("-") ? args[0] : flag(args, "--session"));
    break;
  case "run":
    if (wantsHelp(args)) { help("run"); break; }
    await run(args);
    break;
  case "bench":
    if (wantsHelp(args)) { help("bench"); break; }
    await benchmark(args);
    break;
  case "model":
    if (wantsHelp(args)) { help("model"); break; }
    await models(args);
    break;
  case "config":
    if (wantsHelp(args)) { help("config"); break; }
    ensureDefaultUserConfig();
    console.log(globalConfigPath());
    console.log(authPath("global"));
    break;
  default:
    console.error(`Unknown command: ${command}`);
    help();
    process.exitCode = 1;
}

async function doctor(): Promise<void> {
  ensureDefaultUserConfig();
  console.log("Farai doctor");
  console.log(`cwd: ${process.cwd()}`);
  console.log(`bun: ${Bun.version}`);
  const configured = resolveDefaultModel();
  const resolved = await resolveDefaultCatalogModel(process.cwd()).catch(() => undefined);
  console.log(`model: ${resolved?.model ?? configured.model ?? "auto"}`);
  console.log(`base url: ${resolved?.baseUrl ?? configured.baseUrl}`);
  const profiles = loadModelProfiles(process.cwd());
  const config = loadConfig(process.cwd());
  console.log(`model providers: ${profiles.length ? profiles.map((p) => p.name).join(", ") : "none"}`);
  console.log(`mcp servers: ${Object.keys(config.mcpServers ?? {}).join(", ") || "none"}`);
  console.log(`config: ${globalConfigPath()}`);
  console.log(`auth: ${authPath("global")}`);
  console.log(`config paths: ${modelProfilePaths(process.cwd()).join(", ")}`);
  const backend = new KaliContainerBackend({ workspace: process.cwd() });
  const image = await backend.resolveImage();
  console.log(`kali image: ${backend.image} (${image.exists ? "exists" : "missing"})`);
  console.log(`kali contract: ${image.contract ?? "missing"}`);
  console.log(`kali capabilities: ${image.contract === KALI_IMAGE_CONTRACT ? "ready" : "rebuild required"}`);
  console.log(`setup command: farai setup`);
}

async function setup(args: string[]): Promise<void> {
  ensureDefaultUserConfig();
  const skipDocker = args.includes("--no-docker");
  const skipKb = args.includes("--no-kb") || args.includes("--no-knowledge");
  const model = flag(args, "--model");
  const baseUrl = flag(args, "--base-url") ?? flag(args, "--baseURL");
  const apiKeyEnv = flag(args, "--api-key-env");
  const setDefault = args.includes("--set-default") || args.includes("--default") || Boolean(model);

  console.log("[*] setting up Farai");
  console.log(`[+] config: ${globalConfigPath()}`);
  console.log(`[+] auth: ${authPath("global")}`);

  if (model) {
    const addArgs = [
      model,
      ...(baseUrl ? ["--base-url", baseUrl] : []),
      ...(apiKeyEnv ? ["--api-key-env", apiKeyEnv] : []),
      ...(setDefault ? ["--set-default"] : [])
    ];
    await addModel(addArgs);
  }

  if (!skipDocker) {
    console.log("[*] building Farai Kali image");
    const code = await buildContainer();
    if (code !== 0) {
      process.exitCode = code;
      console.error("[!] docker image build failed; rerun `farai setup --no-kb` after fixing Docker");
      return;
    }
  } else {
    console.log("[*] skipping Docker image build");
  }

  if (!skipKb) {
    console.log("[*] building Farai knowledge base");
    const code = await (await import("../agent-knowledge/command")).runKbCommand(["build", "all"]);
    if (code !== 0) {
      process.exitCode = code;
      console.error("[!] knowledge base build failed");
      return;
    }
  } else {
    console.log("[*] skipping knowledge base build");
  }

  console.log("[+] setup complete");
  console.log("[+] run `farai doctor` to verify the environment");
}

async function models(args: string[] = []): Promise<void> {
  ensureDefaultUserConfig();
  if (args[0] === "add") {
    await addModel(args.slice(1));
    return;
  }
  if (args[0] === "path") {
    console.log(modelProfilePaths(process.cwd()).join("\n"));
    return;
  }
  const catalog = await buildModelCatalog(process.cwd());
  console.log(`profile paths: ${modelProfilePaths(process.cwd()).join(", ")}`);
  if (!catalog.models.length) {
    console.log(`No models discovered. Add a provider in ${globalConfigPath()} or run 'farai model add'.`);
    return;
  }
  for (const provider of catalog.providers) {
    const source = provider.source === "models.dev" ? " (models.dev)" : "";
    const auth = provider.apiKeyEnv && !provider.apiKey && !process.env[provider.apiKeyEnv] && provider.source !== "models.dev"
      ? ` (missing ${provider.apiKeyEnv})`
      : "";
    console.log(`${provider.id}: ${provider.models.length} models @ ${provider.baseUrl}${source}${auth}`);
  }
  for (const choice of catalog.models) {
    const marker = choice.free ? "free" : choice.verified ? "ready" : choice.checked ? "missing" : "unchecked";
    console.log(`  ${choice.model}\t${marker}\t${choice.baseUrl}`);
  }
}

async function addModel(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("-"));
  if (!id) throw new Error("model add requires <provider[/model]>.");
  const parsed = parseProviderModel(id);
  const baseUrl = flag(args, "--base-url") ?? flag(args, "--baseURL");
  const apiKeyEnv = flag(args, "--api-key-env");
  const apiKey = flag(args, "--api-key");
  const contextWindow = numberFlag(args, "--context-window");
  const maxOutputTokens = numberFlag(args, "--max-output-tokens");
  const location: ModelProfileLocation = args.includes("--project") ? "project" : "global";
  const result = addModelProfile(process.cwd(), {
    name: parsed.provider,
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {})
  }, location);

  const selection = parsed.model ? `${parsed.provider}:${parsed.model}` : parsed.provider;
  if (args.includes("--set-default") || args.includes("--default")) {
    if (!parsed.model) throw new Error("--set-default requires <provider/model>.");
    updateConfig((config) => ({ ...config, model: selection }));
  }

  console.log(`added model provider: ${result.profile.name}`);
  if (parsed.model) console.log(`model: ${selection}`);
  if (result.profile.baseUrl) console.log(`base url: ${result.profile.baseUrl}`);
  if (result.profile.apiKeyEnv) console.log(`api key env: ${result.profile.apiKeyEnv}`);
  console.log(`config: ${result.path}`);
}

async function initLab(args: string[]): Promise<void> {
  ensureDefaultUserConfig();
  const name = flag(args, "--name") ?? "lab";
  const target = flag(args, "--target");
  const model = flag(args, "--model");
  const runtime = new AgentRuntime(process.cwd());
  try {
    const session = await runtime.createSession({ ...(model ? { model } : {}), title: target ? `${name}: ${target}` : name });
    console.log(`created session ${session.title}`);
    if (target) console.log(`target hint: ${target}`);
    console.log(`model: ${model ?? loadGlobalConfig().model ?? "default"}`);
  } finally {
    await runtime.shutdown();
  }
}

async function launchTui(workspace: string, sessionId: string | undefined): Promise<void> {
  ensureDefaultUserConfig();
  await import("@opentui/solid/preload");
  const { launchOpenTui, SessionResolutionError } = await import("../agent-tui");
  try {
    await launchOpenTui(workspace, sessionId);
  } catch (error) {
    if (!(error instanceof SessionResolutionError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}

async function run(args: string[]): Promise<void> {
  ensureDefaultUserConfig();
  const sessionId = flag(args, "--session");
  const text = flag(args, "--text") ?? args.filter((arg) => arg !== "--json").join(" ");
  const json = args.includes("--json");
  if (!text) throw new Error("run requires text");
  const runtime = new AgentRuntime(process.cwd());
  try {
    const session = sessionId
      ? runtime.loadSession(sessionId)
      : await runtime.createSession();
    const result = await runtime.prompt(session, text);
    if (json) {
      for (const event of result.events) console.log(JSON.stringify(event));
      console.log(JSON.stringify({ type: "final", sessionId: session.id, response: result.response }));
    } else {
      console.log(result.response);
    }
  } finally {
    await runtime.shutdown();
  }
}

async function benchmark(args: string[]): Promise<void> {
  const subcommand = args[0] ?? "run";
  if (subcommand === "csi" && args[1] === "generate") {
    const configPath = args[2] && !args[2].startsWith("-") ? args[2] : flag(args, "--config");
    const materialRoot = flag(args, "--materials");
    const output = flag(args, "--output");
    if (!configPath) throw new Error("bench csi generate requires a campaign config json path");
    if (!materialRoot) throw new Error("bench csi generate requires --materials <protected-dir>");
    if (!output) throw new Error("bench csi generate requires --output <suite.json>");
    const { generateCsiBenchmarkSuite, loadCsiCampaignConfig, writeCsiBenchmarkSuite } = await import("../agent-benchmark/csi-suite");
    const suite = await generateCsiBenchmarkSuite(await loadCsiCampaignConfig(configPath), materialRoot);
    writeCsiBenchmarkSuite(suite, output);
    console.log(JSON.stringify({ output, challenges: suite.runs.length, repetitions: suite.repetitions, runs: suite.runs.length * suite.repetitions }, null, 2));
    return;
  }
  if (subcommand === "run") {
    const manifestPath = args[1] && !args[1].startsWith("-") ? args[1] : flag(args, "--manifest");
    if (!manifestPath) throw new Error("bench run requires a manifest json path");
    const output = flag(args, "--output");
    const workspace = flag(args, "--workspace");
    const artifactsDir = flag(args, "--artifacts");
    const { loadBenchmarkManifest, runBenchmark, writeBenchmarkResult } = await import("../agent-benchmark/runner");
    const result = await runBenchmark(await loadBenchmarkManifest(manifestPath), {
      ...(workspace ? { workspace } : {}),
      ...(artifactsDir ? { artifactsDir } : {})
    });
    if (output) writeBenchmarkResult(result, output);
    console.log(JSON.stringify(result, null, 2));
    if (!result.solved) process.exitCode = 2;
    return;
  }
  if (subcommand === "suite") {
    const manifestPath = args[1] && !args[1].startsWith("-") ? args[1] : flag(args, "--manifest");
    if (!manifestPath) throw new Error("bench suite requires a suite manifest json path");
    const artifactsDir = flag(args, "--artifacts");
    const { loadBenchmarkSuiteManifest, runBenchmarkSuite } = await import("../agent-benchmark/suite");
    const result = await runBenchmarkSuite(await loadBenchmarkSuiteManifest(manifestPath), { ...(artifactsDir ? { artifactsDir } : {}) });
    console.log(JSON.stringify(result, null, 2));
    if (result.solvedChallenges === 0) process.exitCode = 2;
    return;
  }
  throw new Error(`unknown bench command: ${subcommand}`);
}

async function buildContainer(): Promise<number> {
  const backend = new KaliContainerBackend({ workspace: process.cwd() });
  console.log(backend.buildImageCommand().join(" "));
  const proc = Bun.spawn(backend.buildImageCommand(), { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  process.exitCode = code;
  return code;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function numberFlag(args: string[], name: string): number | undefined {
  const value = flag(args, name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function wantsHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h") || args[0] === "help";
}

function parseProviderModel(value: string): { provider: string; model?: string } {
  const slash = value.indexOf("/");
  const colon = value.indexOf(":");
  const separator = slash > 0 ? slash : colon > 0 ? colon : -1;
  if (separator === -1) return { provider: value.trim().toLowerCase() };
  const provider = value.slice(0, separator).trim().toLowerCase();
  const model = value.slice(separator + 1).trim();
  if (!provider || !model) throw new Error("Model must be <provider>/<model> or <provider>:<model>.");
  return { provider, model };
}

function packageVersion(): string {
  try {
    const raw = readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function help(topic?: string): void {
  const pages: Record<string, string> = {
    setup: `Farai setup

Usage:
  farai setup [options]

Options:
  --model <provider:model>      Add and set the default model
  --base-url <url>              OpenAI-compatible provider URL
  --api-key-env <ENV>           Environment variable containing the API key
  --no-docker                   Skip Farai Kali image build
  --no-kb, --no-knowledge       Skip local knowledge base build

Examples:
  farai setup
  farai setup --model openai:gpt-5 --base-url https://api.openai.com/v1 --api-key-env OPENAI_API_KEY
  farai setup --no-kb`,
    run: `Farai run

Usage:
  farai run <prompt> [--session <id>] [--json]
  farai run --text <prompt> [--json]

Options:
  --session <id>                Reuse an existing session
  --json                        Emit JSON events and final response
  --text <prompt>               Pass prompt as a flag value`,
    resume: `Farai resume

Usage:
  farai resume <session-name-or-id>
  farai resume --session <session-name-or-id>`,
    init: `Farai init

Usage:
  farai init [--name <name>] [--target <ip-or-host>] [--model <provider:model>]`,
    doctor: `Farai doctor

Usage:
  farai doctor`,
    model: `Farai model

Usage:
  farai model
  farai model add <provider[/model]> --base-url <url> [options]
  farai model path

Options for model add:
  --base-url <url>
  --api-key-env <ENV>
  --api-key <key>
  --context-window <tokens>
  --max-output-tokens <tokens>
  --set-default
  --project`,
    bench: `Farai bench

Usage:
  farai bench run <manifest.json> [--output result.json] [--workspace scratch-dir] [--artifacts dir]
  farai bench suite <suite.json> [--artifacts dir]
  farai bench csi generate <campaign.json> --materials <dir> --output <suite.json>`,
    config: `Farai config

Usage:
  farai config`
  };
  console.log(pages[topic ?? ""] ?? `Farai

Usage:
  farai
  farai resume [session-name-or-id]
  farai run <prompt> [--session <id>] [--json]
  farai setup [--model provider:model] [--base-url url] [--api-key-env ENV] [--no-docker] [--no-kb]
  farai init [--target <ip-or-host>] [--name <name>] [--model provider:model]
  farai doctor
  farai model
  farai model add <provider[/model]> --base-url <url> [--api-key-env ENV] [--set-default] [--project]
  farai bench run <manifest.json> [--output result.json] [--workspace scratch-dir] [--artifacts dir]
  farai bench suite <suite.json> [--artifacts dir]
  farai config

All settings live in ~/.local/pajarori/farai/config.toml; API keys in auth.json.

Examples:
  farai
  farai setup --model openai:gpt-5 --base-url https://api.openai.com/v1 --api-key-env OPENAI_API_KEY
  farai run "scan the target"
  farai resume "session name"
  farai init --name htb-box --target 10.10.10.10
  farai model add openai/gpt-5 --base-url https://api.openai.com/v1 --api-key-env OPENAI_API_KEY
`);
}
