import { takeBytes } from "../../agent-tools/shared/output-bound";
import type { ConversationEntry } from "../provider";

export function ensureToolResultsPaired(entries: ConversationEntry[]): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  let open: Array<{ id: string; tool: string }> = [];
  const flushOpen = () => {
    for (const { id, tool } of open) {
      out.push({ role: "tool", toolCallId: id, tool, text: "[no result recorded]" });
    }
    open = [];
  };
  for (const entry of entries) {
    if (entry.role === "assistant") {
      flushOpen();
      out.push(entry);
      open = (entry.toolCalls ?? []).map((call) => ({ id: call.id, tool: call.tool }));
    } else if (entry.role === "tool") {
      open = open.filter((pending) => pending.id !== entry.toolCallId);
      out.push(entry);
    } else {
      flushOpen();
      out.push(entry);
    }
  }
  flushOpen();
  return out;
}

export function fitToolResultText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "\n...[middle truncated — full output saved as an artifact; read it with tool_output_read]...\n";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  const headBytes = Math.floor(budget * 0.6);
  const tailBytes = budget - headBytes;
  return `${takeBytes(text, headBytes, "head")}${marker}${takeBytes(text, tailBytes, "tail")}`;
}

export function nonEmpty(lines: string[]): string[] {
  return lines.length > 0 ? lines : ["- none"];
}
