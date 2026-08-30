import { rememberModelSelection } from "../../agent-core/model-catalog";
import type { Command, CommandContext } from "../command-registry";
import type { TuiStoreValue } from "../context/store";
import type { McpChoice, ModelChoice } from "../overlay-options";
import type { AgentThreadSummary, TuiRuntimePort } from "../runtime-port";
import type { OverlayKind } from "./router";
import type { OverlaySelection } from "./overlay-selection";
import type { SessionOwner } from "./center-surface-controller";
import { createControllerOperations } from "./controller-operation";

type OverlayControllerInput = {
  tui: TuiStoreValue;
  port: TuiRuntimePort;
  selection: OverlaySelection;
  commandContext(): CommandContext;
  captureOwner(): SessionOwner | undefined;
  owns(owner: SessionOwner): boolean;
  openModelProvider(): void;
  openMcpServer(): void;
  rememberModel?(model: string, options: Parameters<typeof rememberModelSelection>[1]): Promise<void>;
};

export function createOverlayController(input: OverlayControllerInput) {
  const { tui, port, selection } = input;
  const modelOperations = createControllerOperations(tui);
  let modelSelectionPending = false;

  function reset(): void {
    modelOperations.invalidate();
    modelSelectionPending = false;
  }

  async function open(kind: OverlayKind): Promise<void> {
    tui.actions.overlayOpen(kind);
    if (kind !== "sessions") return;
    try {
      await tui.refreshSessions();
    } catch (error) {
      if (tui.store.ui.overlayStack.at(-1)?.kind === "sessions") {
        tui.actions.errorSet(error instanceof Error ? error.message : String(error));
      }
    }
  }

  function toggleAgentPreview(): void {
    const frame = tui.store.ui.overlayStack.at(-1);
    if (frame?.kind !== "agents") return;
    const option = selection.selectedOption();
    if (option) tui.actions.agentDetailToggle(option.id);
  }

  async function select(): Promise<void> {
    const frame = tui.store.ui.overlayStack.at(-1);
    if (!frame || !("query" in frame)) return;
    const option = selection.selectedOption();
    if (!option) return;
    switch (frame.kind) {
      case "palette":
        tui.actions.overlayPop();
        await (option.value as Command).run(input.commandContext());
        return;
      case "sessions":
        tui.actions.overlayClear();
        await tui.selectSession(String(option.value));
        return;
      case "agents":
        tui.actions.overlayClear();
        await tui.selectSession((option.value as AgentThreadSummary).sessionId);
        return;
      case "evidence": {
        const item = tui.store.snapshot.evidence.find((candidate) => candidate.id === option.value);
        if (item) {
          const metadata = [
            `source: ${item.source}`,
            item.path ? `path: ${item.path}` : undefined,
            item.createdAt ? `captured: ${item.createdAt}` : undefined
          ].filter((value): value is string => Boolean(value));
          tui.actions.centerSurfaceReplaceTop({
            kind: "detail",
            title: item.title,
            body: [...metadata, "", "## evidence", item.summary || "no evidence summary recorded"].join("\n")
          });
        }
        return;
      }
      case "findings": {
        const item = tui.store.snapshot.findings.find((candidate) => candidate.id === option.value);
        if (item) tui.actions.centerSurfaceReplaceTop({
          kind: "detail",
          title: `${item.severity.toLowerCase()} · ${item.title}`,
          body: [
            `target: ${item.target || "not recorded"}`,
            item.status ? `status: ${item.status}` : undefined,
            `evidence: ${item.evidenceIds.length} linked item${item.evidenceIds.length === 1 ? "" : "s"}`,
            "",
            "## impact",
            item.impact || "not recorded",
            "",
            "## reproduction",
            item.reproduction || "not recorded",
            "",
            "## remediation",
            item.remediation || "not recorded"
          ].filter((value): value is string => value !== undefined).join("\n")
        });
        return;
      }
      case "memory": {
        const item = tui.store.snapshot.memory.find((candidate) => candidate.id === option.value);
        if (item) tui.actions.centerSurfaceReplaceTop({ kind: "detail", title: `${item.kind} · ${item.key}`, body: memoryDetailBody(item.value) });
        return;
      }
      case "mcp": {
        const choice = option.value as McpChoice;
        if (choice.kind === "mcp_detail") return;
        if (choice.kind === "mcp_action") {
          input.openMcpServer();
          return;
        }
        const server = tui.store.ui.mcpServers.find((item) => item.id === choice.serverID);
        if (server) tui.actions.overlayPush({ kind: "mcp", serverID: server.id, query: "", index: 0 });
        return;
      }
      case "model": {
        const choice = option.value as ModelChoice;
        if (choice.kind === "model_action") {
          input.openModelProvider();
          return;
        }
        if (choice.kind === "model_provider") {
          tui.actions.overlayPush({ kind: "model", providerID: choice.providerID, query: "", index: 0 });
          return;
        }
        const owner = input.captureOwner();
        if (!owner || choice.kind !== "model" || modelSelectionPending) return;
        modelSelectionPending = true;
        const operation = modelOperations.begin(`switching to ${choice.model}`);
        try {
          await port.updateSession(owner.sessionId, { model: choice.model });
          if (!modelOperations.owns(operation) || !input.owns(owner)) return;
          await (input.rememberModel ?? rememberModelSelection)(choice.model, {
            workspace: tui.store.workspace,
            ...(choice.providerID ? { providerID: choice.providerID } : {}),
            ...(choice.contextWindow ? { contextWindow: choice.contextWindow } : {}),
            ...(choice.maxOutputTokens ? { maxOutputTokens: choice.maxOutputTokens } : {})
          });
          if (!modelOperations.owns(operation) || !input.owns(owner)) return;
          await tui.refreshSnapshot();
          if (!modelOperations.owns(operation) || !input.owns(owner)) return;
          await tui.refreshSessions();
          if (!modelOperations.owns(operation) || !input.owns(owner)) return;
          if (tui.store.ui.overlayStack.at(-1) !== frame) return;
          modelOperations.finish(operation, `model: ${choice.model}`, 2_000);
          tui.actions.overlayClear();
        } finally {
          if (modelOperations.owns(operation)) modelSelectionPending = false;
          modelOperations.finish(operation);
        }
        return;
      }
    }
  }

  return {
    reset,
    open,
    pop: () => tui.actions.overlayPop(),
    move: (delta: number) => tui.actions.overlayMove(delta, selection.count()),
    setIndex: (index: number) => tui.actions.overlaySetIndex(index, selection.count()),
    toggleAgentPreview,
    appendQuery: (char: string) => tui.actions.overlayAppendQuery(char),
    backspaceQuery: () => tui.actions.overlayBackspaceQuery(),
    select
  };
}

function memoryDetailBody(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  } catch {
    return String(value);
  }
}
