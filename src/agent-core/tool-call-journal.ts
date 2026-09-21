import type { ToolCallRecord, ToolErrorCategory } from "../types";
import { SqliteStore } from "../agent-store/sqlite-store";
import { id } from "../utils";
import { classifyToolError } from "./tool-error-category";

export type ToolErrorState = {
  interrupted?: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  quarantined?: boolean;
  reason?: string;
  summary?: string;
  diagnostic?: string;
  category?: ToolErrorCategory;
};

type ToolJournalEvent = (
  sessionId: string,
  type: "tool_call" | "tool_started" | "error",
  payload: Record<string, unknown>
) => void;

export class ToolCallJournal {
  constructor(
    private readonly store: SqliteStore,
    private readonly emit: ToolJournalEvent
  ) {}

  begin(input: {
    sessionId: string;
    tool: string;
    args: unknown;
    owner?: { turnId: string; messageId: string };
    providerToolCallId?: string;
  }): ToolCallRecord {
    const toolCall: ToolCallRecord = {
      id: id(),
      sessionId: input.sessionId,
      tool: input.tool,
      args: input.args,
      status: "pending",
      evidenceIds: [],
      ...(input.providerToolCallId ? { providerToolCallId: input.providerToolCallId } : {}),
      ...(input.owner ? { turnId: input.owner.turnId, messageId: input.owner.messageId } : {})
    };
    this.store.saveToolCall(toolCall);
    if (input.owner) {
      const part = this.store.addPart({
        sessionId: input.sessionId,
        turnId: input.owner.turnId,
        messageId: input.owner.messageId,
        type: "tool_call",
        payload: { record: toolCall }
      });
      toolCall.timelinePartId = part.id;
      this.store.saveToolCall(toolCall);
    }
    this.emit(input.sessionId, "tool_call", {
      id: toolCall.id,
      ...(input.providerToolCallId ? { providerToolCallId: input.providerToolCallId } : {}),
      tool: input.tool,
      args: input.args
    });
    return toolCall;
  }

  markRunning(toolCall: ToolCallRecord): ToolCallRecord {
    const running = { ...toolCall, status: "running" as const };
    const saved = this.store.saveToolCall(running);
    this.sync(saved);
    if (saved.status === "running") this.emit(saved.sessionId, "tool_started", { toolCallId: saved.id, tool: saved.tool, args: saved.args });
    return saved;
  }

  settleError(toolCall: ToolCallRecord, error: string, state: ToolErrorState = {}, emitEvent = true): ToolCallRecord {
    const summary = state.summary ?? error;
    const diagnostic = state.diagnostic ?? error;
    const errorCategory = state.category ?? classifyToolError({
      error: diagnostic,
      ...(state.cancelled !== undefined ? { cancelled: state.cancelled } : {}),
      ...(state.timedOut !== undefined ? { timedOut: state.timedOut } : {})
    });
    const payload = {
      toolCallId: toolCall.id,
      tool: toolCall.tool,
      error: summary,
      diagnostic,
      errorCategory,
      interrupted: state.interrupted ?? false,
      cancelled: state.cancelled ?? false,
      timedOut: state.timedOut ?? false,
      ...(state.quarantined !== undefined ? { quarantined: state.quarantined } : {}),
      ...(state.reason ? { reason: state.reason } : {})
    };
    const settled = this.store.settleToolCall(
      { ...toolCall, status: "error", terminalSummary: summary, diagnostic, errorCategory },
      { type: "error", payload }
    ).toolCall;
    if (emitEvent) {
      try { this.emit(toolCall.sessionId, "error", payload); } catch {  }
    }
    return settled;
  }

  settleRecoveredSuccess(toolCall: ToolCallRecord, summary: string): ToolCallRecord {
    return this.store.settleToolCall(
      { ...toolCall, status: "done", terminalSummary: summary },
      { type: "tool_result", payload: { toolCallId: toolCall.id, tool: toolCall.tool, result: `status: done\nsummary: ${summary}` } }
    ).toolCall;
  }

  private sync(toolCall: ToolCallRecord): void {
    if (!toolCall.timelinePartId) return;
    this.store.updatePartPayload(toolCall.timelinePartId, { record: toolCall });
  }
}
