export type BackendSessionStatus = "running" | "done" | "error";

export type SessionKind = "generic" | "shell" | "reverse_shell" | "repl" | "ssh" | "oast";

export type SessionPtyMode = "pty" | "pipe";

export type BackendSession = {
  sessionId: string;
  status: BackendSessionStatus;
  exitCode?: number | null;
  kind?: SessionKind;
  pty?: SessionPtyMode;
};

export type BackendExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  backgroundSessionId?: string;
};

export type BackendSessionResult = {
  session: BackendSession;
  output: string;
};

export interface ExecutionBackend {
  readonly kind: string;
  readonly workspacePath?: string;
  runOnce(command: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<BackendExecResult>;
  startSession(command: string, opts: { yieldMs: number; signal?: AbortSignal; kind?: SessionKind; pty?: boolean }): Promise<BackendSessionResult>;
  pollSession(sessionId: string, opts: { input?: string; yieldMs: number }): Promise<BackendSessionResult>;
  waitSession?(sessionId: string): Promise<BackendSessionResult>;
  stopSession(sessionId: string): Promise<void>;
}
