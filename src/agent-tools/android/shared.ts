import type { BackendExecResult } from "../backends/types";
import type { ToolContext } from "../../types";
import { backend } from "../shared/backend";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function adbUnavailable(result: Pick<BackendExecResult, "exitCode" | "stderr">): boolean {
  return result.exitCode === 127 || /adb: not found|command not found/i.test(result.stderr);
}

export function compactError(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.slice(0, 400) || "adb command produced no error output";
}

export async function runAdb(context: ToolContext, argline: string, timeoutMs: number, maxBytes = 2_000_000): Promise<BackendExecResult> {
  return backend(context).exec(argline, timeoutMs, context.signal, maxBytes);
}

export async function runAdbChecked(context: ToolContext, argline: string, timeoutMs: number, maxBytes = 2_000_000): Promise<BackendExecResult> {
  const result = await runAdb(context, argline, timeoutMs, maxBytes);
  if (adbUnavailable(result)) throw new Error("adb is not available in the container");
  return result;
}

const ADB_SERVER_ENV = ["ADB_SERVER_SOCKET", "ANDROID_ADB_SERVER_ADDRESS", "ANDROID_ADB_SERVER_PORT"] as const;

export function adbEnvPrefix(): string {
  const parts = ADB_SERVER_ENV
    .filter((name) => (process.env[name] ?? "").trim())
    .map((name) => `${name}=${shellQuote(process.env[name]!.trim())}`);
  return parts.length ? `${parts.join(" ")} ` : "";
}

export function adbBase(): string {
  return `${adbEnvPrefix()}adb`;
}

export function adbPrefix(serial: string | undefined): string {
  const trimmed = serial?.trim();
  return trimmed ? `${adbBase()} -s ${shellQuote(trimmed)}` : adbBase();
}

export type AdbDevice = { serial: string; state: string; model?: string; product?: string };

export function parseDevices(stdout: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^List of devices/i.test(trimmed)) continue;
    const [serial, state, ...rest] = trimmed.split(/\s+/);
    if (!serial || !state) continue;
    const meta = rest.join(" ");
    const model = /\bmodel:(\S+)/.exec(meta)?.[1];
    const product = /\bproduct:(\S+)/.exec(meta)?.[1];
    devices.push({ serial, state, ...(model ? { model } : {}), ...(product ? { product } : {}) });
  }
  return devices;
}

export async function resolveDevice(context: ToolContext, serial: unknown, timeoutMs = 15_000): Promise<string> {
  const provided = typeof serial === "string" ? serial.trim() : "";
  if (provided) return provided;
  const result = await runAdbChecked(context, `${adbBase()} devices -l`, timeoutMs);
  const online = parseDevices(result.stdout).filter((device) => device.state === "device");
  if (online.length === 0) throw new Error("no android device is connected; use android_connect to attach one over tcp/ip");
  if (online.length > 1) throw new Error(`multiple devices connected (${online.map((device) => device.serial).join(", ")}); pass the serial argument`);
  return online[0]!.serial;
}
