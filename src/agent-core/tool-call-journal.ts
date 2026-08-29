import type { ToolCallRecord } from "../types";
import { SqliteStore } from "../agent-store/sqlite-store";
import { id } from "../utils";

export type ToolErrorState = {
  interrupted?: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  quarantined?: boolean;
  reason?: string;
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
    this.store.saveToolCall(running);
    this.sync(running);
    this.emit(running.sessionId, "tool_started", { toolCallId: running.id, tool: running.tool, args: running.args });
    return running;
  }

  settleError(toolCall: ToolCallRecord, error: string, state: ToolErrorState = {}, emitEvent = true): ToolCallRecord {
    const payload = {
      toolCallId: toolCall.id,
      tool: toolCall.tool,
      error,
      interrupted: state.interrupted ?? false,
      cancelled: state.cancelled ?? false,
      timedOut: state.timedOut ?? false,
      ...(state.quarantined !== undefined ? { quarantined: state.quarantined } : {}),
      ...(state.reason ? { reason: state.reason } : {})
    };
    const settled = this.store.settleToolCall(
      { ...toolCall, status: "error" },
      { type: "error", payload }
    ).toolCall;
    if (emitEvent) {
      try { this.emit(toolCall.sessionId, "error", payload); } catch {  }
    }
    return settled;
  }

  settleRecoveredSuccess(toolCall: ToolCallRecord, summary: string): ToolCallRecord {
    return this.store.settleToolCall(
      { ...toolCall, status: "done" },
      { type: "tool_result", payload: { toolCallId: toolCall.id, tool: toolCall.tool, result: `status: done\nsummary: ${summary}` } }
    ).toolCall;
  }

  private sync(toolCall: ToolCallRecord): void {
    if (!toolCall.timelinePartId) return;
    this.store.updatePartPayload(toolCall.timelinePartId, { record: toolCall });
  }
}
