#!/usr/bin/env bun
import { AgentRuntime } from "../agent-core/runtime";
import { KALI_IMAGE_CONTRACT, KaliContainerBackend } from "../agent-container/kali";
import { faraiDockerEnvironment } from "../agent-container/docker-environment";
import { resolveDefaultModel } from "../agent-core/model-registry";
import { buildModelCatalog, resolveDefaultCatalogModel } from "../agent-core/model-catalog";
import { addModelProfile, loadModelProfiles, modelProfilePaths, type ModelProfileLocation } from "../agent-core/model-profiles";
import { ensureDefaultUserConfig, globalConfigPath, loadGlobalConfig } from "../agent-core/global-config";
import { loadConfig, updateConfig } from "../agent-core/config";
import { FARAI_BANNER } from "../branding";
import { FARAI_VERSION } from "../version";
import { resolveSessionLocation } from "../session-catalog";
import {
  parseBenchmarkArguments,
  parseInitArguments,
  parseModelArguments,
  parseNoArguments,
  parseResumeArguments,
  parseRunArguments,
  parseSetupArguments,
  parseUpdateArguments,
  type ModelAddArguments
} from "./command-arguments";
import { readSecretFromStdin } from "./secret-input";

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  if (process.env.FARAI_DEBUG === "1" || process.env.FARAI_DEBUG === "true") {
    if (error instanceof Error && error.stack) console.error(error.stack);
  }
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (command === "--version" || command === "-v" || command === "version") {
    parseNoArguments("version", args);
    console.log(FARAI_VERSION);
    return;
  }
  switch (command) {
    case undefined:
      await launchTui(process.cwd(), undefined);
      break;
    case "help":
    case "-h":
    case "--help":
      if (args.length > 1) throw new Error(`unexpected argument: ${args[1]}`);
      help(args[0]);
      break;
    case "doctor":
      if (wantsHelp(args)) { help("doctor"); break; }
      parseNoArguments("doctor", args);
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
      await launchTui(process.cwd(), parseResumeArguments(args));
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
      parseNoArguments("config", args);
      ensureDefaultUserConfig();
      console.log(globalConfigPath());
      break;
    case "update":
      if (wantsHelp(args)) { help("update"); break; }
      await updateContent(args);
      break;
    default:
      console.error(`unknown command: ${command}`);
      help();
      process.exitCode = 1;
  }
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
  console.log("secrets: system keyring");
  console.log(`config paths: ${modelProfilePaths(process.cwd()).join(", ")}`);
  const backend = new KaliContainerBackend({ workspace: process.cwd() });
  const image = await backend.resolveImage();
  console.log(`kali image: ${backend.image} (${image.exists ? "exists" : "missing"})`);
  console.log(`kali contract: ${image.contract ?? "missing"}`);
  console.log(`kali capabilities: ${image.contract === KALI_IMAGE_CONTRACT ? "ready" : "rebuild required"}`);
  const { contentStatus } = await import("../agent-content/updater");
  const content = contentStatus();
  console.log(`content: ${content.active?.version ?? "local fallback"}`);
  console.log(`setup command: farai setup`);
}

async function setup(args: string[]): Promise<void> {
  const parsed = parseSetupArguments(args);
  ensureDefaultUserConfig();

  console.log(FARAI_BANNER);
  console.log();
  console.log("[*] setting up farai");
  console.log(`[+] config: ${globalConfigPath()}`);
  console.log("[+] secrets: system keyring");

  if (parsed.model) {
    const addArgs = [
      parsed.model,
      ...(parsed.baseUrl ? ["--base-url", parsed.baseUrl] : []),
      ...(parsed.apiKeyEnv ? ["--api-key-env", parsed.apiKeyEnv] : []),
      ...(parsed.apiKeyStdin ? ["--api-key-stdin"] : []),
      "--set-default"
    ];
    await addModel(addArgs);
  }

  if (!parsed.skipDocker) {
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

  if (!parsed.skipKnowledge) {
    const contentInstalled = await syncContentForSetup(process.cwd());
    if (!contentInstalled) {
      console.log("[*] building Farai knowledge base");
      const code = await (await import("../agent-knowledge/command")).runKbCommand(["build", "all"]);
      if (code !== 0) {
        process.exitCode = code;
        console.error("[!] knowledge base build failed");
        return;
      }
    }
  } else {
    console.log("[*] skipping knowledge base build");
  }

  console.log("[+] setup complete");
  console.log("[+] run `farai doctor` to verify the environment");
}

async function syncContentForSetup(workspace: string): Promise<boolean> {
  const { applyContentUpdate, checkContentUpdate, contentStatus } = await import("../agent-content/updater");
  try {
    const status = await checkContentUpdate({ workspace, force: true });
    if (status.state === "update_available" && status.manifest) {
      console.log(`[*] syncing Farai content ${status.manifest.contentVersion}`);
      const applied = await applyContentUpdate(status.manifest, status.manifestUrl);
      const parts = [applied.knowledge ? "knowledge" : undefined, applied.skills ? "skills" : undefined].filter(Boolean).join(" + ");
      console.log(`[+] content: ${applied.version}${parts ? ` (${parts})` : ""}`);
    } else if (status.state === "error") {
      console.error(`[!] content sync unavailable: ${status.error ?? "unknown error"}`);
    }
  } catch (error) {
    console.error(`[!] content sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Boolean(contentStatus().active?.knowledge);
}

async function models(args: string[] = []): Promise<void> {
  const parsed = parseModelArguments(args);
  ensureDefaultUserConfig();
  if (parsed.kind === "add") {
    await addParsedModel(parsed);
    return;
  }
  if (parsed.kind === "path") {
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
  const parsed = parseModelArguments(["add", ...args]);
  if (parsed.kind !== "add") throw new Error("model add requires <provider[/model]>");
  await addParsedModel(parsed);
}

async function addParsedModel(parsed: ModelAddArguments): Promise<void> {
  const apiKey = parsed.apiKeyStdin ? await readSecretFromStdin("--api-key-stdin") : undefined;
  const location: ModelProfileLocation = parsed.project ? "project" : "global";
  const result = await addModelProfile(process.cwd(), {
    name: parsed.provider,
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
    ...(parsed.apiKeyEnv ? { apiKeyEnv: parsed.apiKeyEnv } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(parsed.contextWindow ? { contextWindow: parsed.contextWindow } : {}),
    ...(parsed.maxOutputTokens ? { maxOutputTokens: parsed.maxOutputTokens } : {})
  }, location);

  const selection = parsed.model ? `${parsed.provider}:${parsed.model}` : parsed.provider;
  if (parsed.setDefault) {
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
  const { name, target, model } = parseInitArguments(args);
  ensureDefaultUserConfig();
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
  const { runStartupContentPreflight } = await import("../agent-content/preflight");
  const effectiveWorkspace = sessionId ? resolveSessionLocation(sessionId)?.workspace ?? workspace : workspace;
  if (await runStartupContentPreflight(effectiveWorkspace) === "cancelled") {
    process.exitCode = 130;
    return;
  }
  if (import.meta.path.endsWith(".ts")) {
    const sourceTuiPreload = "@opentui/solid/preload";
    await import(sourceTuiPreload);
  }
  const { launchOpenTui, SessionResolutionError } = await import("../agent-tui");
  try {
    await launchOpenTui(workspace, sessionId);
  } catch (error) {
    if (!(error instanceof SessionResolutionError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}

async function updateContent(args: string[]): Promise<void> {
  const parsed = parseUpdateArguments(args);
  const { runContentUpdateCommand } = await import("../agent-content/command");
  process.exitCode = await runContentUpdateCommand(parsed, process.cwd());
}

async function run(args: string[]): Promise<void> {
  const { sessionId, text, json } = parseRunArguments(args);
  ensureDefaultUserConfig();
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
  const parsed = parseBenchmarkArguments(args);
  if (parsed.kind === "csi-generate") {
    const { generateCsiBenchmarkSuite, loadCsiCampaignConfig, writeCsiBenchmarkSuite } = await import("../agent-benchmark/csi-suite");
    const suite = await generateCsiBenchmarkSuite(await loadCsiCampaignConfig(parsed.configPath), parsed.materialRoot);
    writeCsiBenchmarkSuite(suite, parsed.output);
    console.log(JSON.stringify({ output: parsed.output, challenges: suite.runs.length, repetitions: suite.repetitions, runs: suite.runs.length * suite.repetitions }, null, 2));
    return;
  }
  if (parsed.kind === "run") {
    const { loadBenchmarkManifest, runBenchmark, writeBenchmarkResult } = await import("../agent-benchmark/runner");
    const result = await runBenchmark(await loadBenchmarkManifest(parsed.manifestPath), {
      ...(parsed.workspace ? { workspace: parsed.workspace } : {}),
      ...(parsed.artifactsDir ? { artifactsDir: parsed.artifactsDir } : {})
    });
    if (parsed.output) writeBenchmarkResult(result, parsed.output);
    console.log(JSON.stringify(result, null, 2));
    if (!result.solved) process.exitCode = 2;
    return;
  }
  if (parsed.kind === "suite") {
    const { loadBenchmarkSuiteManifest, runBenchmarkSuite } = await import("../agent-benchmark/suite");
    const result = await runBenchmarkSuite(await loadBenchmarkSuiteManifest(parsed.manifestPath), { ...(parsed.artifactsDir ? { artifactsDir: parsed.artifactsDir } : {}) });
    console.log(JSON.stringify(result, null, 2));
    if (result.solvedChallenges === 0) process.exitCode = 2;
    return;
  }
}

async function buildContainer(): Promise<number> {
  const backend = new KaliContainerBackend({ workspace: process.cwd() });
  console.log(backend.buildImageCommand().join(" "));
  const proc = Bun.spawn(backend.buildImageCommand(), { stdout: "inherit", stderr: "inherit", env: faraiDockerEnvironment() });
  const code = await proc.exited;
  process.exitCode = code;
  return code;
}

function wantsHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h") || args[0] === "help";
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
  --api-key-stdin               Read the API key from stdin
  --no-docker                   Skip Farai Kali image build
  --no-kb, --no-knowledge       Skip local knowledge base build

Examples:
  farai setup
  farai setup --model openai:gpt-5 --base-url https://api.openai.com/v1 --api-key-env OPENAI_API_KEY
  printenv OPENAI_API_KEY | farai setup --model openai:gpt-5 --base-url https://api.openai.com/v1 --api-key-stdin
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
  --api-key-stdin               Read the API key from stdin
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
  farai config`,
    update: `Farai update

Usage:
  farai update status
  farai update check
  farai update apply
  farai update rollback`
  };
  if (topic && !pages[topic]) throw new Error(`unknown help topic: ${topic}`);
  console.log((topic ? pages[topic] : undefined) ?? `Farai

Usage:
  farai
  farai resume [session-name-or-id]
  farai run <prompt> [--session <id>] [--json]
  farai setup [--model provider:model] [--base-url url] [--api-key-env ENV | --api-key-stdin] [--no-docker] [--no-kb]
  farai init [--target <ip-or-host>] [--name <name>] [--model provider:model]
  farai doctor
  farai model
  farai model add <provider[/model]> --base-url <url> [--api-key-env ENV] [--set-default] [--project]
  farai bench run <manifest.json> [--output result.json] [--workspace scratch-dir] [--artifacts dir]
  farai bench suite <suite.json> [--artifacts dir]
  farai config
  farai update [status|check|apply|rollback]

settings live in ~/.local/pajarori/farai/config.toml; credentials use the system keyring.

Examples:
  farai
  farai setup --model openai:gpt-5 --base-url https://api.openai.com/v1 --api-key-env OPENAI_API_KEY
  farai run "scan the target"
  farai resume "session name"
  farai init --name htb-box --target 10.10.10.10
  farai model add openai/gpt-5 --base-url https://api.openai.com/v1 --api-key-env OPENAI_API_KEY
`);
}
