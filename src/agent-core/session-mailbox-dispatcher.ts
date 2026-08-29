import type { SessionMailboxItem } from "../types";
import { BACKGROUND_MAILBOX_BATCH_SIZE, renderMailboxItems } from "./mailbox-render";
import { SessionInputQueue, mailboxInputText } from "./session-input-queue";
import { SessionMailbox } from "./session-mailbox";

type PromptOptions = {
  source?: "user" | "background";
  mailboxItems?: SessionMailboxItem[];
};

type DispatcherDependencies = {
  runExclusive: (sessionId: string, work: () => Promise<void>) => Promise<void>;
  runPrompt: (sessionId: string, text: string, options?: PromptOptions) => Promise<void>;
  clearSession: (sessionId: string) => Promise<void>;
  emitConsumed: (sessionId: string, item: SessionMailboxItem, inputMode?: "steer") => void;
  isShuttingDown: () => boolean;
  isRecovered: () => boolean;
  isStoreOpen: () => boolean;
};

/** Serializes durable mailbox delivery without leaking queue policy into AgentRuntime. */
export class SessionMailboxDispatcher {
  private readonly completionWakes = new Map<string, Promise<void>>();
  private readonly inputWakes = new Map<string, Promise<void>>();

  constructor(
    private readonly mailbox: SessionMailbox,
    private readonly inputQueue: SessionInputQueue,
    private readonly dependencies: DispatcherDependencies
  ) {}

  wakePending(sessionId: string): Promise<void> {
    const queued = this.mailbox.queued(sessionId);
    if (queued.some((item) => item.triggerPolicy === "interrupt")) return this.wakeSteers(sessionId);
    const nextUserInput = this.inputQueue.nextQueuedTurn(sessionId);
    if (nextUserInput && !this.inputQueue.isScheduledPrompt(nextUserInput.id)) return this.wakeQueuedInputs(sessionId);
    if (queued.some((item) => item.triggerPolicy === "wake")) return this.wakeCompletion(sessionId, "wake");
    if (queued.some((item) => item.triggerPolicy === "context")) return this.wakeCompletion(sessionId, "context");
    return Promise.resolve();
  }

  wakeQueuedInputs(sessionId: string): Promise<void> {
    if (this.dependencies.isShuttingDown()) return Promise.resolve();
    const existing = this.inputWakes.get(sessionId);
    if (existing) return existing;
    const wake = this.dependencies.runExclusive(sessionId, async () => {
      while (!this.dependencies.isShuttingDown()) {
        const item = this.inputQueue.nextQueuedTurn(sessionId);
        if (!item || this.inputQueue.isScheduledPrompt(item.id)) return;
        const claimed = this.mailbox.claimById(item.id);
        if (!claimed) continue;
        const text = mailboxInputText(claimed);
        if (!text) {
          this.mailbox.consume([claimed]);
          continue;
        }
        const completionItems = text.trimStart().startsWith("/")
          ? []
          : this.mailbox.claim(sessionId, "context", BACKGROUND_MAILBOX_BATCH_SIZE);
        try {
          if (text.trim() === "/clear") {
            await this.dependencies.clearSession(sessionId);
            return;
          }
          await this.dependencies.runPrompt(sessionId, text, { mailboxItems: completionItems });
          this.mailbox.consume([claimed]);
          this.mailbox.consume(completionItems);
          this.dependencies.emitConsumed(sessionId, claimed);
          for (const completion of completionItems) this.dependencies.emitConsumed(sessionId, completion);
        } catch {
          this.mailbox.release([claimed]);
          this.mailbox.release(completionItems);
          return;
        }
      }
    });
    let tracked: Promise<void>;
    tracked = wake.catch(() => undefined).finally(() => {
      if (this.inputWakes.get(sessionId) === tracked) this.inputWakes.delete(sessionId);
      if (this.dependencies.isShuttingDown() || !this.dependencies.isStoreOpen()) return;
      const next = this.inputQueue.nextQueuedTurn(sessionId);
      if (next && !this.inputQueue.isScheduledPrompt(next.id)) void this.wakeQueuedInputs(sessionId);
      else if (this.dependencies.isRecovered()) void this.wakePending(sessionId);
    });
    this.inputWakes.set(sessionId, tracked);
    return tracked;
  }

  wakeCompletion(sessionId: string, triggerPolicy: "wake" | "context"): Promise<void> {
    if (this.dependencies.isShuttingDown()) return Promise.resolve();
    const existing = this.completionWakes.get(sessionId);
    if (existing) return existing;
    const wake = this.dependencies.runExclusive(sessionId, async () => {
      while (!this.dependencies.isShuttingDown()) {
        let items: SessionMailboxItem[];
        try {
          items = this.mailbox.claim(sessionId, triggerPolicy, BACKGROUND_MAILBOX_BATCH_SIZE);
        } catch {
          return;
        }
        if (items.length === 0) return;
        try {
          await this.dependencies.runPrompt(sessionId, renderMailboxItems(items), {
            source: "background",
            mailboxItems: items
          });
          this.mailbox.consume(items);
          for (const item of items) this.dependencies.emitConsumed(sessionId, item);
        } catch {
          if (this.dependencies.isStoreOpen()) {
            try { this.mailbox.release(items); } catch {}
          }
          return;
        }
      }
    });
    let tracked: Promise<void>;
    tracked = wake.catch(() => undefined).finally(() => {
      if (this.completionWakes.get(sessionId) === tracked) this.completionWakes.delete(sessionId);
      if (this.dependencies.isShuttingDown() || !this.dependencies.isStoreOpen()) return;
      try { void this.wakePending(sessionId); } catch {}
    });
    this.completionWakes.set(sessionId, tracked);
    return tracked;
  }

  private wakeSteers(sessionId: string): Promise<void> {
    if (this.dependencies.isShuttingDown()) return Promise.resolve();
    return this.dependencies.runExclusive(sessionId, async () => {
      const items = this.inputQueue.claimSteers(sessionId);
      if (items.length === 0) return;
      const text = items.map(mailboxInputText).filter(Boolean).join("\n\n");
      try {
        await this.dependencies.runPrompt(sessionId, text);
        this.inputQueue.consumeSteers(sessionId, items);
      } catch {
        this.mailbox.release(items);
      }
    }).catch(() => undefined);
  }
}
