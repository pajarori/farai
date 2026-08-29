import type { PendingSteerInput, QueuedUserInput, SessionMailboxItem } from "../types";
import { id } from "../utils";
import { SessionMailbox } from "./session-mailbox";

export type QueuedInputAction = QueuedUserInput["action"];

type InputQueueEvent = (
  sessionId: string,
  type: "mailbox_queued" | "mailbox_consumed",
  payload: Record<string, unknown>
) => void;

/** Owns durable user-input admission and classification on top of the generic mailbox. */
export class SessionInputQueue {
  private readonly scheduledPromptIds = new Set<string>();

  constructor(
    private readonly mailbox: SessionMailbox,
    private readonly emit: InputQueueEvent
  ) {}

  schedulePrompt(sessionId: string, text: string): SessionMailboxItem {
    const item = this.mailbox.enqueue({
      sessionId,
      kind: "user",
      payload: { text, inputMode: "turn" },
      triggerPolicy: "queue",
      dedupeKey: `prompt:${id()}`
    });
    this.scheduledPromptIds.add(item.id);
    return item;
  }

  finishScheduledPrompt(id: string): void {
    this.scheduledPromptIds.delete(id);
  }

  isScheduledPrompt(id: string): boolean {
    return this.scheduledPromptIds.has(id);
  }

  enqueueSteer(sessionId: string, text: string): PendingSteerInput | undefined {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    const item = this.mailbox.enqueue({
      sessionId,
      kind: "user",
      payload: { text: trimmed, inputMode: "steer" },
      triggerPolicy: "interrupt",
      dedupeKey: `steer:${id()}`
    });
    this.emit(sessionId, "mailbox_queued", {
      mailboxId: item.id,
      kind: item.kind,
      sequence: item.sequence,
      inputMode: "steer"
    });
    return pendingSteerInput(item);
  }

  enqueueFollowup(
    sessionId: string,
    text: string,
    action: QueuedInputAction = queuedInputAction(text),
    dedupeKey = `queued-input:${id()}`
  ): QueuedUserInput | undefined {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    const item = this.mailbox.enqueue({
      sessionId,
      kind: "user",
      payload: { text: trimmed, inputMode: "queued_followup", action },
      triggerPolicy: "queue",
      dedupeKey
    });
    this.emit(sessionId, "mailbox_queued", {
      mailboxId: item.id,
      kind: item.kind,
      sequence: item.sequence,
      inputMode: "queued_followup",
      action
    });
    return queuedUserInput(item);
  }

  listQueuedUserInputs(sessionId: string): QueuedUserInput[] {
    return this.mailbox.queued(sessionId).map(queuedUserInput).filter(isPresent);
  }

  listFollowups(sessionId: string): QueuedUserInput[] {
    return this.mailbox.queued(sessionId).map(queuedFollowupUserInput).filter(isPresent);
  }

  listPendingSteers(sessionId: string): PendingSteerInput[] {
    return this.mailbox.queued(sessionId).map(pendingSteerInput).filter(isPresent);
  }

  takeBackLatestFollowup(sessionId: string): QueuedUserInput | undefined {
    const item = [...this.mailbox.queued(sessionId)].reverse().find((candidate) => queuedFollowupUserInput(candidate));
    if (!item || !this.mailbox.cancel(item.id)) return undefined;
    this.emit(sessionId, "mailbox_consumed", {
      mailboxId: item.id,
      sequence: item.sequence,
      disposition: "taken_back"
    });
    return queuedFollowupUserInput(item);
  }

  nextQueuedTurn(sessionId: string): SessionMailboxItem | undefined {
    return this.mailbox.queued(sessionId).find((item) => item.kind === "user" && item.triggerPolicy === "queue");
  }

  claimSteers(sessionId: string): SessionMailboxItem[] {
    return this.mailbox.claim(sessionId, "interrupt");
  }

  consumeSteers(sessionId: string, items: SessionMailboxItem[]): void {
    this.mailbox.consume(items);
    for (const item of items) {
      this.emit(sessionId, "mailbox_consumed", {
        mailboxId: item.id,
        sequence: item.sequence,
        inputMode: "steer"
      });
    }
  }

  restorePendingSteersAfterCancellation(sessionId: string): void {
    for (const item of this.mailbox.queued(sessionId)) {
      const steer = pendingSteerInput(item);
      if (!steer || !this.mailbox.cancel(item.id)) continue;
      const restored = this.mailbox.enqueue({
        sessionId,
        kind: "user",
        payload: { text: steer.text, inputMode: "queued_followup", action: "plain", restoredFromSteer: item.id },
        triggerPolicy: "queue",
        dedupeKey: `restored-steer:${item.id}`
      });
      this.emit(sessionId, "mailbox_consumed", {
        mailboxId: item.id,
        sequence: item.sequence,
        inputMode: "steer",
        disposition: "restored_after_cancel"
      });
      this.emit(sessionId, "mailbox_queued", {
        mailboxId: restored.id,
        kind: restored.kind,
        sequence: restored.sequence,
        inputMode: "queued_followup",
        action: "plain",
        restoredFromSteer: item.id
      });
    }
  }
}

export function mailboxInputText(item: SessionMailboxItem): string {
  if (!item.payload || typeof item.payload !== "object") return "";
  const text = (item.payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

export function queuedInputAction(text: string): QueuedInputAction {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("!")) return "shell";
  if (trimmed.startsWith("/")) return "slash";
  return "plain";
}

function queuedUserInput(item: SessionMailboxItem): QueuedUserInput | undefined {
  if (item.kind !== "user" || item.triggerPolicy !== "queue" || !item.payload || typeof item.payload !== "object") return undefined;
  const payload = item.payload as { text?: unknown; inputMode?: unknown; action?: unknown };
  if ((payload.inputMode !== "queued_followup" && payload.inputMode !== "turn") || typeof payload.text !== "string" || !payload.text.trim()) return undefined;
  const action = payload.action === "slash" || payload.action === "shell" || payload.action === "plain"
    ? payload.action
    : queuedInputAction(payload.text);
  return { id: item.id, sequence: item.sequence, text: payload.text, action, createdAt: item.createdAt };
}

function queuedFollowupUserInput(item: SessionMailboxItem): QueuedUserInput | undefined {
  if (!item.payload || typeof item.payload !== "object") return undefined;
  if ((item.payload as { inputMode?: unknown }).inputMode !== "queued_followup") return undefined;
  return queuedUserInput(item);
}

function pendingSteerInput(item: SessionMailboxItem): PendingSteerInput | undefined {
  if (item.kind !== "user" || item.triggerPolicy !== "interrupt" || !item.payload || typeof item.payload !== "object") return undefined;
  const payload = item.payload as { text?: unknown; inputMode?: unknown };
  if (payload.inputMode !== "steer" || typeof payload.text !== "string" || !payload.text.trim()) return undefined;
  return { id: item.id, sequence: item.sequence, text: payload.text, createdAt: item.createdAt };
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
