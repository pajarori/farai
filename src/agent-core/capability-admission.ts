import type { Session, ToolDefinition } from "../types";
import { canonicalToolName } from "../tool-names";

export type CapabilitySelection = {
  direct: ToolDefinition[];
  deferred: ToolDefinition[];
  reasons: Record<string, string>;
};

function matches(text: string, pattern: RegExp): boolean {
  return pattern.test(text.toLowerCase());
}

function containsNetworkTarget(text: string): boolean {
  return /https?:\/\/|\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})(?::\d{1,5})?\b|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/i.test(text);
}

function containsHostnameTarget(text: string): boolean {
  return /\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})(?::\d{1,5})?\b/i.test(text);
}

function hasAssessmentIntent(text: string): boolean {
  return matches(text, /\b(audit|assess(?:ment)?|security[ -]?(?:audit|test(?:ing)?)|pentest|scan|target|host|ctf|vulnerability|vuln|exploit|enumerat(?:e|ion)|recon|uji keamanan|cek keamanan|periksa keamanan)\b/);
}

export function isInteractiveWebTask(session: Session, userText = ""): boolean {
  const text = userText.toLowerCase();
  const assessmentPhase = ["recon", "enumeration", "hypothesis", "verification", "exploit_lab", "post_exploit_lab"].includes(session.phase);
  const hostnameTarget = containsHostnameTarget(text);
  const networkTarget = containsNetworkTarget(text);
  const explicitWebTarget = /https?:\/\//i.test(text);
  const explicitHttpService = networkTarget && matches(text, /\bhttps?\b/);
  const browserOperation = matches(text, /\b(web(?:site|app)?|site|browser|playwright|camoufox|page|halaman|situs|login|sign[ -]?in|form|dashboard|cookie|redirect|javascript|dom|frontend|endpoint|api)\b/);
  const interactiveOperation = explicitWebTarget || explicitHttpService || browserOperation;
  const interactiveWebIntent = explicitWebTarget || interactiveOperation;
  const passiveInfrastructure = isPassiveInfrastructureTask(text) && !browserOperation;
  const assessmentIntent = hasAssessmentIntent(text) && (hostnameTarget || (networkTarget && interactiveWebIntent)) && !passiveInfrastructure;
  const codingOnly = matches(text, /\b(code|coding|implement|refactor|bug|fix|unit test|typecheck|repository|repo|parser)\b|\.(ts|tsx|js|jsx|py|go|rs)\b/)
    && !matches(text, /https?:\/\/|\b(browser|playwright|camoufox|page|login|form|dashboard|cookie|redirect|javascript|dom|frontend)\b/);
  return !passiveInfrastructure && !codingOnly && (assessmentIntent || interactiveWebIntent || (assessmentPhase && interactiveWebIntent));
}

export function isPassiveInfrastructureTask(userText = ""): boolean {
  return matches(userText, /\b(subdomains?|passive[ -]?dns|certificate transparency|\bct logs?\b|crt\.sh|asset[ -]?(?:discovery|enumeration)|dns[ -]?(?:recon|enumeration)|enumerat(?:e|ion)\s+(?:dns|subdomains?))\b/);
}

export function isExplicitRawHttpTask(userText = ""): boolean {
  const text = userText.toLowerCase();
  const negatedClient = /\b(?:do not|don't|never|avoid|jangan|tanpa)\b[^\n]{0,48}\b(?:http_request|curl|wget|httpie|xh)\b/.test(text);
  if (!negatedClient && /\b(?:http_request|curl|wget|httpie|xh)\b/.test(text)) return true;
  if (/\b(?:raw http|wire format|request smuggling|response splitting|http\/1\.[01]|http\/2|http\/3|exact protocol|protocol verification)\b/.test(text)) return true;
  if (/\b(?:ffuf|fuzz(?:er|ing)?|wordlist|brute[ -]?force|load test|benchmark)\b/.test(text)) return true;
  return /\b(?:script|scripting|automate|repeatable|regression|integration test|api test|testing)\b/.test(text)
    && /\b(?:http|https|api|request|response|endpoint)\b/.test(text);
}

export function selectCapabilities(input: {
  session: Session;
  tools: ToolDefinition[];
  userText?: string;
  hasActiveJobs?: boolean;
  hasOutputArtifacts?: boolean;
  invokedTools?: string[];
}): CapabilitySelection {
  if (input.session.toolScope?.length) {
    const scope = new Set(input.session.toolScope.map(canonicalToolName));
    const direct = input.tools.filter((tool) => scope.has(canonicalToolName(tool.name))).sort((a, b) => a.name.localeCompare(b.name));
    return {
      direct,
      deferred: [],
      reasons: Object.fromEntries(direct.map((tool) => [tool.name, "explicit subagent scope"]))
    };
  }
  const direct = [...input.tools].sort((a, b) => a.name.localeCompare(b.name));
  return {
    direct,
    deferred: [],
    reasons: Object.fromEntries(direct.map((tool) => [tool.name, "available session capability"]))
  };
}

export function toolSchemaTokens(tools: ToolDefinition[]): number {
  const payload = tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema }));
  return Math.max(0, Math.ceil(Buffer.byteLength(JSON.stringify(payload), "utf8") / 4));
}
