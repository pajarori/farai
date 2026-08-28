import type { ServiceStatus } from "./types";

export class ServiceRegistry {
  private readonly services = new Map<string, ServiceStatus>();

  register(status: ServiceStatus): void {
    this.services.set(status.name, status);
  }

  unregister(name: string): void {
    this.services.delete(name);
  }

  get(name: string): ServiceStatus | undefined {
    return this.services.get(name);
  }

  list(): ServiceStatus[] {
    return [...this.services.values()];
  }

  unregisterSession(sessionId: string): void {
    for (const [name, status] of this.services) {
      if (status.sessionId === sessionId) this.services.delete(name);
    }
  }
}

export const serviceRegistry = new ServiceRegistry();
