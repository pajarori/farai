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
  | { kind: "model"; model: string; providerID?: string; contextWindow?: number; maxOutputTokens?: number };
export type OverlayOptionValue = Command | string | ModelChoice | AgentThreadSummary;

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
      if (!frame.providerID && providers.length > 1) return modelProviderOptions(tui.store.ui.availableModels, session?.model);
      const providerID = frame.providerID ?? providers[0];
      return modelOptions(tui.store.ui.availableModels, providerID, session?.model);
    }
    case "mcp": {
      const statuses = tui.store.ui.mcpStatuses;
      if (tui.store.ui.mcpStatusError) {
        return [{
          id: "mcp-error",
          title: "mcp refresh failed",
          description: tui.store.ui.mcpStatusError,
          category: "mcp",
          disabled: true,
          value: ""
        }];
      }
      if (statuses.length === 0) {
        return [{
          id: "mcp-loading",
          title: tui.store.ui.statusDetail === "refreshing mcp" || tui.store.ui.statusDetail === "starting mcp" ? "loading mcp servers…" : "no mcp servers configured",
          description: "",
          category: "mcp",
          disabled: true,
          value: ""
        }];
      }
      return statuses.map((status) => {
        const state = mcpServerState(status);
        const proxy = status.proxy ? ` · proxy ${status.proxy.running ? `127.0.0.1:${status.proxy.port}` : "stopped"}` : "";
        return {
          id: `mcp-${status.name}`,
          title: status.name,
          description: status.error ? `error: ${status.error}` : `${status.command}${proxy}`,
          category: state,
          footer: `${status.toolCount} tools`,
          value: status.name
        };
      });
    }
    default:
      return [];
  }
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
      category: "provider",
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

export function overlayTitle(kind: OverlayFrame["kind"]): string {
  switch (kind) {
    case "palette": return "command palette";
    case "sessions": return "resume conversation";
    case "evidence": return "evidence";
    case "findings": return "findings";
    case "memory": return "memory";
    case "agents": return "agents";
    case "model": return "select model";
    case "mcp": return "mcp servers";
  }
}
