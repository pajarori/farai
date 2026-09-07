const INTERNAL_META_PREFIX = /^(?:the user\b|user (?:asked|wants|requested|said)\b|per (?:my|the)\b|my (?:communication|instructions?|rules?|task)\b|according to (?:my|the)\b|there(?:'s| is) no (?:dedicated|specific|matching) tool\b|i have access to\b|let me (?:inspect|check|search) (?:the )?available tools?\b|the (?:background )?(?:agent|subagent) (?:is (?:running|still running|done)|has (?:completed|finished|returned)|completed|finished|returned)\b)/i;
const INTERNAL_META_REFERENCE = /\b(?:system prompt|developer message|communication rules|policy says|per instructions|available tools? list|tool catalog says)\b/i;
const INTERNAL_SELF_REPORT = /^(?:i|we) (?:should|will|need to|must|can) (?:report|respond|reply|tell|inform|acknowledge|summarize)\b/i;
export type SeparatedReasoning = {
  visibleText: string;
  reasoningText: string;
  pendingTag?: string;
};

const EMBEDDED_REASONING_TAGS = ["think", "thinking", "analysis", "reasoning", "thought", "reflection", "chain_of_thought"] as const;
const CHANNEL_REASONING_NAMES = new Set(["analysis", "thinking", "reasoning", "thought", "reflection"]);
const CHANNEL_MARKER = /(?:<\|start\|>assistant\s*)?<\|channel\|>\s*(analysis|thinking|reasoning|thought|reflection|final|commentary|tool)\s*<\|message\|>/gi;
const CONTROL_MARKER = /<\|(?:end|eot_id|eom_id|endoftext)\|>/gi;

export function separateEmbeddedReasoning(text: string): SeparatedReasoning {
  const normalized = text.replace(CONTROL_MARKER, "");
  const channel = separateChannelReasoning(normalized);
  if (channel) {
    const visible = separateTaggedReasoning(channel.visibleText);
    const privateText = separateTaggedReasoning(channel.reasoningText);
    const pending = visible.pendingTag ?? privateText.pendingTag;
    return {
      visibleText: visible.visibleText,
      reasoningText: [channel.reasoningText, visible.reasoningText, privateText.reasoningText].filter(Boolean).join("\n\n"),
      ...(pending || channel.pendingTag ? { pendingTag: pending ?? channel.pendingTag } : {})
    };
  }
  const pendingChannel = findPendingChannelMarker(normalized);
  if (pendingChannel) {
    return { visibleText: normalized.slice(0, -pendingChannel.length).trimEnd(), reasoningText: "", pendingTag: pendingChannel };
  }
  return separateTaggedReasoning(normalized);
}

function separateChannelReasoning(text: string): { visibleText: string; reasoningText: string; pendingTag?: string } | undefined {
  CHANNEL_MARKER.lastIndex = 0;
  const first = CHANNEL_MARKER.exec(text);
  if (!first) return undefined;
  const visible: string[] = [];
  const reasoning: string[] = [];
  let cursor = 0;
  let privateChannel = false;
  CHANNEL_MARKER.lastIndex = 0;
  let marker: RegExpExecArray | null;
  while ((marker = CHANNEL_MARKER.exec(text)) !== null) {
    const before = text.slice(cursor, marker.index).replace(CONTROL_MARKER, "");
    if (before) (privateChannel ? reasoning : visible).push(before);
    privateChannel = CHANNEL_REASONING_NAMES.has(marker[1]!.toLowerCase());
    cursor = marker.index + marker[0].length;
  }
  const tail = text.slice(cursor).replace(CONTROL_MARKER, "");
  if (tail) (privateChannel ? reasoning : visible).push(tail);
  const pendingTag = findPendingChannelMarker(text.slice(cursor));
  return {
    visibleText: visible.join(""),
    reasoningText: reasoning.join("").trim(),
    ...(pendingTag ? { pendingTag } : {})
  };
}

function findPendingChannelMarker(text: string): string | undefined {
  const start = text.lastIndexOf("<|");
  if (start < 0) return undefined;
  const suffix = text.slice(start);
  const candidate = [
    "<|channel|>",
    "<|channel|>analysis",
    "<|channel|>thinking",
    "<|channel|>reasoning",
    "<|channel|>thought",
    "<|channel|>reflection",
    "<|channel|>final",
    "<|channel|>commentary",
    "<|channel|>tool",
    "<|channel|>analysis<|message|>",
    "<|channel|>thinking<|message|>",
    "<|channel|>reasoning<|message|>",
    "<|channel|>thought<|message|>",
    "<|channel|>reflection<|message|>",
    "<|channel|>final<|message|>",
    "<|channel|>commentary<|message|>",
    "<|channel|>tool<|message|>"
  ];
  return candidate.some((value) => value.startsWith(suffix) || suffix.startsWith(value)) ? suffix : undefined;
}

function separateTaggedReasoning(text: string): SeparatedReasoning {
  const opening = /<(think|thinking|analysis|reasoning|thought|reflection|chain_of_thought)\b[^>]*>/gi;
  const visible: string[] = [];
  const reasoning: string[] = [];
  let foundTag = false;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(text)) !== null) {
    foundTag = true;
    const before = text.slice(cursor, match.index);
    if (before) visible.push(before);
    const tag = match[1]!;
    const closing = new RegExp(`</${tag}\\s*>`, "ig");
    closing.lastIndex = opening.lastIndex;
    const end = closing.exec(text);
    if (!end) {
      const body = text.slice(opening.lastIndex);
      if (body.trim()) reasoning.push(body.trim());
      cursor = text.length;
      break;
    }
    const body = text.slice(opening.lastIndex, end.index);
    if (body.trim()) reasoning.push(body.trim());
    cursor = end.index + end[0].length;
    opening.lastIndex = cursor;
  }
  if (cursor < text.length) visible.push(text.slice(cursor));
  const pending = findPendingOpeningTag(visible.at(-1) ?? "");
  if (pending) {
    visible[visible.length - 1] = visible.at(-1)!.slice(0, -pending.length);
  }
  const visibleText = foundTag || pending
    ? visible.join("").trim()
    : text;
  const plain = separatePlainReasoning(visibleText);
  if (plain) {
    return {
      visibleText: plain.visibleText,
      reasoningText: [reasoning.join("\n\n"), plain.reasoningText].filter(Boolean).join("\n\n"),
      ...(pending ? { pendingTag: pending } : {})
    };
  }
  if (reasoning.length === 0) {
    return {
      visibleText,
      reasoningText: "",
      ...(pending ? { pendingTag: pending } : {})
    };
  }
  return {
    visibleText,
    reasoningText: reasoning.join("\n\n"),
    ...(pending ? { pendingTag: pending } : {})
  };
}

function separatePlainReasoning(text: string): { visibleText: string; reasoningText: string } | undefined {
  const prefix = /^\s*(?:thinking|thought|analysis|reasoning)\s*:\s*/i.exec(text);
  if (!prefix) return undefined;
  const rest = text.slice(prefix[0].length);
  const final = /(?:^|\n)\s*(?:final answer|final response|answer|response)\s*:\s*/i.exec(rest);
  if (!final) return undefined;
  const answer = rest.slice(final.index + final[0].length).trim();
  if (!answer) return undefined;
  return {
    visibleText: answer,
    reasoningText: rest.slice(0, final.index).trim()
  };
}

function findPendingOpeningTag(text: string): string | undefined {
  const opening = text.lastIndexOf("<");
  if (opening < 0) return undefined;
  const suffix = text.slice(opening);
  if (suffix.includes(">") || !/^<[a-z]*$/i.test(suffix)) return undefined;
  const name = suffix.slice(1).toLowerCase();
  if (!name || EMBEDDED_REASONING_TAGS.some((tag) => tag.startsWith(name))) return suffix;
  return undefined;
}

export function mergeReasoningText(...values: Array<string | undefined>): string {
  const merged: string[] = [];
  for (const value of values) {
    const text = value?.trim();
    if (!text) continue;
    if (merged.some((existing) => reasoningTextEqual(existing, text))) continue;
    merged.push(text);
  }
  return merged.join("\n\n");
}

export function reasoningTextEqual(left: string, right: string): boolean {
  return comparableReasoningText(left) === comparableReasoningText(right);
}

export function isReasoningDuplicate(content: string, reasoning: string): boolean {
  return stripReasoningEcho(content, reasoning).trim().length === 0;
}

export function stripReasoningEcho(content: string, reasoning: string): string {
  const visible = content.trim();
  const privateText = reasoning.trim();
  if (!visible || !privateText) return content;
  if (reasoningTextEqual(visible, privateText)) return "";
  if (visible.startsWith(privateText)) return visible.slice(privateText.length).trimStart();
  if (privateText.startsWith(visible) && visible.length >= 32) return "";
  return content;
}

export function isReasoningPrefix(content: string, reasoning: string): boolean {
  const visible = content.trim();
  const privateText = reasoning.trim();
  return visible.length >= 3 && privateText.length > visible.length && privateText.startsWith(visible);
}

function comparableReasoningText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

export function isInternalMetaReasoning(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const visible = trimmed.replace(/^\*\*([^*\n]+)\*\*\s*/, "$1 ").slice(0, 500);
  return INTERNAL_META_PREFIX.test(visible) || INTERNAL_META_REFERENCE.test(visible) || INTERNAL_SELF_REPORT.test(visible);
}

export function normalizeReasoningSummary(text: string): string {
  const trimmed = text.trim();
  return isInternalMetaReasoning(trimmed) ? "" : trimmed;
}

export function sanitizeVisibleResponse(text: string): string {
  const separated = separateEmbeddedReasoning(text);
  return stripReasoningEcho(separated.visibleText, mergeReasoningText(separated.reasoningText)).trim();
}
