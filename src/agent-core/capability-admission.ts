import type { Session, ToolDefinition } from "../types";
import { canonicalToolName } from "../tool-names";

export type CapabilitySelection = {
  direct: ToolDefinition[];
  deferred: ToolDefinition[];
  reasons: Record<string, string>;
};

const BRIDGE = new Set(["tool_search", "tool_invoke"]);
const ALWAYS = new Set([
  "shell_exec",
  "fs_read",
  "fs_grep",
  "skill_load",
  "session_rename",
  "todo_add",
  "todo_update",
  "todo_list"
]);
const CODING = new Set([
  "fs_list", "fs_write", "fs_edit", "patch_apply", "git_status", "git_diff", "code_write_script", "lsp_inspect"
]);
const RECON = new Set([
  "port_scan", "nmap_scan", "subdomain_enum", "dir_enum", "exploit_search", "kali_tool_search", "notes_add", "evidence_save"
]);
const BROWSER_KERNEL = [
  "browser_navigate",
  "browser_snapshot",
  "browser_find",
  "browser_click",
  "browser_fill_form",
  "browser_type",
  "browser_press_key",
  "browser_wait_for",
  "browser_tabs",
  "browser_network_requests",
  "browser_network_request"
] as const;
const CAMPAIGN = new Set([
  "campaign_asset", "campaign_observe", "campaign_hypothesis", "campaign_search",
  "campaign_next_action", "campaign_test", "campaign_verify", "report_add_finding"
]);
const CALLBACK = new Set(["callback_host_info", "callback_listen", "callback_oast", "callback_stop"]);
const BACKGROUND = new Set(["session_poll", "session_stop", "tool_output_read"]);

function matches(text: string, pattern: RegExp): boolean {
  return pattern.test(text.toLowerCase());
}

function exactToolMention(text: string, name: string): boolean {
  return canonicalToolName(text.toLowerCase()).includes(name.toLowerCase());
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

export function isBrowserFirstTask(session: Session, userText = ""): boolean {
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

export function rawHttpPlannerPolicyError(input: {
  session: Session;
  userText?: string;
  tool: string;
  args?: unknown;
}): string | undefined {
  if (!isBrowserFirstTask(input.session, input.userText) || isExplicitRawHttpTask(input.userText)) return undefined;
  const tool = canonicalToolName(input.tool);
  const args = input.args && typeof input.args === "object" && !Array.isArray(input.args)
    ? input.args as Record<string, unknown>
    : {};
  const deferredName = tool === "tool_invoke" ? canonicalToolName(String(args.name ?? "")) : "";
  const shellCommand = tool === "shell_exec" ? String(args.command ?? "") : "";
  const rawArgs = deferredName === "http_request" && args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
    ? args.arguments as Record<string, unknown>
    : args;
  const rawHttp = tool === "http_request"
    || deferredName === "http_request"
    || (tool === "shell_exec" && shellUsesAdHocHttp(shellCommand));
  if (!rawHttp) return undefined;
  if ((tool === "http_request" || deferredName === "http_request") && isDeliberateRawHttpArgs(rawArgs)) return undefined;
  if (tool === "shell_exec" && shellUsesExactProtocolHttp(shellCommand)) return undefined;
  return "Raw HTTP is blocked for ordinary web exploration. Use browser_navigate and browser network tools for normal application behavior. For an exact-path or protocol test that browser normalization would invalidate, use http_request with mode=protocol_test and the required pathAsIs or httpVersion option.";
}

function shellUsesAdHocHttp(command: string): boolean {
  return /(?:^|[\s;&|()])(?:curl|wget|httpie|xh)(?:\s|$)/i.test(command)
    || /\brequests\.(?:get|post|put|patch|delete|request)\s*\(/i.test(command)
    || /\burllib\.request\./i.test(command);
}

function isDeliberateRawHttpArgs(args: Record<string, unknown>): boolean {
  if (args.mode === "protocol_test" || args.mode === "scripted_test") return true;
  if (args.pathAsIs === true) return true;
  if (typeof args.httpVersion === "string" && args.httpVersion !== "auto") return true;
  return typeof args.url === "string" && hasExactProtocolPayload(args.url);
}

function shellUsesExactProtocolHttp(command: string): boolean {
  return shellUsesAdHocHttp(command) && (
    /--path-as-is|--http(?:1\.0|1\.1|2|3)(?:\s|$)|\b(?:raw http|protocol test)\b/i.test(command)
    || hasExactProtocolPayload(command)
  );
}

function hasExactProtocolPayload(value: string): boolean {
  return /(?:^|[/:])\.\.(?:[/?#]|$)|%(?:00|0a|0d|25|2e|2f|5c)/i.test(value);
}

function browserKernelOperation(name: string): string | undefined {
  return BROWSER_KERNEL.find((operation) => name === operation || name.endsWith(`_${operation}`));
}

function selectBrowserKernel(tools: ToolDefinition[]): ToolDefinition[] {
  const selected: ToolDefinition[] = [];
  for (const operation of BROWSER_KERNEL) {
    const candidates = tools
      .filter((tool) => browserKernelOperation(tool.name) === operation)
      .sort((left, right) => Number(right.name === operation) - Number(left.name === operation) || left.name.localeCompare(right.name));
    if (candidates[0]) selected.push(candidates[0]);
  }
  return selected;
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
    const direct = input.tools.filter((tool) => scope.has(tool.name)).sort((a, b) => a.name.localeCompare(b.name));
    return {
      direct,
      deferred: [],
      reasons: Object.fromEntries(direct.map((tool) => [tool.name, "explicit subagent scope"]))
    };
  }
  const text = input.userText ?? "";
  const coding = input.session.phase === "code_assist" || matches(text, /\b(code|coding|implement|refactor|bug|fix|test|typescript|javascript|python|golang|rust|file|repository|repo|build|typecheck)\b|\.(ts|tsx|js|jsx|py|go|rs)\b/);
  const recon = ["recon", "enumeration", "hypothesis", "verification", "exploit_lab", "post_exploit_lab"].includes(input.session.phase)
    || hasAssessmentIntent(text)
    || containsNetworkTarget(text)
    || matches(text, /\b(port|http|https|url|domain|endpoint|directory|nmap)\b/);
  const callback = matches(text, /\b(reverse shell|callback|listener|lhost|oast|out.of.band|ssrf|xxe)\b/);
  const campaign = Boolean(input.session.campaignId);
  const browserFirst = isBrowserFirstTask(input.session, text);
  const rawHttp = isExplicitRawHttpTask(text);
  const selected = new Set<string>(ALWAYS);
  const reasons: Record<string, string> = {};

  for (const name of ALWAYS) reasons[name] = "kernel capability";
  if (!input.session.parentId) {
    selected.add("agent_task");
    reasons.agent_task = "root session delegation";
  }
  if (coding) for (const name of CODING) { selected.add(name); reasons[name] = "coding task"; }
  if (recon) for (const name of RECON) { selected.add(name); reasons[name] = "recon task"; }
  if (browserFirst) {
    for (const tool of selectBrowserKernel(input.tools)) {
      selected.add(tool.name);
      reasons[tool.name] = "browser-first web task";
    }
  }
  if (rawHttp) {
    selected.add("http_request");
    reasons.http_request = "explicit raw HTTP scripting, testing, fuzzing, or protocol task";
  }
  if (campaign) for (const name of CAMPAIGN) { selected.add(name); reasons[name] = "active campaign"; }
  if (campaign && input.session.phase === "verification") {
    selected.add("campaign_dispatch");
    reasons["campaign_dispatch"] = "campaign verification";
  }
  if (!campaign && recon) {
    selected.add("campaign_create");
    reasons["campaign_create"] = "campaign can be initialized for assessment work";
  }
  if (callback) for (const name of CALLBACK) { selected.add(name); reasons[name] = "callback or OOB task"; }
  if (input.hasActiveJobs || input.hasOutputArtifacts) {
    for (const name of BACKGROUND) { selected.add(name); reasons[name] = "active or retrievable tool output"; }
  }

  for (const tool of input.tools) {
    if (tool.name === "http_request" && !rawHttp) continue;
    if (exactToolMention(text, tool.name)) {
      selected.add(tool.name);
      reasons[tool.name] = "explicit tool mention";
    }
  }

  if (input.invokedTools?.length) {
    const invoked = new Set(input.invokedTools.map(canonicalToolName));
    for (const tool of input.tools) {
      if (BRIDGE.has(tool.name) || selected.has(tool.name) || !invoked.has(tool.name)) continue;
      selected.add(tool.name);
      reasons[tool.name] = "used earlier this session";
    }
  }

  const direct = input.tools.filter((tool) => selected.has(tool.name) && !BRIDGE.has(tool.name));
  const deferred = input.tools.filter((tool) => !selected.has(tool.name) && !BRIDGE.has(tool.name));
  if (deferred.length > 0) {
    for (const bridge of input.tools.filter((tool) => BRIDGE.has(tool.name))) {
      direct.push(bridge);
      reasons[bridge.name] = `${deferred.length} capabilities deferred`;
    }
  }
  direct.sort((a, b) => a.name.localeCompare(b.name));
  deferred.sort((a, b) => a.name.localeCompare(b.name));
  return { direct, deferred, reasons };
}

export function toolSchemaTokens(tools: ToolDefinition[]): number {
  const payload = tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema }));
  return Math.max(0, Math.ceil(Buffer.byteLength(JSON.stringify(payload), "utf8") / 4));
}
