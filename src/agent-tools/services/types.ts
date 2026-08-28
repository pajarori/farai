export type ServiceStatus = {
  name: string;
  kind: string;
  sessionId: string;
  startedAt: number;
  detail?: string;
  metadata?: Record<string, unknown>;
};
