export type HookEvent =
  | "session.start"
  | "user.prompt"
  | "tool.pre"
  | "tool.post"
  | "finding.created"
  | "job.completed"
  | "turn.stop";

export type HookDefinition = {
  event: HookEvent;
  matcher?: string;
  command?: string;
  mcp?: { server: string; tool: string };
  timeoutMs?: number;
};

export type HookPayload = Record<string, unknown> & { event: HookEvent; sessionId: string };
