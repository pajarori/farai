import type { ToolContext, ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { backend } from "../shared/backend";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { compactError, shellQuote } from "./shared";

const DANGEROUS_PERMISSIONS = new Set([
  "android.permission.READ_SMS", "android.permission.SEND_SMS", "android.permission.RECEIVE_SMS",
  "android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS",
  "android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_BACKGROUND_LOCATION",
  "android.permission.RECORD_AUDIO", "android.permission.CAMERA",
  "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE", "android.permission.MANAGE_EXTERNAL_STORAGE",
  "android.permission.READ_PHONE_STATE", "android.permission.READ_CALL_LOG", "android.permission.WRITE_CALL_LOG",
  "android.permission.REQUEST_INSTALL_PACKAGES", "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.QUERY_ALL_PACKAGES", "android.permission.WRITE_SETTINGS"
]);

const SECRET_PATTERN = [
  "AKIA[0-9A-Z]{16}",
  "AIza[0-9A-Za-z_-]{35}",
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
  "(api[_-]?key|secret|passwd|password|token|bearer)[\"'\\s:=]{1,4}[A-Za-z0-9_.-]{8,}",
  "https://[a-z0-9-]+\\.firebaseio\\.com"
].join("|");

function quoteDir(value: string): string {
  const clean = value.trim();
  if (!clean || clean.includes("..")) throw new Error("directory must be a workspace-relative path without ..");
  return clean;
}

export const androidDecompileTool: ToolDefinition = {
  name: "android_decompile",
  description: "Decompile an apk with apktool into smali, decoded resources, and a readable AndroidManifest.xml. Returns the output directory to pass to the other android static tools.",
  inputSchema: {
    type: "object",
    required: ["apkPath"],
    properties: {
      apkPath: { type: "string", description: "workspace-relative path to the apk to decompile" }
    },
    additionalProperties: false
  },
  mutates: true,
  timeoutMs: 240_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const apkPath = asString(args.apkPath, "apkPath").trim();
    const base = apkPath.split("/").pop()?.replace(/\.apk$/i, "") || "app";
    const outDir = `android/decompiled/${base}`;
    const result = await backend(context).exec(`apktool d -f -o ${shellQuote(outDir)} ${shellQuote(apkPath)}`, 240_000, context.signal, 2_000_000);
    if (result.exitCode === 127) throw new Error("apktool is not available in the container");
    const ok = result.exitCode === 0;
    return {
      ok,
      summary: ok ? `decompiled to ${outDir}` : `apktool failed on ${apkPath}`,
      output: ok ? `output directory: ${outDir}\n${result.stdout}`.trim() : compactError(result.stderr || result.stdout),
      metadata: { apkPath, directory: outDir }
    };
  }
};

async function readManifest(context: ToolContext, dir: string): Promise<string> {
  const result = await backend(context).exec(`cat ${shellQuote(`${dir}/AndroidManifest.xml`)}`, 20_000, context.signal, 4_000_000);
  if (result.exitCode !== 0) throw new Error(`could not read AndroidManifest.xml in ${dir}; decompile with android_decompile first`);
  return result.stdout;
}

export const androidManifestTool: ToolDefinition = {
  name: "android_manifest",
  description: "Read and summarize AndroidManifest.xml from a decompiled apk directory: package, sdk versions, debuggable/allowBackup flags, and permission and component counts.",
  inputSchema: {
    type: "object",
    required: ["directory"],
    properties: { directory: { type: "string", description: "decompiled apk directory from android_decompile" } },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 30_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const dir = quoteDir(asString(args.directory, "directory"));
    const xml = await readManifest(context, dir);
    const pkg = /package="([^"]+)"/.exec(xml)?.[1] ?? "unknown";
    const debuggable = /android:debuggable="true"/.test(xml);
    const allowBackup = !/android:allowBackup="false"/.test(xml);
    const permissions = [...xml.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map((match) => match[1]!);
    const counts = {
      activities: (xml.match(/<activity[\s>]/g) ?? []).length,
      services: (xml.match(/<service[\s>]/g) ?? []).length,
      receivers: (xml.match(/<receiver[\s>]/g) ?? []).length,
      providers: (xml.match(/<provider[\s>]/g) ?? []).length
    };
    const output = [
      `package: ${pkg}`,
      `debuggable: ${debuggable}`,
      `allowBackup: ${allowBackup}`,
      `permissions: ${permissions.length}`,
      `components: activity=${counts.activities} service=${counts.services} receiver=${counts.receivers} provider=${counts.providers}`
    ].join("\n");
    return {
      ok: true,
      summary: `${pkg}${debuggable ? " [debuggable]" : ""}${allowBackup ? " [allowBackup]" : ""}`,
      output,
      metadata: { package: pkg, debuggable, allowBackup, permissions, counts }
    };
  }
};

export const androidPermissionsTool: ToolDefinition = {
  name: "android_permissions",
  description: "List declared permissions from a decompiled apk and flag dangerous ones (sms, contacts, location, storage, install-packages, overlay, etc).",
  inputSchema: {
    type: "object",
    required: ["directory"],
    properties: { directory: { type: "string", description: "decompiled apk directory from android_decompile" } },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 30_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const dir = quoteDir(asString(args.directory, "directory"));
    const xml = await readManifest(context, dir);
    const permissions = [...xml.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map((match) => match[1]!).sort();
    const dangerous = permissions.filter((name) => DANGEROUS_PERMISSIONS.has(name));
    const output = permissions.length
      ? permissions.map((name) => `${dangerous.includes(name) ? "[!] " : "    "}${name}`).join("\n")
      : "no permissions declared";
    return {
      ok: true,
      summary: `${permissions.length} permission(s), ${dangerous.length} dangerous`,
      output,
      metadata: { permissions, dangerous }
    };
  }
};

export const androidExportedComponentsTool: ToolDefinition = {
  name: "android_exported_components",
  description: "List exported components (activity, service, receiver, provider) from a decompiled apk. Exported components are reachable by other apps and are a primary attack surface.",
  inputSchema: {
    type: "object",
    required: ["directory"],
    properties: { directory: { type: "string", description: "decompiled apk directory from android_decompile" } },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 30_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const dir = quoteDir(asString(args.directory, "directory"));
    const xml = await readManifest(context, dir);
    const exported: Array<{ kind: string; name: string; explicit: boolean }> = [];
    for (const kind of ["activity", "activity-alias", "service", "receiver", "provider"]) {
      const regex = new RegExp(`<${kind}\\b[^>]*?(?:/>|>[\\s\\S]*?</${kind}>)`, "g");
      for (const match of xml.matchAll(regex)) {
        const block = match[0];
        const name = /android:name="([^"]+)"/.exec(block)?.[1] ?? "(unknown)";
        const explicitExport = /android:exported="true"/.test(block);
        const implicitExport = !/android:exported="false"/.test(block) && /<intent-filter/.test(block);
        if (explicitExport || implicitExport) exported.push({ kind, name, explicit: explicitExport });
      }
    }
    const output = exported.length
      ? exported.map((item) => `${item.kind}\t${item.explicit ? "exported=true" : "intent-filter"}\t${item.name}`).join("\n")
      : "no exported components found";
    return {
      ok: true,
      summary: `${exported.length} exported component(s)`,
      output,
      metadata: { exported }
    };
  }
};

export const androidScanSecretsTool: ToolDefinition = {
  name: "android_scan_secrets",
  description: "Scan a decompiled apk directory for hardcoded secrets: aws/google api keys, private keys, jwts, and password/token assignments. Matches are candidate leads, not confirmed findings.",
  inputSchema: {
    type: "object",
    required: ["directory"],
    properties: {
      directory: { type: "string", description: "decompiled apk directory from android_decompile" },
      limit: { type: "integer", minimum: 1, maximum: 1_000, description: "maximum matching lines to return (default 200)" }
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 90_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const dir = quoteDir(asString(args.directory, "directory"));
    const limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? Math.max(1, Math.min(1_000, args.limit)) : 200;
    const command = `grep -rEIn ${shellQuote(SECRET_PATTERN)} ${shellQuote(dir)} 2>/dev/null | head -n ${limit}`;
    const result = await backend(context).exec(command, 90_000, context.signal, 2_000_000);
    const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    return {
      ok: true,
      summary: lines.length ? `${lines.length} secret candidate line(s)` : "no secret candidates matched",
      output: lines.length ? lines.join("\n") : "no matches",
      metadata: { directory: dir, matches: lines.length, truncated: lines.length >= limit }
    };
  }
};

export const androidGrepApkTool: ToolDefinition = {
  name: "android_grep_apk",
  description: "Regex-search a decompiled apk directory (smali, resources, assets). Use for urls, class names, string constants, and crypto usage after android_decompile.",
  inputSchema: {
    type: "object",
    required: ["directory", "pattern"],
    properties: {
      directory: { type: "string", description: "decompiled apk directory from android_decompile" },
      pattern: { type: "string", description: "extended regular expression to search for" },
      limit: { type: "integer", minimum: 1, maximum: 1_000, description: "maximum matching lines to return (default 200)" }
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 90_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const dir = quoteDir(asString(args.directory, "directory"));
    const pattern = asString(args.pattern, "pattern");
    const limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? Math.max(1, Math.min(1_000, args.limit)) : 200;
    const command = `grep -rEIn ${shellQuote(pattern)} ${shellQuote(dir)} 2>/dev/null | head -n ${limit}`;
    const result = await backend(context).exec(command, 90_000, context.signal, 2_000_000);
    const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    return {
      ok: true,
      summary: lines.length ? `${lines.length} match(es) for /${pattern}/` : `no matches for /${pattern}/`,
      output: lines.length ? lines.join("\n") : "no matches",
      metadata: { directory: dir, pattern, matches: lines.length, truncated: lines.length >= limit }
    };
  }
};
