import type { AgentPromptResult, Session } from "../types";
import { assertScopeActive, createCancellationScope, type CancellationScope } from "./harness";

export type TurnExecutionOptions = {
  signal?: AbortSignal;
  source?: "user" | "background";
};

export type TurnExecutor = (session: Session, input: string, options: TurnExecutionOptions) => Promise<AgentPromptResult>;

export class TurnEngine {
  private readonly scopes = new Map<string, Set<CancellationScope>>();

  constructor(private readonly executeTurn: TurnExecutor) {}

  async execute(session: Session, input: string, options: TurnExecutionOptions = {}): Promise<AgentPromptResult> {
    const scope = createCancellationScope(options.signal);
    const active = this.scopes.get(session.id) ?? new Set<CancellationScope>();
    active.add(scope);
    this.scopes.set(session.id, active);
    try {
      assertScopeActive(scope.signal);
      return await this.executeTurn(session, input, { ...options, signal: scope.signal });
    } finally {
      active.delete(scope);
      if (active.size === 0 && this.scopes.get(session.id) === active) this.scopes.delete(session.id);
      scope.dispose();
    }
  }

  cancel(sessionId: string, reason = "turn cancelled"): void {
    for (const scope of this.scopes.get(sessionId) ?? []) scope.cancel(reason);
  }

  active(sessionId?: string): boolean {
    return sessionId ? (this.scopes.get(sessionId)?.size ?? 0) > 0 : this.scopes.size > 0;
  }
}
