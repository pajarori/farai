const INTERNAL_META_PREFIX = /^(?:the user\b|user (?:asked|wants|requested|said)\b|per (?:my|the)\b|my (?:communication|instructions?|rules?|task)\b|according to (?:my|the)\b|the tool search\b|tool_search\b|there(?:'s| is) no (?:dedicated|specific|matching) tool\b|i have access to\b|let me (?:inspect|check|search) (?:the )?available tools?\b|the (?:background )?(?:agent|subagent) (?:is (?:running|still running|done)|has (?:completed|finished|returned)|completed|finished|returned)\b)/i;
const INTERNAL_META_REFERENCE = /\b(?:system prompt|developer message|communication rules|policy says|per instructions|available tools? list|tool catalog says)\b/i;
const INTERNAL_SELF_REPORT = /^(?:i|we) (?:should|will|need to|must|can) (?:report|respond|reply|tell|inform|acknowledge|summarize)\b/i;

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
