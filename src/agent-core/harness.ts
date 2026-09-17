import type { BackgroundJob, Session, ToolContext, ToolResult, Turn } from "../types";
import type { ToolCatalog, ToolCatalogEntry, ToolSearchQuery } from "../agent-tools/catalog";

export type ThreadState = "active" | "cancelling" | "closed";

export type ThreadSnapshot = Readonly<{
  session: Session;
  state: ThreadState;
  activeTurnId?: string;
}>;

export type TurnPhase = "admission" | "context" | "planning" | "tools" | "completion" | "cancelled";

export type TurnSnapshot = Readonly<{
  turn: Turn;
  phase: TurnPhase;
  cancelled: boolean;
}>;

export type HarnessEvent = Readonly<{
  id: string;
  sessionId: string;
  turnId?: string;
  type: "thread" | "turn" | "job" | "tool" | "artifact";
  name: string;
  payload: unknown;
  createdAt: string;
}>;

export type JobPort = Readonly<{
  start: (input: unknown, signal?: AbortSignal) => Promise<BackgroundJob>;
  poll: (jobId: string, input?: string, yieldMs?: number) => Promise<BackgroundJob>;
  cancel: (jobId: string, reason?: string) => Promise<BackgroundJob>;
  snapshot: (jobId: string) => BackgroundJob;
}>;

export type ToolCatalogPort = Readonly<{
  list: () => readonly ToolCatalogEntry[];
  search: (query: ToolSearchQuery) => readonly ToolCatalogEntry[];
  load: (names: readonly string[]) => ReadonlyArray<{ name: string; run: (args: unknown, context: ToolContext) => Promise<ToolResult> }>;
}>;

export type HarnessPorts = Readonly<{
  catalog: ToolCatalog | ToolCatalogPort;
  jobs: JobPort;
}>;

export type CancellationScope = Readonly<{
  signal: AbortSignal;
  cancel: (reason?: unknown) => void;
  child: () => CancellationScope;
  dispose: () => void;
}>;

export function createCancellationScope(parent?: AbortSignal): CancellationScope {
  const controller = new AbortController();
  const abortFromParent = parent ? () => controller.abort(parent.reason) : undefined;
  if (parent?.aborted) abortFromParent?.();
  else if (parent && abortFromParent) parent.addEventListener("abort", abortFromParent, { once: true });
  return {
    signal: controller.signal,
    cancel: (reason?: unknown) => {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    child: () => createCancellationScope(controller.signal),
    dispose: () => {
      if (parent && abortFromParent) parent.removeEventListener("abort", abortFromParent);
    }
  };
}

export function assertScopeActive(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "cancelled"));
}

export function catalogPort(catalog: ToolCatalog): ToolCatalogPort {
  return {
    list: () => catalog.list(),
    search: (query) => catalog.search(query),
    load: (names) => catalog.load(names)
  };
}
