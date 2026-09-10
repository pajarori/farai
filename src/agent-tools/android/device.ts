import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { adbBase, adbPrefix, parseDevices, resolveDevice, runAdbChecked, shellQuote } from "./shared";

const SERIAL_PROP = { type: "string", description: "device serial from android_devices; omit when exactly one device is connected" };

export const androidConnectTool: ToolDefinition = {
  name: "android_connect",
  description: "Attach an android device over adb tcp/ip. Use this first when the device is reachable by wireless debugging, an emulator, or a remote host, since usb passthrough is unavailable inside the container. Provide host:port (default port 5555).",
  inputSchema: {
    type: "object",
    required: ["address"],
    properties: {
      address: { type: "string", description: "device address as host or host:port; port defaults to 5555 when omitted" }
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
    const raw = asString(args.address, "address").trim();
    const address = /:\d+$/.test(raw) ? raw : `${raw}:5555`;
    const result = await runAdbChecked(context, `${adbBase()} connect ${shellQuote(address)}`, 30_000);
    const text = `${result.stdout}${result.stderr}`.trim();
    const ok = /connected to/i.test(text) && !/cannot|failed|unable|refused/i.test(text);
    return {
      ok,
      summary: ok ? `connected to ${address}` : `could not connect to ${address}`,
      output: text || `no output; exit ${result.exitCode}`,
      metadata: { address, connected: ok }
    };
  }
};

export const androidDevicesTool: ToolDefinition = {
  name: "android_devices",
  description: "List android devices adb can currently see, with serial, connection state, and model. Use this to pick a serial before other android tools, or to confirm android_connect worked.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  mutates: false,
  timeoutMs: 15_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const result = await runAdbChecked(context, `${adbBase()} devices -l`, 15_000);
    const devices = parseDevices(result.stdout);
    const online = devices.filter((device) => device.state === "device");
    const output = devices.length
      ? devices.map((device) => `${device.serial}\t${device.state}${device.model ? `\tmodel:${device.model}` : ""}`).join("\n")
      : "no devices";
    return {
      ok: true,
      summary: `${devices.length} device(s), ${online.length} online`,
      output,
      metadata: { devices }
    };
  }
};

export const androidShellTool: ToolDefinition = {
  name: "android_shell",
  description: "Run one shell command on the android device via adb shell. Use purpose-built android tools when they model the task; use this for arbitrary on-device commands, dumpsys, pm, or content queries.",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", description: "complete shell command to run inside adb shell on the device" },
      serial: SERIAL_PROP
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 60_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const command = asString(args.command, "command");
    const serial = await resolveDevice(context, args.serial);
    const result = await runAdbChecked(context, `${adbPrefix(serial)} shell ${shellQuote(command)}`, 60_000);
    const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    return {
      ok: result.exitCode === 0,
      summary: result.exitCode === 0 ? `ran on ${serial}` : `command exited ${result.exitCode} on ${serial}`,
      output: output || "(no output)",
      metadata: { serial, exitCode: result.exitCode }
    };
  }
};

export const androidPackagesTool: ToolDefinition = {
  name: "android_packages",
  description: "List installed packages on the device. Use thirdPartyOnly to focus on user-installed apps, and filter to narrow by substring.",
  inputSchema: {
    type: "object",
    properties: {
      filter: { type: "string", description: "case-insensitive substring to match against package names" },
      thirdPartyOnly: { type: "boolean", description: "list only user-installed apps (pm list packages -3) when true" },
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
    const serial = await resolveDevice(context, args.serial);
    const thirdParty = args.thirdPartyOnly === true;
    const result = await runAdbChecked(context, `${adbPrefix(serial)} shell pm list packages${thirdParty ? " -3" : ""}`, 30_000);
    const filter = typeof args.filter === "string" ? args.filter.trim().toLowerCase() : "";
    let packages = result.stdout.split("\n").map((line) => line.replace(/^package:/, "").trim()).filter(Boolean);
    if (filter) packages = packages.filter((name) => name.toLowerCase().includes(filter));
    packages.sort();
    return {
      ok: result.exitCode === 0,
      summary: `${packages.length} package(s)${thirdParty ? " (third-party)" : ""}${filter ? ` matching "${filter}"` : ""}`,
      output: packages.length ? packages.join("\n") : "no packages matched",
      metadata: { serial, count: packages.length, packages: packages.slice(0, 1_000) }
    };
  }
};

export const androidDeviceInfoTool: ToolDefinition = {
  name: "android_device_info",
  description: "Summarize the target device in one call: android version, sdk, model, cpu abi, and root/su availability. Use this early to shape the methodology for the device.",
  inputSchema: {
    type: "object",
    properties: { serial: SERIAL_PROP },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 30_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const serial = await resolveDevice(context, args.serial);
    const props = [
      "ro.build.version.release",
      "ro.build.version.sdk",
      "ro.product.model",
      "ro.product.manufacturer",
      "ro.product.cpu.abi",
      "ro.build.type"
    ];
    const command = `${adbPrefix(serial)} shell ${shellQuote(`for p in ${props.join(" ")}; do echo "$p=$(getprop $p)"; done; echo su=$(command -v su || echo none)`)}`;
    const result = await runAdbChecked(context, command, 30_000);
    const info: Record<string, string> = {};
    for (const line of result.stdout.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) info[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return {
      ok: result.exitCode === 0,
      summary: `${info["ro.product.manufacturer"] ?? "?"} ${info["ro.product.model"] ?? serial}, android ${info["ro.build.version.release"] ?? "?"} (sdk ${info["ro.build.version.sdk"] ?? "?"})`,
      output: Object.entries(info).map(([key, value]) => `${key}: ${value}`).join("\n") || result.stdout,
      metadata: { serial, info }
    };
  }
};

export const androidLogcatTool: ToolDefinition = {
  name: "android_logcat",
  description: "Capture recent logcat output from the device, optionally filtered by tag. Use this to spot leaked tokens, stack traces, and app behavior after an action; it dumps the current buffer and returns.",
  inputSchema: {
    type: "object",
    properties: {
      tag: { type: "string", description: "logcat tag filter; only lines from this tag are returned" },
      lines: { type: "integer", minimum: 1, maximum: 5_000, description: "maximum trailing lines to return (default 200)" },
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
    const serial = await resolveDevice(context, args.serial);
    const lines = typeof args.lines === "number" && Number.isInteger(args.lines) ? Math.max(1, Math.min(5_000, args.lines)) : 200;
    const tag = typeof args.tag === "string" && args.tag.trim() ? args.tag.trim() : "";
    const filter = tag ? ` -s ${shellQuote(tag)}` : "";
    const result = await runAdbChecked(context, `${adbPrefix(serial)} logcat -d -t ${lines}${filter}`, 30_000);
    const output = result.stdout.trim();
    return {
      ok: result.exitCode === 0,
      summary: `${output.split("\n").filter(Boolean).length} logcat line(s)${tag ? ` for tag ${tag}` : ""}`,
      output: output || "(empty logcat buffer)",
      metadata: { serial, tag: tag || null }
    };
  }
};
