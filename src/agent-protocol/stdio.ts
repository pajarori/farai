import type { AgentRuntime } from "../agent-core/runtime";
import type { SessionEvent } from "../types";
import { subscribeSessionEvents, type EventSubscription } from "../agent-core/events/transport";
import { dispatch, describeProtocol, type DispatchContext, type SubscriptionSink } from "./dispatch";

type Request = { id?: unknown; op?: unknown; args?: unknown };

export type StdioServerOptions = {
  runtime: AgentRuntime;
  workspace: string;
  write?: (line: string) => void;
};

export class StdioProtocolServer implements SubscriptionSink {
  private readonly subscriptions = new Map<string, EventSubscription>();
  private readonly context: DispatchContext;
  private readonly write: (line: string) => void;
  private closed = false;

  constructor(private readonly options: StdioServerOptions) {
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.context = { runtime: options.runtime, workspace: options.workspace, subscriptions: this };
  }

  hello(): void {
    const description = describeProtocol();
    this.emit({
      type: "hello",
      protocolVersion: description.protocolVersion,
      faraiVersion: description.faraiVersion,
      configVersion: description.configVersion,
      workspace: this.options.workspace
    });
  }

  subscribe(sessionId: string, cursor: number): { cursor: number } {
    this.subscriptions.get(sessionId)?.close();
    const subscription = subscribeSessionEvents(this.options.runtime.store, sessionId, cursor, (event) => {
      this.emitEvent(sessionId, event);
    });
    this.subscriptions.set(sessionId, subscription);
    return { cursor: subscription.cursor };
  }

  unsubscribe(sessionId: string): boolean {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) return false;
    subscription.close();
    this.subscriptions.delete(sessionId);
    return true;
  }

  async handle(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: Request;
    try {
      request = JSON.parse(trimmed) as Request;
    } catch {
      this.emit({ type: "result", ok: false, code: "INVALID_JSON", error: "request is not valid json" });
      return;
    }
    const id = typeof request.id === "string" || typeof request.id === "number" ? request.id : undefined;
    const operation = typeof request.op === "string" ? request.op : undefined;
    if (!operation) {
      this.emit({ type: "result", ...(id === undefined ? {} : { id }), ok: false, code: "MISSING_OP", error: "request requires op" });
      return;
    }
    try {
      const data = await dispatch(operation, request.args, this.context);
      this.emit({ type: "result", ...(id === undefined ? {} : { id }), ok: true, op: operation, data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: string })?.code ?? (
        message.includes("not found") ? "NOT_FOUND" :
        message.includes("already exists") ? "CONFLICT" :
        message.includes("invalid") || message.includes("requires") ? "INVALID_INPUT" :
        "INTERNAL_ERROR"
      );
      this.emit({
        type: "result",
        ...(id === undefined ? {} : { id }),
        ok: false,
        op: operation,
        code,
        error: message
      });
    }
  }

  async readStdin(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of Bun.stdin.stream()) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void this.handle(line);
        newline = buffer.indexOf("\n");
      }
      if (this.closed) return;
    }
    if (buffer.trim()) void this.handle(buffer);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subscription of this.subscriptions.values()) subscription.close();
    this.subscriptions.clear();
  }

  private emitEvent(sessionId: string, event: SessionEvent): void {
    this.emit({ type: "event", sessionId, event });
  }

  private emit(message: unknown): void {
    if (this.closed && (message as { type?: string }).type === "event") return;
    this.write(JSON.stringify(message));
  }
}
