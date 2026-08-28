import { takeBytes } from "../../agent-tools/shared/output-bound";
import type { ConversationEntry, PlannerAction, PlannerInput, PlannerProvider } from "../provider";

const COMPACT_SUMMARY_MAX_BYTES = 48 * 1024;
const COMPACT_RESERVED_OUTPUT_TOKENS = 20_000;
const COMPACT_MAX_RETRIES = 3;
export const AUTO_COMPACT_MAX_FAILURES = 3;
export const MANUAL_COMPACT_MIN_TOKENS = 2_000;

const COMPACT_PROMPT = `Respond with text only. Do not call tools.

Create a detailed continuation summary of the conversation. Preserve:
1. The user's primary requests, explicit instructions, corrections, and all steering messages.
2. Important technical concepts, architecture, decisions, constraints, and model/provider details.
3. Files, symbols, commands, edits, and code patterns needed to continue accurately.
4. Tool outcomes, evidence, findings, credentials, flags, background jobs, and failed attempts.
5. Errors encountered and how they were fixed.
6. Open todos, blockers, current work, and the exact next useful action.
7. Every user message that changes intent or requirements.

Return only the final self-contained continuation summary. Do not include private analysis, XML tags, preambles, or commentary about preparing the summary.`;

export function compactPrompt(customInstructions?: string): string {
  const extra = customInstructions?.trim();
  return extra ? `${COMPACT_PROMPT}\n\nAdditional summary instructions:\n${extra}` : COMPACT_PROMPT;
}

export function formatCompactSummary(text: string): string {
  const taggedSummary = text.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1];
  const withoutAnalysis = text
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    .replace(/<analysis>[\s\S]*$/gi, "")
    .replace(/<\/?summary>/gi, "")
    .trim();
  const summary = (taggedSummary ?? withoutAnalysis).trim();
  return takeBytes(summary.replace(/\n{3,}/g, "\n\n"), COMPACT_SUMMARY_MAX_BYTES, "head");
}

export function compactActionsText(actions: PlannerAction[]): string {
  if (actions.some((action) => action.kind === "tool" || action.kind === "tool_parse_error")) {
    throw new Error("compaction model attempted tool use");
  }
  const text = actions
    .filter((action): action is Extract<PlannerAction, { kind: "respond" }> => action.kind === "respond")
    .map((action) => action.text)
    .join("\n\n");
  if (/<analysis>/i.test(text) && !/<summary>[\s\S]*?<\/summary>/i.test(text)) {
    throw new Error("compaction model returned incomplete private analysis without a summary");
  }
  const summary = formatCompactSummary(text);
  if (!summary || /^planner error:/i.test(summary)) throw new Error("compaction model returned no valid summary");
  return summary;
}

export async function runModelCompaction(input: {
  planner: PlannerProvider;
  plannerInput: PlannerInput;
  customInstructions?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const history = input.plannerInput.history;
  let current = history;
  let lastError: unknown;
  for (let attempt = 0; attempt < COMPACT_MAX_RETRIES; attempt += 1) {
    const compactInput: PlannerInput = {
      ...input.plannerInput,
      userText: "compact",
      systemInstruction: compactPrompt(input.customInstructions),
      history: [
        ...(attempt > 0 ? [{ role: "user" as const, text: "[internal compaction note: earlier conversation was truncated to fit the summary request; this is not a user-authored message]" }] : []),
        ...current
      ],
      toolChoice: "none"
    };
    try {
      return compactActionsText(await input.planner.plan(compactInput, input.signal ? { signal: input.signal } : undefined));
    } catch (error) {
      lastError = error;
      if (!isPromptTooLong(error) || current.length < 4) throw error;
      current = dropOldestRound(current);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "compaction failed"));
}

export function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4));
}

export function autoCompactThreshold(contextWindow: number, maxOutputTokens: number): number {
  const reservedOutput = Math.min(maxOutputTokens, COMPACT_RESERVED_OUTPUT_TOKENS);
  const effective = Math.max(1, contextWindow - reservedOutput);
  const safety = Math.min(13_000, Math.max(1, Math.floor(contextWindow * 0.15)));
  return Math.max(1, effective - safety);
}

function isPromptTooLong(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /prompt.*too long|context.*(length|window|limit)|too many tokens/i.test(message);
}

function dropOldestRound(history: ConversationEntry[]): ConversationEntry[] {
  let index = history.findIndex((entry, current) => current > 0 && entry.role === "user");
  if (index <= 0) index = Math.max(1, Math.floor(history.length * 0.2));
  const next = history.slice(index);
  while (next[0]?.role === "tool") next.shift();
  return next.length > 0 ? next : history.slice(-1);
}
