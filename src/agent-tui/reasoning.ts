import { normalizeReasoningSummary } from "../agent-core/reasoning-summary";

const BOLD_TITLE_PATTERN = /^\*\*([^*\n]+)\*\*\s*\n?\n?/;

export function parseReasoning(text: string): { title: string; body: string } {
  const trimmed = normalizeReasoningSummary(text);
  if (!trimmed) return { title: "reasoning", body: "" };
  const match = trimmed.match(BOLD_TITLE_PATTERN);
  if (match) {
    const title = match[1]!.trim();
    const body = trimmed.slice(match[0].length).trimEnd();
    return { title, body };
  }
  const [firstLine = "", ...rest] = trimmed.split("\n");
  return { title: firstLine.trim() || "reasoning", body: rest.join("\n").trim() };
}
