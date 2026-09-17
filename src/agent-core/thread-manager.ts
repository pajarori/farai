import type { Session, Turn } from "../types";
import type { SqliteStore } from "../agent-store/sqlite-store";

export type ThreadManagerOptions = Readonly<{
  workspace: string;
  defaultModel?: string;
  cancelTurn: (turnId: string, reason?: string) => Turn;
  beforeCreate?: () => Promise<void>;
}>;

export class ThreadManager {
  constructor(private readonly store: SqliteStore, private readonly options: ThreadManagerOptions) {}

  async create(input: Partial<Pick<Session, "title" | "provider" | "model" | "campaignId">> = {}): Promise<Session> {
    await this.options.beforeCreate?.();
    return await this.store.createSession({
      workspace: this.options.workspace,
      ...(this.options.defaultModel ? { model: this.options.defaultModel } : {}),
      ...input
    });
  }

  get(id: string): Session {
    return this.store.loadSession(id);
  }

  list(includeArchived = false): Session[] {
    return this.store.listSessions(100, { includeArchived });
  }

  cancelTurn(turnId: string, reason?: string): Turn {
    return this.options.cancelTurn(turnId, reason);
  }

  async close(id: string): Promise<Session> {
    return this.store.archiveSession(id);
  }
}
