import type { SessionMailboxItem } from "../types";
import type { SqliteStore } from "../agent-store/sqlite-store";

export class SessionMailbox {
  constructor(
    private readonly store: SqliteStore,
    private readonly ownerId: string
  ) {}

  enqueue(input: Omit<SessionMailboxItem, "id" | "sequence" | "state" | "createdAt">): SessionMailboxItem {
    return this.store.enqueueMailbox(input);
  }

  claim(sessionId: string, triggerPolicy?: SessionMailboxItem["triggerPolicy"], limit?: number): SessionMailboxItem[] {
    return this.store.claimMailbox(sessionId, this.ownerId, 30_000, triggerPolicy, limit);
  }

  claimById(id: string): SessionMailboxItem | undefined {
    return this.store.claimMailboxItem(id, this.ownerId);
  }

  consume(items: SessionMailboxItem[]): void {
    this.store.consumeMailbox(items.map((item) => item.id), this.ownerId);
  }

  release(items: SessionMailboxItem[]): void {
    this.store.releaseMailbox(items.map((item) => item.id), this.ownerId);
  }

  queued(sessionId: string): SessionMailboxItem[] {
    return this.store.listMailbox(sessionId, "queued");
  }

  hasQueued(sessionId: string, triggerPolicy?: SessionMailboxItem["triggerPolicy"]): boolean {
    return this.store.hasQueuedMailbox(sessionId, triggerPolicy);
  }

  cancel(id: string): boolean {
    return this.store.cancelMailboxItem(id);
  }
}
