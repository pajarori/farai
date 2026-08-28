import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "./protocol";

export type HeuristicAction =
  | { kind: "respond"; text: string }
  | { kind: "tool"; tool: string; args: Record<string, unknown>; rationale: string };

export type HeuristicInput = {
  userText?: string | undefined;
  lastTool?: { tool: string; text: string } | undefined;
  compactedSummary?: string | undefined;
};

export function computeHeuristicActions(input: HeuristicInput): HeuristicAction[] {
  if (!input.userText) {
    return [{ kind: "respond", text: summarizeLastTool(input.lastTool) }];
  }
  const lower = input.userText.toLowerCase();
  const target = targetFromPrompt(input.userText);
  if (/(pentest|attack path|full enum|full enumeration|recon plan|plan.*scan|scan.*enumerate)/.test(lower)) {
    return [
      { kind: "tool", tool: "todo_add", args: { text: "Identify target and test assumptions", priority: "high" }, rationale: "Multi-step request needs an explicit task plan." },
      { kind: "tool", tool: "todo_add", args: { text: "Run reconnaissance and collect evidence", priority: "high" }, rationale: "Recon is the first active cyber step." },
      { kind: "tool", tool: "todo_add", args: { text: "Enumerate exposed services and web content", priority: "medium" }, rationale: "Enumeration follows initial recon." },
      { kind: "tool", tool: "todo_add", args: { text: "Summarize findings and next hypotheses", priority: "medium" }, rationale: "Keep progress durable for TUI and reports." }
    ];
  }
  if (/(subdomains?|passive[ -]?dns|certificate transparency|crt\.sh)/.test(lower) && target) {
    return [{ kind: "tool", tool: "subdomain_enum", args: { domain: target }, rationale: "enumerating passive subdomain sources" }];
  }
  if (/(nmap|scan|enumerate|recon)/.test(lower) && target) {
    return [{ kind: "tool", tool: "port_scan", args: { target }, rationale: "User requested recon/scan." }];
  }
  if (/(dir|directory|ffuf|gobuster)/.test(lower) && target) {
    return [{ kind: "tool", tool: "dir_enum", args: { url: `http://${target}/FUZZ` }, rationale: "User requested directory enumeration." }];
  }
  if (/(note|remember|catat)/.test(lower)) {
    return [{ kind: "tool", tool: "notes_add", args: { text: input.userText, tags: ["user"] }, rationale: "User asked to remember context." }];
  }
  if (/(report|writeup|finding)/.test(lower)) {
    return [{ kind: "respond", text: input.compactedSummary ?? "No summary available yet." }];
  }
  return [
    {
      kind: "respond",
      text: [
        "Freestyle ready.",
        "I can research, write helper code, run recon, collect evidence, and draft reports.",
        "Try: scan the target, enumerate web directories, write a helper script, save a note, or generate a report."
      ].join("\n")
    }
  ];
}

export function targetFromPrompt(text: string): string | undefined {
  const url = text.match(/https?:\/\/[^\s'"`<>]+/i)?.[0];
  if (url) {
    try { return new URL(url).hostname; } catch {  }
  }
  return text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0]
    ?? text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i)?.[0];
}

function summarizeLastTool(lastTool?: { tool: string; text: string }): string {
  if (!lastTool) return "Tool completed. No additional summary was recorded.";
  const lines = lastTool.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = lines[0] ?? "Tool completed.";
  return `${lastTool.tool} done. ${first}`;
}

export class HeuristicProvider implements ChatProvider {
  readonly name = "heuristic";
  readonly protocol = "heuristic" as const;

  async *stream(request: ChatRequest): AsyncIterable<ProviderStreamEvent> {
    const userText = lastUserText(request);
    const lastTool = lastToolResult(request);
    const actions = computeHeuristicActions({ userText, ...(lastTool ? { lastTool } : {}) });
    let index = 0;
    for (const action of actions) {
      if (action.kind === "respond") {
        yield { type: "text_delta", delta: action.text };
      } else {
        yield { type: "tool_call_complete", index: index++, id: "", name: action.tool, arguments: JSON.stringify(action.args) };
      }
    }
    yield { type: "message_complete", finishReason: "stop" };
  }
}

function lastUserText(request: ChatRequest): string | undefined {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (message?.role === "user") return message.text;
  }
  return undefined;
}

function lastToolResult(request: ChatRequest): { tool: string; text: string } | undefined {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (message?.role === "tool") return { tool: message.name, text: message.text };
  }
  return undefined;
}
