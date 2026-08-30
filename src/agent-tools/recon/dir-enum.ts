import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { backend } from "../shared/backend";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { summarizeOrSpool } from "../shared/result-summary";
import { timeoutBackgroundResult } from "../shared/background-result";

export function summarizeFfufOutput(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { results?: Array<{ url?: string; status?: number; length?: number }> };
    const results = parsed.results ?? [];
    if (!results.length) return "no paths found";
    return results.map((r) => `${r.status ?? "?"} ${r.url ?? ""} (len=${r.length ?? "?"})`).join("\n");
  } catch {
    return raw.slice(0, 2_000);
  }
}

export function buildDirEnumCommand(url: string, wordlist: string): string {
  return [
    'output="$(mktemp /tmp/farai-ffuf.XXXXXX)" || exit 1',
    'trap \'rm -f "$output"\' EXIT',
    `ffuf -u ${JSON.stringify(url)} -w ${JSON.stringify(wordlist)} -o "$output" -of json -noninteractive >/dev/null`,
    'status=$?',
    'if [ -s "$output" ]; then cat "$output"; fi',
    'exit "$status"'
  ].join("\n");
}

export const dirEnumTool: ToolDefinition = {
  name: "dir_enum",
  description: "Enumerate hidden web paths with ffuf against a URL containing the FUZZ marker, using a supplied wordlist or the default common directory list. Use this for content discovery on an authorized target; use shell_exec when custom ffuf matchers, filters, recursion, headers, or multiple injection points are required.",
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: { url: { type: "string" }, wordlist: { type: "string" } }
  },
  mutates: false,
  timeoutMs: 300_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const url = asString(args.url, "url");
    const wordlist = typeof args.wordlist === "string" ? args.wordlist : "/usr/share/wordlists/dirb/common.txt";
    const command = buildDirEnumCommand(url, wordlist);
    const kali = backend(context);
    const result = await kali.exec(command);
    const converted = timeoutBackgroundResult("dir_enum", kali, result);
    if (converted) return converted;
    return summarizeOrSpool(context, {
      title: "directory enumeration",
      raw: result.stdout.trim() ? result.stdout : result.stderr,
      ok: result.exitCode === 0 && !result.timedOut,
      summarize: summarizeFfufOutput
    });
  }
};
