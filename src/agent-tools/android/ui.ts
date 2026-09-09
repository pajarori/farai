import type { ToolContext, ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { adbPrefix, adbUnavailable, resolveDevice, runAdb, shellQuote } from "./shared";

const SERIAL_PROP = { type: "string", description: "device serial from android_devices; omit when exactly one device is connected" };

export type UiNode = {
  text: string;
  resourceId: string;
  contentDesc: string;
  className: string;
  clickable: boolean;
  bounds: [number, number, number, number];
  center: [number, number];
};

export function parseUiNodes(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  for (const match of xml.matchAll(/<node\b([^>]*)>/g)) {
    const attrs = match[1] ?? "";
    const bounds = /bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/.exec(attrs);
    if (!bounds) continue;
    const x1 = Number(bounds[1]);
    const y1 = Number(bounds[2]);
    const x2 = Number(bounds[3]);
    const y2 = Number(bounds[4]);
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? "";
    nodes.push({
      text: attr("text"),
      resourceId: attr("resource-id"),
      contentDesc: attr("content-desc"),
      className: attr("class"),
      clickable: attr("clickable") === "true",
      bounds: [x1, y1, x2, y2],
      center: [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)]
    });
  }
  return nodes;
}

export function findUiNode(nodes: UiNode[], selector: { resourceId?: string; text?: string; contentDesc?: string }): UiNode | undefined {
  const wantId = selector.resourceId?.trim();
  const wantText = selector.text?.trim();
  const wantDesc = selector.contentDesc?.trim();
  return nodes.find((node) => {
    if (wantId && !(node.resourceId === wantId || node.resourceId.endsWith(`/${wantId}`))) return false;
    if (wantText && !(node.text === wantText || node.text.toLowerCase().includes(wantText.toLowerCase()))) return false;
    if (wantDesc && !(node.contentDesc === wantDesc || node.contentDesc.toLowerCase().includes(wantDesc.toLowerCase()))) return false;
    return Boolean(wantId || wantText || wantDesc);
  });
}

async function dumpHierarchy(context: ToolContext, serial: string): Promise<string> {
  const remote = "/sdcard/farai_uidump.xml";
  const dump = await runAdb(context, `${adbPrefix(serial)} shell uiautomator dump ${remote}`, 30_000);
  if (adbUnavailable(dump)) throw new Error("adb is not available in the container");
  const read = await runAdb(context, `${adbPrefix(serial)} shell cat ${remote}`, 20_000, 8_000_000);
  const xml = read.stdout.trim();
  if (!xml.includes("<hierarchy") && !xml.includes("<node")) {
    throw new Error(`could not capture ui hierarchy: ${(dump.stderr || dump.stdout || "no output").trim().slice(0, 200)}`);
  }
  return xml;
}

function describeNode(node: UiNode): string {
  const label = node.text || node.contentDesc || node.resourceId || node.className;
  const parts = [
    node.resourceId ? `id=${node.resourceId}` : "",
    node.text ? `text=${JSON.stringify(node.text)}` : "",
    node.contentDesc ? `desc=${JSON.stringify(node.contentDesc)}` : "",
    node.clickable ? "clickable" : "",
    `@${node.center[0]},${node.center[1]}`
  ].filter(Boolean);
  return `${label} — ${parts.join(" ")}`;
}

export const androidUiDumpTool: ToolDefinition = {
  name: "android_ui_dump",
  description: "Capture the current screen's ui hierarchy via uiautomator and return interactive elements (text, resource-id, content-desc, clickable, tap center). Use this before android_ui_tap_element to see what is on screen.",
  inputSchema: {
    type: "object",
    properties: {
      clickableOnly: { type: "boolean", description: "return only clickable elements when true (default true)" },
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
    const serial = await resolveDevice(context, typeof args.serial === "string" ? args.serial : undefined);
    const xml = await dumpHierarchy(context, serial);
    const all = parseUiNodes(xml);
    const clickableOnly = args.clickableOnly !== false;
    const shown = (clickableOnly ? all.filter((node) => node.clickable) : all)
      .filter((node) => node.text || node.contentDesc || node.resourceId);
    return {
      ok: true,
      summary: `${shown.length} element(s) of ${all.length} on screen`,
      output: shown.length ? shown.map(describeNode).join("\n") : "no labeled elements found",
      metadata: { serial, total: all.length, elements: shown.slice(0, 200) }
    };
  }
};

export const androidUiHierarchyTool: ToolDefinition = {
  name: "android_ui_hierarchy",
  description: "Return the full raw uiautomator xml hierarchy of the current screen. Use when android_ui_dump omits an element you need to inspect precisely.",
  inputSchema: {
    type: "object",
    properties: { serial: SERIAL_PROP },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 40_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const serial = await resolveDevice(context, typeof args.serial === "string" ? args.serial : undefined);
    const xml = await dumpHierarchy(context, serial);
    return { ok: true, summary: `captured ui hierarchy (${xml.length} bytes)`, output: xml, metadata: { serial } };
  }
};

export const androidScreenshotTool: ToolDefinition = {
  name: "android_screenshot",
  description: "Take a screenshot of the current screen and save it as a png in the workspace. Use android's image_view tool afterwards to inspect the saved file.",
  inputSchema: {
    type: "object",
    properties: { serial: SERIAL_PROP },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 40_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const serial = await resolveDevice(context, typeof args.serial === "string" ? args.serial : undefined);
    const remote = "/sdcard/farai_screen.png";
    const local = `android/screenshots/${Date.now()}.png`;
    await runAdb(context, `mkdir -p android/screenshots`, 10_000);
    const cap = await runAdb(context, `${adbPrefix(serial)} shell screencap -p ${remote}`, 30_000);
    if (adbUnavailable(cap)) throw new Error("adb is not available in the container");
    const pull = await runAdb(context, `${adbPrefix(serial)} pull ${remote} ${shellQuote(local)}`, 40_000);
    const ok = pull.exitCode === 0;
    return {
      ok,
      summary: ok ? `saved screenshot to ${local}` : "screenshot capture failed",
      output: ok ? local : `${pull.stderr || pull.stdout}`.trim() || "screencap failed",
      metadata: { serial, path: ok ? local : null }
    };
  }
};

export const androidUiTapTool: ToolDefinition = {
  name: "android_ui_tap",
  description: "Tap the screen at absolute pixel coordinates. Use android_ui_tap_element when you can identify the target by id or text instead.",
  inputSchema: {
    type: "object",
    required: ["x", "y"],
    properties: {
      x: { type: "integer", minimum: 0, description: "x pixel coordinate" },
      y: { type: "integer", minimum: 0, description: "y pixel coordinate" },
      serial: SERIAL_PROP
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 20_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error("x and y must be integers");
    const serial = await resolveDevice(context, typeof args.serial === "string" ? args.serial : undefined);
    const result = await runAdb(context, `${adbPrefix(serial)} shell input tap ${x} ${y}`, 20_000);
    if (adbUnavailable(result)) throw new Error("adb is not available in the container");
    return { ok: result.exitCode === 0, summary: `tapped ${x},${y}`, output: result.stdout.trim() || "tapped", metadata: { serial, x, y } };
  }
};

export const androidUiTapElementTool: ToolDefinition = {
  name: "android_ui_tap_element",
  description: "Tap a ui element identified by resource-id, visible text, or content-desc. Dumps the hierarchy, resolves the element center, and taps it. Provide at least one selector.",
  inputSchema: {
    type: "object",
    properties: {
      resourceId: { type: "string", description: "full or trailing resource-id, e.g. com.app:id/login or login" },
      text: { type: "string", description: "exact or substring visible text of the element" },
      contentDesc: { type: "string", description: "exact or substring content-desc of the element" },
      serial: SERIAL_PROP
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 40_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const selector = {
      ...(typeof args.resourceId === "string" ? { resourceId: args.resourceId } : {}),
      ...(typeof args.text === "string" ? { text: args.text } : {}),
      ...(typeof args.contentDesc === "string" ? { contentDesc: args.contentDesc } : {})
    };
    if (!selector.resourceId && !selector.text && !selector.contentDesc) throw new Error("provide at least one of resourceId, text, or contentDesc");
    const serial = await resolveDevice(context, typeof args.serial === "string" ? args.serial : undefined);
    const xml = await dumpHierarchy(context, serial);
    const node = findUiNode(parseUiNodes(xml), selector);
    if (!node) return { ok: false, summary: "no element matched the selector", output: "element not found on the current screen", metadata: { serial, selector } };
    const [x, y] = node.center;
    const result = await runAdb(context, `${adbPrefix(serial)} shell input tap ${x} ${y}`, 20_000);
    return { ok: result.exitCode === 0, summary: `tapped ${node.resourceId || node.text || node.contentDesc} @${x},${y}`, output: describeNode(node), metadata: { serial, x, y, node } };
  }
};

export const androidUiTypeTool: ToolDefinition = {
  name: "android_ui_type",
  description: "Type text into the currently focused input field via adb input. Tap the field first with android_ui_tap_element to focus it.",
  inputSchema: {
    type: "object",
    required: ["text"],
    properties: {
      text: { type: "string", description: "text to type into the focused field" },
      serial: SERIAL_PROP
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 20_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const text = asString(args.text, "text");
    const serial = await resolveDevice(context, typeof args.serial === "string" ? args.serial : undefined);
    const escaped = text.replace(/(["\\$`])/g, "\\$1").replace(/ /g, "%s");
    const result = await runAdb(context, `${adbPrefix(serial)} shell input text ${shellQuote(escaped)}`, 20_000);
    if (adbUnavailable(result)) throw new Error("adb is not available in the container");
    return { ok: result.exitCode === 0, summary: `typed ${text.length} char(s)`, output: result.stdout.trim() || "typed", metadata: { serial } };
  }
};

export const androidUiSwipeTool: ToolDefinition = {
  name: "android_ui_swipe",
  description: "Swipe from one point to another over a duration. Use for scrolling, dismissing, and gesture navigation.",
  inputSchema: {
    type: "object",
    required: ["x1", "y1", "x2", "y2"],
    properties: {
      x1: { type: "integer", minimum: 0, description: "start x" },
      y1: { type: "integer", minimum: 0, description: "start y" },
      x2: { type: "integer", minimum: 0, description: "end x" },
      y2: { type: "integer", minimum: 0, description: "end y" },
      durationMs: { type: "integer", minimum: 50, maximum: 10_000, description: "swipe duration in ms (default 300)" },
      serial: SERIAL_PROP
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 20_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const coords = ["x1", "y1", "x2", "y2"].map((key) => Number((args as Record<string, unknown>)[key]));
    if (coords.some((value) => !Number.isInteger(value))) throw new Error("x1, y1, x2, y2 must be integers");
    const duration = typeof args.durationMs === "number" && Number.isInteger(args.durationMs) ? Math.max(50, Math.min(10_000, args.durationMs)) : 300;
    const serial = await resolveDevice(context, typeof args.serial === "string" ? args.serial : undefined);
    const [x1, y1, x2, y2] = coords;
    const result = await runAdb(context, `${adbPrefix(serial)} shell input swipe ${x1} ${y1} ${x2} ${y2} ${duration}`, 20_000);
    if (adbUnavailable(result)) throw new Error("adb is not available in the container");
    return { ok: result.exitCode === 0, summary: `swiped ${x1},${y1} -> ${x2},${y2}`, output: result.stdout.trim() || "swiped", metadata: { serial } };
  }
};

const KEYEVENTS: Record<string, number> = {
  back: 4, home: 3, menu: 82, enter: 66, tab: 61, escape: 111,
  up: 19, down: 20, left: 21, right: 22, delete: 67, search: 84, power: 26, appswitch: 187
};

export const androidUiKeyTool: ToolDefinition = {
  name: "android_ui_key",
  description: "Send a keyevent to the device. Accepts a named key (back, home, enter, tab, up, down, delete, ...) or a raw android keycode number.",
  inputSchema: {
    type: "object",
    required: ["key"],
    properties: {
      key: { type: "string", description: "named key (back, home, menu, enter, tab, up, down, left, right, delete, search, power, appswitch) or a numeric keycode" },
      serial: SERIAL_PROP
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 20_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const key = asString(args.key, "key").trim().toLowerCase();
    const code = KEYEVENTS[key] ?? (/^\d+$/.test(key) ? Number(key) : undefined);
    if (code === undefined) throw new Error(`unknown key "${key}"; use a named key or a numeric keycode`);
    const serial = await resolveDevice(context, typeof args.serial === "string" ? args.serial : undefined);
    const result = await runAdb(context, `${adbPrefix(serial)} shell input keyevent ${code}`, 20_000);
    if (adbUnavailable(result)) throw new Error("adb is not available in the container");
    return { ok: result.exitCode === 0, summary: `sent key ${key} (${code})`, output: result.stdout.trim() || "sent", metadata: { serial, key, code } };
  }
};

export const androidUiWindowSizeTool: ToolDefinition = {
  name: "android_ui_window_size",
  description: "Return the device screen resolution. Use to compute tap and swipe coordinates.",
  inputSchema: {
    type: "object",
    properties: { serial: SERIAL_PROP },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 20_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const serial = await resolveDevice(context, typeof args.serial === "string" ? args.serial : undefined);
    const result = await runAdb(context, `${adbPrefix(serial)} shell wm size`, 20_000);
    if (adbUnavailable(result)) throw new Error("adb is not available in the container");
    const size = /(\d+)x(\d+)/.exec(result.stdout);
    return {
      ok: result.exitCode === 0,
      summary: size ? `${size[1]}x${size[2]}` : result.stdout.trim(),
      output: result.stdout.trim() || "(no output)",
      metadata: { serial, ...(size ? { width: Number(size[1]), height: Number(size[2]) } : {}) }
    };
  }
};

export const androidUiWaitForTool: ToolDefinition = {
  name: "android_ui_wait_for",
  description: "Poll the ui hierarchy until an element matching a selector appears or the timeout elapses. Use after an action that triggers a screen transition.",
  inputSchema: {
    type: "object",
    properties: {
      resourceId: { type: "string", description: "resource-id to wait for" },
      text: { type: "string", description: "visible text to wait for (substring match)" },
      contentDesc: { type: "string", description: "content-desc to wait for (substring match)" },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 120, description: "maximum seconds to wait (default 15)" },
      serial: SERIAL_PROP
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 130_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const selector = {
      ...(typeof args.resourceId === "string" ? { resourceId: args.resourceId } : {}),
      ...(typeof args.text === "string" ? { text: args.text } : {}),
      ...(typeof args.contentDesc === "string" ? { contentDesc: args.contentDesc } : {})
    };
    if (!selector.resourceId && !selector.text && !selector.contentDesc) throw new Error("provide at least one of resourceId, text, or contentDesc");
    const timeoutSeconds = typeof args.timeoutSeconds === "number" && Number.isInteger(args.timeoutSeconds) ? Math.max(1, Math.min(120, args.timeoutSeconds)) : 15;
    const serial = await resolveDevice(context, typeof args.serial === "string" ? args.serial : undefined);
    const deadline = Date.now() + timeoutSeconds * 1_000;
    let attempts = 0;
    while (Date.now() < deadline) {
      if (context.signal?.aborted) throw new Error("wait cancelled");
      attempts += 1;
      const node = findUiNode(parseUiNodes(await dumpHierarchy(context, serial)), selector);
      if (node) return { ok: true, summary: `element appeared after ${attempts} check(s)`, output: describeNode(node), metadata: { serial, node, attempts } };
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return { ok: false, summary: `element did not appear within ${timeoutSeconds}s`, output: "timed out waiting for the element", metadata: { serial, selector, attempts } };
  }
};
