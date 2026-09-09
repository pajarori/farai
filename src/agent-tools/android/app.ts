import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { adbPrefix, adbUnavailable, compactError, resolveDevice, runAdb, shellQuote } from "./shared";

const SERIAL_PROP = { type: "string", description: "device serial from android_devices; omit when exactly one device is connected" };

function sanitizePackage(value: string): string {
  const clean = value.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(clean)) throw new Error("package must be a valid android package name");
  return clean;
}

export const androidApkPullTool: ToolDefinition = {
  name: "android_apk_pull",
  description: "Pull every apk for an installed package (including split apks) from the device into the workspace for static analysis. Returns the local directory and file list.",
  inputSchema: {
    type: "object",
    required: ["package"],
    properties: {
      package: { type: "string", description: "installed package name, e.g. com.example.app" },
      serial: SERIAL_PROP
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 120_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const pkg = sanitizePackage(asString(args.package, "package"));
    const serial = await resolveDevice(context, typeof args.serial === "string" ? args.serial : undefined);
    const pathResult = await runAdb(context, `${adbPrefix(serial)} shell pm path ${shellQuote(pkg)}`, 30_000);
    if (adbUnavailable(pathResult)) throw new Error("adb is not available in the container");
    const remotes = pathResult.stdout.split("\n").map((line) => line.replace(/^package:/, "").trim()).filter(Boolean);
    if (remotes.length === 0) throw new Error(`package not found on device: ${pkg}`);
    const destDir = `android/${pkg}`;
    await runAdb(context, `mkdir -p ${shellQuote(destDir)}`, 10_000);
    const pulled: string[] = [];
    const errors: string[] = [];
    for (const remote of remotes) {
      const local = `${destDir}/${remote.split("/").pop() || "base.apk"}`;
      const result = await runAdb(context, `${adbPrefix(serial)} pull ${shellQuote(remote)} ${shellQuote(local)}`, 90_000);
      if (result.exitCode === 0) pulled.push(local);
      else errors.push(`${remote}: ${compactError(result.stderr || result.stdout)}`);
    }
    return {
      ok: pulled.length > 0,
      summary: pulled.length ? `pulled ${pulled.length} apk(s) for ${pkg} to ${destDir}` : `failed to pull apks for ${pkg}`,
      output: [...pulled.map((path) => `pulled: ${path}`), ...errors.map((err) => `error: ${err}`)].join("\n"),
      metadata: { serial, package: pkg, directory: destDir, files: pulled }
    };
  }
};

export const androidInstallTool: ToolDefinition = {
  name: "android_install",
  description: "Install an apk on the device with adb install -r. Use for patched or instrumentation builds; the path is a workspace-relative apk file.",
  inputSchema: {
    type: "object",
    required: ["apkPath"],
    properties: {
      apkPath: { type: "string", description: "workspace-relative path to the apk file to install" },
      serial: SERIAL_PROP
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 120_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const apkPath = asString(args.apkPath, "apkPath").trim();
    const serial = await resolveDevice(context, typeof args.serial === "string" ? args.serial : undefined);
    const result = await runAdb(context, `${adbPrefix(serial)} install -r ${shellQuote(apkPath)}`, 120_000);
    if (adbUnavailable(result)) throw new Error("adb is not available in the container");
    const text = `${result.stdout}${result.stderr}`.trim();
    const ok = /success/i.test(text);
    return {
      ok,
      summary: ok ? `installed ${apkPath} on ${serial}` : `install failed for ${apkPath}`,
      output: text || `exit ${result.exitCode}`,
      metadata: { serial, apkPath, installed: ok }
    };
  }
};

function appLifecycleTool(name: string, verb: "start" | "stop"): ToolDefinition {
  return {
    name,
    description: verb === "start"
      ? "Launch an app by package name using monkey so the default launcher activity starts. Use before ui or dynamic tools that need the app running."
      : "Force-stop an app by package name. Use to reset app state between tests.",
    inputSchema: {
      type: "object",
      required: ["package"],
      properties: {
        package: { type: "string", description: "installed package name to control" },
        serial: SERIAL_PROP
      },
      additionalProperties: false
    },
    mutates: true,
    timeoutMs: 30_000,
    parallel: false,
    renderHuman: defaultHumanRenderer,
    renderModel: defaultModelRenderer,
    run: async (args, context) => {
      assertObject(args, "args");
      const pkg = sanitizePackage(asString(args.package, "package"));
      const serial = await resolveDevice(context, typeof args.serial === "string" ? args.serial : undefined);
      const shell = verb === "start"
        ? `monkey -p ${shellQuote(pkg)} -c android.intent.category.LAUNCHER 1`
        : `am force-stop ${shellQuote(pkg)}`;
      const result = await runAdb(context, `${adbPrefix(serial)} shell ${shellQuote(shell)}`, 30_000);
      if (adbUnavailable(result)) throw new Error("adb is not available in the container");
      const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
      const ok = result.exitCode === 0 && !/error|no activities found/i.test(output);
      return {
        ok,
        summary: ok ? `${verb === "start" ? "started" : "stopped"} ${pkg}` : `could not ${verb} ${pkg}`,
        output: output || "(no output)",
        metadata: { serial, package: pkg }
      };
    }
  };
}

export const androidAppStartTool = appLifecycleTool("android_app_start", "start");
export const androidAppStopTool = appLifecycleTool("android_app_stop", "stop");

export const androidDeeplinkTool: ToolDefinition = {
  name: "android_deeplink",
  description: "Fire a deep-link intent (VIEW) on the device to test deep-link and exported-component handling. Optionally scope it to a package to target one app.",
  inputSchema: {
    type: "object",
    required: ["uri"],
    properties: {
      uri: { type: "string", description: "deep link uri to open, e.g. myapp://path?arg=1" },
      package: { type: "string", description: "optional package to constrain the intent to one app" },
      serial: SERIAL_PROP
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 30_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const uri = asString(args.uri, "uri").trim();
    const pkg = typeof args.package === "string" && args.package.trim() ? sanitizePackage(args.package) : "";
    const serial = await resolveDevice(context, typeof args.serial === "string" ? args.serial : undefined);
    const shell = `am start -a android.intent.action.VIEW -d ${shellQuote(uri)}${pkg ? ` ${shellQuote(pkg)}` : ""}`;
    const result = await runAdb(context, `${adbPrefix(serial)} shell ${shellQuote(shell)}`, 30_000);
    if (adbUnavailable(result)) throw new Error("adb is not available in the container");
    const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    const ok = result.exitCode === 0 && !/error|exception/i.test(output);
    return {
      ok,
      summary: ok ? `fired deep link ${uri}` : `deep link may have failed: ${uri}`,
      output: output || "(no output)",
      metadata: { serial, uri, package: pkg || null }
    };
  }
};

export const androidPullFileTool: ToolDefinition = {
  name: "android_pull_file",
  description: "Read a file from the device. When package is given, uses run-as <package> to reach app-private files (requires a debuggable app). Returns bounded file contents.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "absolute device path to read, e.g. /data/data/pkg/shared_prefs/x.xml" },
      package: { type: "string", description: "package to read app-private files via run-as; omit for world-readable paths" },
      serial: SERIAL_PROP
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 30_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const path = asString(args.path, "path").trim();
    const pkg = typeof args.package === "string" && args.package.trim() ? sanitizePackage(args.package) : "";
    const serial = await resolveDevice(context, typeof args.serial === "string" ? args.serial : undefined);
    const shell = pkg ? `run-as ${shellQuote(pkg)} cat ${shellQuote(path)}` : `cat ${shellQuote(path)}`;
    const result = await runAdb(context, `${adbPrefix(serial)} shell ${shellQuote(shell)}`, 30_000, 4_000_000);
    if (adbUnavailable(result)) throw new Error("adb is not available in the container");
    const ok = result.exitCode === 0 && !/no such file|permission denied|not debuggable|run-as:/i.test(result.stderr);
    return {
      ok,
      summary: ok ? `read ${path}` : `could not read ${path}`,
      output: ok ? result.stdout : `${result.stdout}${result.stderr}`.trim() || "(no output)",
      metadata: { serial, path, package: pkg || null }
    };
  }
};
