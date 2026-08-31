import type { ModelChoiceInfo } from "../agent-core/model-choices";
import type { CommandContext } from "./command-registry";
import { listCommands, type Command } from "./command-registry";
import type { TuiStoreValue } from "./context/store";
import type { DialogOption } from "./dialog/fuzzy";
import type { OverlayFrame } from "./store";
import { sessionDisplayName } from "../session-title";
import type { AgentThreadSummary } from "./runtime-port";

export type ModelChoice =
  | { kind: "model_provider"; providerID: string }
  | { kind: "model_action"; action: "add" }
  | { kind: "model"; model: string; providerID?: string; contextWindow?: number; maxOutputTokens?: number };
export type McpChoice =
  | { kind: "mcp_server"; serverID: string }
  | { kind: "mcp_detail"; serverID: string; itemID: string }
  | { kind: "mcp_action"; action: "add" };
export type EmailChoice =
  | { kind: "email"; emailId: string; persistent: boolean }
  | { kind: "email_action"; action: "add" };
export type OverlayOptionValue = Command | string | ModelChoice | McpChoice | EmailChoice | AgentThreadSummary;

export function overlayOptions(frame: OverlayFrame | undefined, tui: TuiStoreValue, ctx: CommandContext): DialogOption<OverlayOptionValue>[] {
  if (!frame) return [];
  switch (frame.kind) {
    case "palette":
      return listCommands({ ctx }).map((cmd): DialogOption<OverlayOptionValue> => ({
        id: cmd.name,
        title: cmd.title,
        description: cmd.desc ?? "",
        category: cmd.category,
        footer: cmd.keybind ?? cmd.slashName ?? "",
        value: cmd
      }));
    case "sessions":
      return tui.store.sessions.slice(0, 100).map((session) => ({
        id: session.id,
        title: sessionDisplayName(session),
        description: [
          session.parentId ? "child session" : "main session",
          session.model ?? "default model",
          session.workspace
        ].join(" · "),
        category: sessionCategory(Boolean(session.archivedAt), Boolean(tui.store.ui.sessionStats[session.id]?.running)),
        footer: compactStats(
          tui.store.ui.sessionStats[session.id]?.evidenceCount ?? 0,
          tui.store.ui.sessionStats[session.id]?.findingCount ?? 0,
          tui.store.ui.sessionStats[session.id]?.todoCount ?? 0
        ),
        value: session.id
      }));
    case "agents":
      return tui.store.ui.agentThreads
        .map((item) => ({
          id: item.id,
          title: item.title,
          description: item.role === "main"
            ? ["main thread", item.model].filter(Boolean).join(" · ")
            : [item.lane ?? "general", item.mode, item.model].filter(Boolean).join(" · "),
          category: item.role === "main" ? "main" : agentCategory(item.status),
          footer: item.sessionId === tui.store.activeSessionId ? "current" : agentStatusLabel(item.status),
          value: item
        }));
    case "evidence":
      return tui.store.snapshot.evidence.map((item) => ({
        id: item.id,
        title: item.title,
        description: `${item.source} · ${item.summary.split("\n")[0] ?? ""}`,
        footer: new Date(item.createdAt).toLocaleString(),
        value: item.id
      }));
    case "findings":
      return tui.store.snapshot.findings.map((item) => ({
        id: item.id,
        title: item.title,
        description: `${item.severity} · ${item.target}`,
        category: item.severity,
        footer: `${item.evidenceIds.length} evidence`,
        value: item.id
      }));
    case "memory":
      return tui.store.snapshot.memory.map((item) => ({
        id: item.id,
        title: item.key,
        description: item.kind,
        category: item.kind,
        footer: new Date(item.updatedAt).toLocaleString(),
        value: item.id
      }));
    case "model": {
      const session = tui.store.snapshot.session;
      if (tui.store.ui.availableModels.length === 0 && tui.store.ui.statusDetail === "loading models") {
        return [{ id: "model-loading", title: "loading models…", description: "fetching providers and model metadata", category: "model", disabled: true, value: "" }];
      }
      const providers = [...new Set(tui.store.ui.availableModels.map(modelProviderID))];
      if (!frame.providerID) return [
        ...modelProviderOptions(tui.store.ui.availableModels, session?.model),
        {
          id: "model-action-add-provider",
          title: "+ add provider",
          description: "connect an openai-compatible, anthropic, local, or routed endpoint",
          numbered: false,
          separatorBefore: true,
          value: { kind: "model_action", action: "add" }
        }
      ];
      const providerID = frame.providerID ?? providers[0];
      return modelOptions(tui.store.ui.availableModels, providerID, session?.model);
    }
    case "mcp": {
      const statuses = tui.store.ui.mcpStatuses;
      const statusByName = new Map(statuses.map((status) => [status.name, status]));
      if (frame.serverID) {
        const server = tui.store.ui.mcpServers.find((item) => item.id === frame.serverID);
        if (!server) return [{
          id: "mcp-server-missing",
          title: "server unavailable",
          description: `${frame.serverID} is no longer configured`,
          disabled: true,
          numbered: false,
          value: ""
        }];
        const status = statusByName.get(server.id);
        return mcpDetailOptions(server, status);
      }
      const servers = [
        ...tui.store.ui.mcpServers.filter((server) => !server.backbone).map((server) => {
          const status = statusByName.get(server.id);
          const state = status ? mcpServerState(status) : server.enabled ? "stopped" : "disabled";
          const endpoint = server.transport === "http" ? server.url ?? "" : [server.command, ...server.args].join(" ");
          const endpointLabel = endpoint === server.id ? undefined : endpoint;
          return {
            id: `mcp-${server.id}`,
            title: server.id,
            description: status?.error
              ? `error · ${status.error}`
              : [state, `${status?.toolCount ?? 0} tools`, `${status?.prompts.length ?? 0} prompts`, server.transport, endpointLabel, status?.cached ? "cached catalog" : undefined].filter(Boolean).join(" · "),
            value: { kind: "mcp_server" as const, serverID: server.id }
          };
        }),
        {
          id: "mcp-action-add",
          title: "+ add server",
          description: "connect a stdio or streamable http mcp server",
          numbered: false,
          separatorBefore: true,
          value: { kind: "mcp_action" as const, action: "add" as const }
        }
      ];
      if (servers.length > 1 || !tui.store.ui.mcpStatusError) return servers;
      return [{
        id: "mcp-error",
        title: "mcp refresh failed",
        description: tui.store.ui.mcpStatusError,
        disabled: true,
        numbered: false,
        value: ""
      }, ...servers];
    }
    case "email": {
      const session = tui.store.snapshot.session;
      const configured = tui.store.ui.emailAccounts.map((account) => ({
        id: `email-${account.id}`,
        title: account.label,
        description: [account.address, account.provider, account.credentialConfigured ? "ready" : "credential needed", account.id].join(" · "),
        badge: emailRole(session, account.id),
        value: { kind: "email" as const, emailId: account.id, persistent: true }
      }));
      const temporary = tui.store.snapshot.disposableInboxes.map((inbox) => ({
        id: `email-${inbox.id}`,
        title: inbox.label ?? "temporary email",
        description: [inbox.address, inbox.provider, inbox.status, inbox.id].join(" · "),
        badge: emailRole(session, inbox.id),
        value: { kind: "email" as const, emailId: inbox.id, persistent: false }
      }));
      return [
        ...configured,
        ...temporary,
        {
          id: "email-action-add",
          title: "+ add email",
          description: "connect a read-only imap account",
          numbered: false,
          separatorBefore: configured.length + temporary.length > 0,
          value: { kind: "email_action" as const, action: "add" as const }
        }
      ];
    }
    default:
      return [];
  }
}

function emailRole(session: TuiStoreValue["store"]["snapshot"]["session"], emailId: string): string {
  return [
    session?.emailPrimaryId === emailId ? "primary" : undefined,
    session?.emailSecondaryId === emailId ? "secondary" : undefined
  ].filter(Boolean).join(" · ");
}

function mcpDetailOptions(
  server: TuiStoreValue["store"]["ui"]["mcpServers"][number],
  status: TuiStoreValue["store"]["ui"]["mcpStatuses"][number] | undefined
): DialogOption<OverlayOptionValue>[] {
  const auth = status?.authStatus === "bearer_token"
    ? "bearer token"
    : status?.authStatus === "oauth"
      ? "oauth"
      : status?.authStatus === "not_logged_in"
        ? "not logged in"
        : server.transport === "stdio"
          ? "unsupported"
          : server.auth;
  const value = (itemID: string): McpChoice => ({ kind: "mcp_detail", serverID: server.id, itemID });
  const tools = status?.toolDetails?.length
    ? status.toolDetails.map((tool) => tool.name)
    : status?.tools ?? [];
  const prompts = status?.prompts.map((prompt) => {
    const args = prompt.arguments.map((argument) => `${argument.name}${argument.required ? "" : "?"}`).join(" ");
    return `${prompt.title ?? prompt.name}${args ? ` (${args})` : ""}`;
  }) ?? [];
  const resources = status?.resources.map((resource) => `${resource.title ?? resource.name} (${resource.uri})`) ?? [];
  const templates = status?.resourceTemplates.map((template) => `${template.title ?? template.name} (${template.uriTemplate})`) ?? [];
  return [
    { id: `mcp-detail-${server.id}-auth`, title: "auth", description: auth, numbered: false, value: value("auth") },
    { id: `mcp-detail-${server.id}-tools`, title: `tools (${tools.length})`, description: tools.join(", ") || (status?.cached ? "cached catalog is empty" : "test or start the server to load its catalog"), numbered: false, value: value("tools") },
    { id: `mcp-detail-${server.id}-prompts`, title: `prompts (${prompts.length})`, description: prompts.join(", ") || "none", numbered: false, value: value("prompts") },
    { id: `mcp-detail-${server.id}-resources`, title: `resources (${resources.length})`, description: resources.join(", ") || "none", numbered: false, value: value("resources") },
    { id: `mcp-detail-${server.id}-templates`, title: `resource templates (${templates.length})`, description: templates.join(", ") || "none", numbered: false, value: value("templates") }
  ];
}

function sessionCategory(archived: boolean, running: boolean): "archived" | "running" | "recent" {
  if (archived) return "archived";
  return running ? "running" : "recent";
}

function agentCategory(status: AgentThreadSummary["status"]): "active" | "completed" | "stopped" {
  if (["created", "starting", "running", "cancelling"].includes(status)) return "active";
  if (status === "succeeded") return "completed";
  return "stopped";
}

function agentStatusLabel(status: AgentThreadSummary["status"]): string {
  if (status === "created") return "queued";
  if (status === "succeeded") return "completed";
  return status;
}

function modelOptions(choices: ModelChoiceInfo[], providerID: string | undefined, sessionModel: string | undefined): DialogOption<OverlayOptionValue>[] {
  return choices
    .filter((choice) => !providerID || modelProviderID(choice) === providerID)
    .map((choice) => ({
      id: `model-${choice.id}`,
      title: choice.label ?? choice.model,
      description: compactModelChoiceDescription(choice),
      category: "model",
      footer: sessionModel === choice.model ? "current" : "",
      value: {
        kind: "model" as const,
        model: choice.model,
        ...(choice.providerID ? { providerID: choice.providerID } : {}),
        ...(choice.contextWindow ? { contextWindow: choice.contextWindow } : {}),
        ...(choice.maxOutputTokens ? { maxOutputTokens: choice.maxOutputTokens } : {})
      }
    }));
}

function modelProviderOptions(choices: ModelChoiceInfo[], sessionModel: string | undefined): DialogOption<OverlayOptionValue>[] {
  const groups = new Map<string, ModelChoiceInfo[]>();
  for (const choice of choices) {
    const providerID = modelProviderID(choice);
    groups.set(providerID, [...(groups.get(providerID) ?? []), choice]);
  }
  return [...groups.entries()].map(([providerID, providerChoices]) => {
    const freeCount = providerChoices.filter((choice) => choice.free).length;
    const readyCount = providerChoices.filter((choice) => choice.verified).length;
    const current = providerChoices.some((choice) => choice.model === sessionModel);
    const first = providerChoices[0];
    return {
      id: `model-provider-${providerID}`,
      title: providerID,
      description: [
        `${providerChoices.length} models`,
        freeCount ? `${freeCount} free` : undefined,
        readyCount ? `${readyCount} ready` : undefined,
        first?.baseUrl
      ].filter(Boolean).join(" · "),
      footer: current ? "current" : "",
      value: { kind: "model_provider" as const, providerID }
    };
  });
}

function modelProviderID(choice: ModelChoiceInfo): string {
  if (choice.providerID) return choice.providerID;
  const separator = choice.model.indexOf(":");
  return separator > 0 ? choice.model.slice(0, separator) : "default";
}

function compactModelChoiceDescription(choice: ModelChoiceInfo): string {
  if (choice.free) return "free";
  if (!choice.checked) return "unreachable";
  if (choice.verified) return "ready";
  return "not found";
}

function mcpServerState(status: { enabled: boolean; running: boolean; startupState?: string; error?: string }): "disabled" | "running" | "starting" | "stopped" {
  if (!status.enabled) return "disabled";
  if (status.running || status.startupState === "ready") return "running";
  if (status.startupState === "starting" && !status.error) return "starting";
  return "stopped";
}

function compactStats(evidence: number, findings: number, todos: number): string {
  return `${evidence}e ${findings}f ${todos}t`;
}

export function overlayTitle(frame: OverlayFrame): string {
  if (frame.kind === "mcp" && frame.serverID) return `mcp · ${frame.serverID}`;
  switch (frame.kind) {
    case "palette": return "command palette";
    case "sessions": return "resume conversation";
    case "evidence": return "evidence";
    case "findings": return "findings";
    case "memory": return "memory";
    case "agents": return "agents";
    case "model": return "select model";
    case "mcp": return "mcp servers";
    case "email": return "email";
  }
}
