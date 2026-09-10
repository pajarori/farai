import type { ToolContext, ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { backend } from "../shared/backend";
import { backgroundToolResult } from "../shared/background-result";
import { clampYieldMs, sessionManager } from "../shared/session-manager";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { adbEnvPrefix, adbPrefix, compactError, resolveDevice, runAdb, runAdbChecked, shellQuote } from "./shared";

const SERIAL_PROP = { type: "string", description: "device serial from android_devices; omit when exactly one device is connected" };
const DEVICE_SERVER_PATH = "/data/local/tmp/frida-server";
const ASSET_DIR = ".farai/android";
const RUNNER_PATH = `${ASSET_DIR}/frida_runner.py`;

export const ABI_MAP: Record<string, string> = {
  "arm64-v8a": "arm64",
  "armeabi-v7a": "arm",
  "x86_64": "x86_64",
  "x86": "x86"
};

const FRIDA_RUNNER = `import sys, json, time, argparse
try:
    import frida
except Exception as exc:
    print("FRIDA_DONE " + json.dumps({"error": "frida python module missing: %s" % exc}))
    sys.exit(0)

def emit(obj):
    print("FRIDA " + json.dumps(obj), flush=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial", default="")
    ap.add_argument("--mode", default="attach")
    ap.add_argument("--target", required=True)
    ap.add_argument("--script", required=True)
    ap.add_argument("--duration", type=float, default=10.0)
    a = ap.parse_args()
    collected = []
    def on_message(message, data):
        if message.get("type") == "send":
            payload = message.get("payload")
            collected.append(payload)
            emit({"send": payload})
        elif message.get("type") == "error":
            desc = message.get("description")
            collected.append({"__error__": desc})
            emit({"error": desc})
    try:
        device = frida.get_device(a.serial, timeout=5) if a.serial else frida.get_usb_device(timeout=5)
    except Exception as exc:
        print("FRIDA_DONE " + json.dumps({"error": "device not reachable by frida: %s" % exc}))
        return
    try:
        with open(a.script) as handle:
            source = handle.read()
    except Exception as exc:
        print("FRIDA_DONE " + json.dumps({"error": "cannot read script: %s" % exc}))
        return
    spawned = False
    pid = None
    try:
        if a.mode == "spawn":
            pid = device.spawn([a.target])
            spawned = True
            session = device.attach(pid)
        else:
            session = device.attach(a.target)
    except Exception as exc:
        print("FRIDA_DONE " + json.dumps({"error": "attach/spawn failed: %s" % exc}))
        return
    try:
        script = session.create_script(source)
        script.on("message", on_message)
        script.load()
        if spawned and pid is not None:
            device.resume(pid)
        time.sleep(a.duration)
    except Exception as exc:
        collected.append({"__error__": str(exc)})
    finally:
        try:
            session.detach()
        except Exception:
            pass
    print("FRIDA_DONE " + json.dumps({"messages": collected, "spawned": spawned, "target": a.target}))

main()
`;

const SSL_BYPASS_JS = `Java.perform(function () {
  function log(m) { send({ tag: "ssl-bypass", msg: m }); }
  try {
    var TMImpl = Java.use("com.android.org.conscrypt.TrustManagerImpl");
    TMImpl.checkTrustedRecursive.implementation = function () { log("conscrypt checkTrustedRecursive bypassed"); return Java.use("java.util.ArrayList").$new(); };
  } catch (e) {}
  try {
    var TrustManager = Java.registerClass({
      name: "com.farai.TrustAll",
      implements: [Java.use("javax.net.ssl.X509TrustManager")],
      methods: {
        checkClientTrusted: function () {},
        checkServerTrusted: function () {},
        getAcceptedIssuers: function () { return []; }
      }
    });
    var SSLContext = Java.use("javax.net.ssl.SSLContext");
    SSLContext.init.overload("[Ljavax.net.ssl.KeyManager;", "[Ljavax.net.ssl.TrustManager;", "java.security.SecureRandom").implementation = function (km, tm, sr) {
      log("SSLContext.init overridden with trust-all manager");
      this.init(km, [TrustManager.$new()], sr);
    };
  } catch (e) {}
  try {
    var OkHostnameVerifier = Java.use("okhttp3.internal.tls.OkHostnameVerifier");
    OkHostnameVerifier.verify.overload("java.lang.String", "javax.net.ssl.SSLSession").implementation = function () { log("okhttp OkHostnameVerifier bypassed"); return true; };
  } catch (e) {}
  try {
    var CertPinner = Java.use("okhttp3.CertificatePinner");
    CertPinner.check.overload("java.lang.String", "java.util.List").implementation = function () { log("okhttp CertificatePinner.check bypassed"); return; };
  } catch (e) {}
  log("ssl pinning bypass hooks installed");
});
`;

const ROOT_BYPASS_JS = `Java.perform(function () {
  function log(m) { send({ tag: "root-bypass", msg: m }); }
  try {
    var RootBeer = Java.use("com.scottyab.rootbeer.RootBeer");
    ["isRooted", "isRootedWithoutBusyBoxCheck", "detectRootManagementApps", "detectPotentiallyDangerousApps", "checkForBinary", "checkForSuBinary", "checkForDangerousProps", "detectTestKeys", "checkSuExists"].forEach(function (m) {
      try { RootBeer[m].implementation = function () { log("RootBeer." + m + " -> false"); return false; }; } catch (e) {}
    });
  } catch (e) {}
  try {
    var Runtime = Java.use("java.lang.Runtime");
    Runtime.exec.overload("java.lang.String").implementation = function (cmd) {
      if (cmd && (cmd.indexOf("su") !== -1 || cmd.indexOf("which") !== -1 || cmd.indexOf("busybox") !== -1)) { log("blocked Runtime.exec(" + cmd + ")"); throw Java.use("java.io.IOException").$new("blocked"); }
      return this.exec(cmd);
    };
  } catch (e) {}
  try {
    var File = Java.use("java.io.File");
    File.exists.implementation = function () {
      var path = this.getAbsolutePath();
      if (path && (path.indexOf("su") !== -1 || path.indexOf("magisk") !== -1 || path.indexOf("supersu") !== -1)) { log("hid file " + path); return false; }
      return this.exists();
    };
  } catch (e) {}
  log("root detection bypass hooks installed");
});
`;

const BYPASS_SCRIPTS: Record<string, string> = { ssl: SSL_BYPASS_JS, root: ROOT_BYPASS_JS };

async function writeAsset(context: ToolContext, relPath: string, content: string): Promise<void> {
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : ".";
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const command = `mkdir -p ${shellQuote(dir)} && printf %s ${shellQuote(b64)} | base64 -d > ${shellQuote(relPath)}`;
  const result = await backend(context).exec(command, 20_000, context.signal);
  if (result.exitCode !== 0) throw new Error(`failed to write ${relPath}: ${compactError(result.stderr || result.stdout)}`);
}

function fridaRunCommand(serial: string, mode: string, target: string, scriptPath: string, durationSeconds: number): string {
  return [
    `${adbEnvPrefix()}python3`, RUNNER_PATH,
    "--serial", shellQuote(serial),
    "--mode", shellQuote(mode),
    "--target", shellQuote(target),
    "--script", shellQuote(scriptPath),
    "--duration", String(durationSeconds)
  ].join(" ");
}

export function parseFridaMessages(stdout: string): { messages: unknown[]; summary: Record<string, unknown> | undefined } {
  const messages: unknown[] = [];
  let summary: Record<string, unknown> | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("FRIDA_DONE ")) {
      try { summary = JSON.parse(trimmed.slice("FRIDA_DONE ".length)); } catch { /* ignore */ }
    } else if (trimmed.startsWith("FRIDA ")) {
      try { messages.push(JSON.parse(trimmed.slice("FRIDA ".length))); } catch { /* ignore */ }
    }
  }
  return { messages, summary };
}

export const androidFridaInstallTool: ToolDefinition = {
  name: "android_frida_install",
  description: "Install frida-tools in the container, optionally pinned to a version. Frida is intentionally not baked into the image because the python frida module must match the frida-server version, which varies per device and app. Install here first, then run android_frida_setup to provision a matching frida-server.",
  inputSchema: {
    type: "object",
    properties: {
      version: { type: "string", description: "exact frida version to pin, e.g. 16.5.9; omit to install the latest frida-tools" }
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 360_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const version = typeof args.version === "string" && args.version.trim() ? args.version.trim() : "";
    if (version && !/^\d+(\.\d+){1,3}$/.test(version)) throw new Error("version must look like 16.5.9");
    const spec = version ? `frida==${version} frida-tools` : "frida-tools";
    const command = `pip install --upgrade ${spec} 2>&1`;
    const result = await backend(context).exec(command, 360_000, context.signal, 2_000_000);
    const installed = await backend(context).exec("frida --version 2>/dev/null", 15_000, context.signal);
    const resolved = installed.stdout.trim();
    const ok = Boolean(resolved) && (!version || resolved === version);
    return {
      ok,
      summary: ok ? `frida-tools ${resolved} installed` : `frida install did not settle at the requested version${version ? ` (${version})` : ""}`,
      output: `${result.stdout}`.trim().split("\n").slice(-20).join("\n") || `exit ${result.exitCode}`,
      metadata: { requested: version || "latest", installedVersion: resolved || null }
    };
  }
};

export const androidFridaStatusTool: ToolDefinition = {
  name: "android_frida_status",
  description: "Check whether frida is ready: frida-tools in the container, and frida-server binary, process, and listening port on the device. Run this before other frida tools; if frida-tools is missing run android_frida_install, then android_frida_setup.",
  inputSchema: { type: "object", properties: { serial: SERIAL_PROP }, additionalProperties: false },
  mutates: false,
  timeoutMs: 40_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const serial = await resolveDevice(context, args.serial);
    const version = await backend(context).exec("frida --version 2>/dev/null || true", 15_000, context.signal);
    const fridaTools = version.stdout.trim();
    const binary = await runAdb(context, `${adbPrefix(serial)} shell ls ${DEVICE_SERVER_PATH} 2>/dev/null`, 15_000);
    const proc = await runAdb(context, `${adbPrefix(serial)} shell 'ps -A 2>/dev/null | grep frida-server || ps | grep frida-server'`, 15_000);
    const checks = {
      fridaToolsVersion: fridaTools || "missing",
      serverBinary: binary.stdout.includes("frida-server") ? "present" : "missing",
      serverProcess: /frida-server/.test(proc.stdout) ? "running" : "stopped"
    };
    const ready = Boolean(fridaTools) && checks.serverBinary === "present" && checks.serverProcess === "running";
    return {
      ok: true,
      summary: ready ? "frida is ready" : `frida is not ready; run ${fridaTools ? "android_frida_setup" : "android_frida_install then android_frida_setup"}`,
      output: Object.entries(checks).map(([key, value]) => `${key}: ${value}`).join("\n"),
      metadata: { serial, ready, checks }
    };
  }
};

async function pipInstallFrida(context: ToolContext, version: string): Promise<{ output: string; resolved: string }> {
  const spec = version ? `frida==${version} frida-tools` : "frida-tools";
  const install = await backend(context).exec(`pip install --upgrade ${spec} 2>&1`, 360_000, context.signal, 2_000_000);
  const check = await backend(context).exec("frida --version 2>/dev/null", 15_000, context.signal);
  return { output: install.stdout.trim().split("\n").slice(-15).join("\n"), resolved: check.stdout.trim() };
}

export const androidFridaSetupTool: ToolDefinition = {
  name: "android_frida_setup",
  description: "One-command frida provisioning: install frida-tools in the container (pinned to version when given), detect the device cpu abi, download the matching frida-server build, push it to /data/local/tmp/frida-server, and start it (needs root via su or adb root). The python frida module and frida-server versions are kept identical. Run android_frida_status afterwards to confirm.",
  inputSchema: {
    type: "object",
    properties: {
      version: { type: "string", description: "exact frida version to pin for both the python module and frida-server, e.g. 16.5.9; omit to use the latest installed frida-tools" },
      serial: SERIAL_PROP
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 500_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const requested = typeof args.version === "string" && args.version.trim() ? args.version.trim() : "";
    if (requested && !/^\d+(\.\d+){1,3}$/.test(requested)) throw new Error("version must look like 16.5.9");
    const serial = await resolveDevice(context, args.serial);
    const steps: string[] = [];
    let version = (await backend(context).exec("frida --version 2>/dev/null", 15_000, context.signal)).stdout.trim();
    if (requested || !version) {
      const install = await pipInstallFrida(context, requested);
      version = install.resolved;
      steps.push(`pip install ${requested || "latest"}: ${version ? `frida-tools ${version}` : "failed"}`);
    } else {
      steps.push(`frida-tools already present: ${version}`);
    }
    if (!version) return { ok: false, summary: "frida-tools install failed", output: steps.join("\n"), metadata: { serial } };
    const abiResult = await runAdbChecked(context, `${adbPrefix(serial)} shell getprop ro.product.cpu.abi`, 15_000);
    const abi = abiResult.stdout.trim().replace(/\r/g, "");
    const arch = ABI_MAP[abi];
    if (!arch) throw new Error(`unsupported device abi: ${abi || "unknown"} (supported: ${Object.keys(ABI_MAP).join(", ")})`);
    const url = `https://github.com/frida/frida/releases/download/${version}/frida-server-${version}-android-${arch}.xz`;
    const download = await backend(context).exec(`curl -fsSL -o /tmp/frida-server.xz ${shellQuote(url)} && xz -d -f /tmp/frida-server.xz`, 180_000, context.signal);
    steps.push(`download ${arch} ${version}: ${download.exitCode === 0 ? "ok" : `failed (${compactError(download.stderr || download.stdout)})`}`);
    if (download.exitCode !== 0) {
      return { ok: false, summary: `could not download frida-server ${version} for ${arch}`, output: steps.join("\n"), metadata: { serial, version, arch, url } };
    }
    const push = await runAdb(context, `${adbPrefix(serial)} push /tmp/frida-server ${DEVICE_SERVER_PATH} && ${adbPrefix(serial)} shell chmod 755 ${DEVICE_SERVER_PATH}`, 90_000);
    steps.push(`push + chmod: ${push.exitCode === 0 ? "ok" : `failed (${compactError(push.stderr || push.stdout)})`}`);
    const start = await runAdb(context, `${adbPrefix(serial)} shell 'su -c "${DEVICE_SERVER_PATH} -D" >/dev/null 2>&1 & echo started' || ${adbPrefix(serial)} shell '${DEVICE_SERVER_PATH} -D >/dev/null 2>&1 & echo started'`, 20_000);
    steps.push(`start: ${/started/.test(start.stdout) ? "attempted (verify with android_frida_status)" : "could not start; device may need root"}`);
    return {
      ok: push.exitCode === 0,
      summary: `frida-server ${version} (${arch}) provisioned; verify with android_frida_status`,
      output: steps.join("\n"),
      metadata: { serial, version, arch }
    };
  }
};

export const androidFridaPsTool: ToolDefinition = {
  name: "android_frida_ps",
  description: "List processes and applications visible to frida on the device. Use to find the exact process name or pid to attach to.",
  inputSchema: {
    type: "object",
    properties: {
      applicationsOnly: { type: "boolean", description: "list installed applications (frida-ps -Uai) instead of running processes when true" },
      serial: SERIAL_PROP
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 40_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const serial = await resolveDevice(context, args.serial);
    const listFlag = args.applicationsOnly === true ? "-ai" : "-a";
    const deviceFlag = `-D ${shellQuote(serial)}`;
    const result = await backend(context).exec(`${adbEnvPrefix()}frida-ps ${listFlag} ${deviceFlag} 2>&1`, 40_000, context.signal);
    if (/not found|no such/i.test(result.stdout) && result.exitCode !== 0) throw new Error("frida-tools is not installed in the container");
    return {
      ok: result.exitCode === 0,
      summary: result.exitCode === 0 ? "listed frida targets" : "frida-ps failed (is frida-server running?)",
      output: result.stdout.trim() || "(no output)",
      metadata: { serial, listFlag }
    };
  }
};

export const androidFridaRunTool: ToolDefinition = {
  name: "android_frida_run",
  description: "Run a frida javascript script against an app and collect its send() messages. Write the script first with fs_write, then attach to a running process or spawn a package. Use background=true to keep hooks live while you interact with the app, then read output with session_poll.",
  inputSchema: {
    type: "object",
    required: ["scriptPath", "target"],
    properties: {
      scriptPath: { type: "string", description: "workspace-relative path to the frida javascript to load" },
      target: { type: "string", description: "package name to spawn, or process name/pid to attach to" },
      mode: { type: "string", enum: ["spawn", "attach"], description: "spawn launches the package fresh; attach hooks an already-running process (default attach)" },
      durationSeconds: { type: "integer", minimum: 1, maximum: 600, description: "how long to keep the session open collecting messages (default 15)" },
      background: { type: "boolean", description: "run as a persistent background session and return a job id; poll it with session_poll" },
      serial: SERIAL_PROP
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 620_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const scriptPath = asString(args.scriptPath, "scriptPath").trim();
    const target = asString(args.target, "target").trim();
    const mode = args.mode === "spawn" ? "spawn" : "attach";
    const durationSeconds = typeof args.durationSeconds === "number" && Number.isInteger(args.durationSeconds) ? Math.max(1, Math.min(600, args.durationSeconds)) : 15;
    const serial = await resolveDevice(context, args.serial);
    await writeAsset(context, RUNNER_PATH, FRIDA_RUNNER);
    const command = fridaRunCommand(serial, mode, target, scriptPath, durationSeconds);
    if (args.background === true) {
      const started = await sessionManager.start(backend(context), "android_frida_run", command, clampYieldMs(args.background === true ? undefined : 1_000), context.signal, { kind: "generic" });
      return backgroundToolResult("android_frida_run", started, "generic");
    }
    const result = await backend(context).exec(command, (durationSeconds + 30) * 1_000, context.signal, 4_000_000);
    const { messages, summary } = parseFridaMessages(result.stdout);
    const error = summary && typeof summary.error === "string" ? summary.error : undefined;
    const output = error ? `frida error: ${error}` : `${messages.length} message(s):\n${messages.map((m) => JSON.stringify(m)).join("\n")}`;
    return {
      ok: !error,
      summary: error ? `frida run failed: ${error}` : `collected ${messages.length} message(s) from ${target}`,
      output: output || "(no messages)",
      metadata: { serial, target, mode, messages: messages.slice(0, 500), ...(summary ? { summary } : {}) }
    };
  }
};

export const androidFridaBypassTool: ToolDefinition = {
  name: "android_frida_bypass",
  description: "Spawn an app with a bundled bypass script attached: ssl for certificate-pinning bypass (to see traffic through the proxy), root for root-detection bypass. Use background=true to keep the bypass active while you drive the app.",
  inputSchema: {
    type: "object",
    required: ["type", "package"],
    properties: {
      type: { type: "string", enum: ["ssl", "root"], description: "which bundled bypass to inject" },
      package: { type: "string", description: "package name to spawn with the bypass attached" },
      durationSeconds: { type: "integer", minimum: 1, maximum: 600, description: "how long to keep the bypass session open (default 30)" },
      background: { type: "boolean", description: "run as a persistent background session so hooks stay active; poll with session_poll" },
      serial: SERIAL_PROP
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 620_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const type = asString(args.type, "type");
    const script = BYPASS_SCRIPTS[type];
    if (!script) throw new Error(`unknown bypass type: ${type}; use ssl or root`);
    const pkg = asString(args.package, "package").trim();
    const durationSeconds = typeof args.durationSeconds === "number" && Number.isInteger(args.durationSeconds) ? Math.max(1, Math.min(600, args.durationSeconds)) : 30;
    const serial = await resolveDevice(context, args.serial);
    const scriptPath = `${ASSET_DIR}/scripts/bypass_${type}.js`;
    await writeAsset(context, RUNNER_PATH, FRIDA_RUNNER);
    await writeAsset(context, scriptPath, script);
    const command = fridaRunCommand(serial, "spawn", pkg, scriptPath, durationSeconds);
    if (args.background === true) {
      const started = await sessionManager.start(backend(context), "android_frida_bypass", command, clampYieldMs(1_000), context.signal, { kind: "generic" });
      return backgroundToolResult("android_frida_bypass", started, "generic");
    }
    const result = await backend(context).exec(command, (durationSeconds + 30) * 1_000, context.signal, 4_000_000);
    const { messages, summary } = parseFridaMessages(result.stdout);
    const error = summary && typeof summary.error === "string" ? summary.error : undefined;
    return {
      ok: !error,
      summary: error ? `${type} bypass failed: ${error}` : `${type} bypass injected into ${pkg} (${messages.length} hook message(s))`,
      output: error ? `frida error: ${error}` : messages.map((m) => JSON.stringify(m)).join("\n") || "hooks installed (no messages emitted)",
      metadata: { serial, type, package: pkg, messages: messages.slice(0, 500) }
    };
  }
};
