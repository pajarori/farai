import { setTimeout as delay } from "node:timers/promises";
import { classifyModelRetry, isContextOverflowError, MODEL_RETRY_MAX_ATTEMPTS, modelRetryDelayMs } from "../agent-core/provider/retry";
import { takeBytes } from "../agent-tools/shared/output-bound";
import type { ConversationEntry, PlannerAction, PlannerInput, PlannerProvider } from "../agent-core/provider";

const COMPACT_SUMMARY_MAX_BYTES = 48 * 1024;
const COMPACT_CHECKPOINT_MAX_BYTES = 16 * 1024;

const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

export const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export function compactPrompt(customInstructions?: string): string {
  const extra = customInstructions?.trim();
  return extra ? `${COMPACT_PROMPT}\n\nAdditional summary instructions:\n${extra}` : COMPACT_PROMPT;
}

export function formatCompactSummary(text: string): string {
  const withoutAnalysis = text
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    .replace(/<analysis>[\s\S]*$/gi, "")
    .trim();
  const summary = (withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1] ?? withoutAnalysis).trim();
  return summary.replace(/\n{3,}/g, "\n\n");
}

export function mergeCompactCheckpoint(summary: string, checkpoint: string): string {
  const retained = takeBytes(checkpoint.trim(), COMPACT_CHECKPOINT_MAX_BYTES, "head");
  if (!retained) return formatCompactSummary(summary);
  const separator = "\n\nRetained execution checkpoint:\n";
  return `${formatCompactSummary(summary)}${separator}${retained}`.trim();
}

export function compactActionsText(actions: PlannerAction[]): string {
  if (actions.some((action) => action.kind === "tool" || action.kind === "tool_parse_error")) {
    throw new Error("compaction model attempted tool use");
  }
  if (actions.some((action) => action.kind === "respond" && (action.truncated || action.recoverable))) {
    throw new Error("compaction model returned an incomplete summary");
  }
  const text = actions
    .filter((action): action is Extract<PlannerAction, { kind: "respond" }> => action.kind === "respond")
    .map((action) => action.text)
    .join("\n\n");
  if (/<analysis>/i.test(text) && !/<summary>[\s\S]*?<\/summary>/i.test(text)) {
    throw new Error("compaction model returned incomplete private analysis without a summary");
  }
  const summary = formatCompactSummary(text);
  if (Buffer.byteLength(summary, "utf8") > COMPACT_SUMMARY_MAX_BYTES) throw new Error("compaction model returned an oversized summary");
  if (!summary || /^planner error:/i.test(summary)) throw new Error("compaction model returned no valid summary");
  return summary;
}

export async function runModelCompaction(input: {
  planner: PlannerProvider;
  plannerInput: PlannerInput;
  customInstructions?: string;
  prompt?: string;
  signal?: AbortSignal;
}): Promise<string> {
  let history = structuredClone(input.plannerInput.history);
  const prompt = input.prompt ?? compactPrompt(input.customInstructions);
  let failedAttempts = 0;
  while (true) {
    if (input.signal?.aborted) throw new Error(`compaction cancelled: ${String(input.signal.reason ?? "aborted")}`);
    try {
      const actions = await input.planner.plan({
        ...input.plannerInput,
        userText: prompt,
        history: [...history, { role: "user", text: prompt }],
        tools: [],
        toolCatalog: [],
        toolChoice: "none"
      }, input.signal ? { signal: input.signal } : undefined);
      if (input.signal?.aborted) throw new Error(`compaction cancelled: ${String(input.signal.reason ?? "aborted")}`);
      return compactActionsText(actions);
    } catch (error) {
      if (input.signal?.aborted) throw new Error(`compaction cancelled: ${String(input.signal.reason ?? "aborted")}`);
      if (isContextOverflowError(error) && history.length > 0) {
        history = dropOldestItem(history);
        failedAttempts = 0;
        continue;
      }
      failedAttempts += 1;
      if (!classifyModelRetry(error).retryable || failedAttempts >= MODEL_RETRY_MAX_ATTEMPTS) throw error;
      await delay(modelRetryDelayMs(error, failedAttempts), undefined, input.signal ? { signal: input.signal } : undefined);
    }
  }
}

export function buildCompactedHistory(history: ConversationEntry[], summary: string, maxUserTokens = 20_000): Array<{ role: "user" | "context"; text: string }> {
  const retained: Array<{ role: "user" | "context"; text: string }> = [];
  let remaining = Math.max(0, maxUserTokens) * 4;
  for (const entry of [...history].reverse()) {
    if (entry.role !== "user" || remaining <= 0) continue;
    const bytes = Buffer.byteLength(entry.text, "utf8");
    if (bytes > remaining) {
      const left = Math.floor(remaining / 2);
      const removed = Math.ceil((bytes - remaining) / 4);
      const text = `${takeBytes(entry.text, left, "head")}…${removed} tokens truncated…${takeBytes(entry.text, remaining - left, "tail")}`;
      retained.push({ role: "user", text });
      break;
    }
    retained.push({ role: "user", text: entry.text });
    remaining -= bytes;
  }
  retained.reverse();
  retained.push({ role: "context", text: `${SUMMARY_PREFIX}\n${summary}` });
  return retained;
}

export function insertCompactionContext(history: ConversationEntry[], text: string): void {
  let index = history.length - 1;
  while (index >= 0 && history[index]?.role !== "user") index -= 1;
  history.splice(index >= 0 ? index : Math.max(0, history.length - 1), 0, { role: "context", text });
}

export function autoCompactThreshold(contextWindow: number, maxOutputTokens: number): number {
  return Math.max(1, Math.min(Math.floor(contextWindow * 0.9), contextWindow - maxOutputTokens));
}

function dropOldestItem(history: ConversationEntry[]): ConversationEntry[] {
  let index = 1;
  while (history[index]?.role === "tool") index += 1;
  return history.slice(index);
}
