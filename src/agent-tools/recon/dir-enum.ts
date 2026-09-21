import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { backend } from "../shared/backend";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { summarizeOrSpool } from "../shared/result-summary";
import { timeoutBackgroundResult } from "../shared/background-result";

export function summarizeFfufOutput(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { results?: Array<{ url?: string; status?: number; length?: number; words?: number; lines?: number; redirectlocation?: string }> };
    const results = filterWildcardResults(parsed.results ?? []);
    if (!results.length) return "no paths found";
    return results.map((r) => `${r.status ?? "?"} ${r.url ?? ""} (len=${r.length ?? "?"})`).join("\n");
  } catch {
    return raw.slice(0, 2_000);
  }
}

export function buildDirEnumCommand(url: string, wordlist: string, options: { timeoutSeconds?: number; threads?: number; rateLimit?: number; maxTimeSeconds?: number } = {}): string {
  if (!url.includes("FUZZ")) throw new Error("url must contain the FUZZ marker");
  const timeoutSeconds = Math.max(1, Math.min(30, Math.floor(options.timeoutSeconds ?? 3)));
  const threads = Math.max(1, Math.min(100, Math.floor(options.threads ?? 40)));
  const rateLimit = Math.max(0, Math.min(10_000, Math.floor(options.rateLimit ?? 0)));
  const maxTimeSeconds = Math.max(1, Math.min(120, Math.floor(options.maxTimeSeconds ?? 30)));
  return [
    'output="$(mktemp /tmp/farai-ffuf.XXXXXX)" || exit 1',
    'trap \'rm -f "$output"\' EXIT',
    `wordlist=${JSON.stringify(wordlist)}`,
    'for candidate in "$wordlist" /usr/share/wordlists/dirb/common.txt /usr/share/wordlists/dirbuster/directory-list-2.3-medium.txt /usr/share/dirb/wordlists/common.txt; do if [ -f "$candidate" ]; then wordlist="$candidate"; break; fi; done',
    'if [ ! -f "$wordlist" ]; then echo "no wordlist found; install seclists or pass an existing wordlist path" >&2; exit 2; fi',
    `ffuf -u ${JSON.stringify(url)} -w "$wordlist" -t ${threads} -timeout ${timeoutSeconds} -maxtime ${maxTimeSeconds} -ac -ach${rateLimit ? ` -rate ${rateLimit}` : ""} -o "$output" -of json -noninteractive >/dev/null`,
    'status=$?',
    'if [ -s "$output" ]; then cat "$output"; fi',
    'exit "$status"'
  ].join("\n");
}

export const dirEnumTool: ToolDefinition = {
  name: "web_directory",
  description: "Run bounded web content discovery with ffuf against a URL containing the FUZZ marker. The tool applies request timeout, thread, rate, and wall-clock budgets; use command_run only for custom matchers, filters, recursion, headers, or multiple injection points.",
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string" },
      wordlist: { type: "string" },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 30 },
      threads: { type: "integer", minimum: 1, maximum: 100 },
      rateLimit: { type: "integer", minimum: 0, maximum: 10_000 },
      maxTimeSeconds: { type: "integer", minimum: 1, maximum: 120 }
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: Number.POSITIVE_INFINITY,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const url = asString(args.url, "url");
    const wordlist = typeof args.wordlist === "string" ? args.wordlist : "/usr/share/wordlists/dirb/common.txt";
    const maxTimeSeconds = typeof args.maxTimeSeconds === "number" && Number.isInteger(args.maxTimeSeconds) ? Math.max(1, Math.min(120, args.maxTimeSeconds)) : 30;
    const options: { timeoutSeconds?: number; threads?: number; rateLimit?: number; maxTimeSeconds: number } = { maxTimeSeconds };
    if (typeof args.timeoutSeconds === "number") options.timeoutSeconds = args.timeoutSeconds;
    if (typeof args.threads === "number") options.threads = args.threads;
    if (typeof args.rateLimit === "number") options.rateLimit = args.rateLimit;
    const command = buildDirEnumCommand(url, wordlist, options);
    const kali = backend(context);
    const result = await kali.exec(command, maxTimeSeconds * 1_000 + 5_000, context.signal, 8_000_000);
    const converted = timeoutBackgroundResult("web_directory", kali, result);
    if (converted) return converted;
    return summarizeOrSpool(context, {
      title: "directory enumeration",
      raw: result.stdout.trim() ? result.stdout : result.stderr,
      ok: result.exitCode === 0 && !result.timedOut,
      summarize: summarizeFfufOutput
    });
  }
};

function filterWildcardResults<T extends { status?: number; length?: number; words?: number; lines?: number; redirectlocation?: string }>(results: T[]): T[] {
  if (results.length < 6) return results;
  const counts = new Map<string, number>();
  for (const result of results) {
    const signature = [result.status, result.length, result.words, result.lines, result.redirectlocation ?? ""].join("|");
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  const wildcard = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  if (!wildcard || wildcard[1] / results.length < 0.8) return results;
  return results.filter((result) => [result.status, result.length, result.words, result.lines, result.redirectlocation ?? ""].join("|") !== wildcard[0]);
}
