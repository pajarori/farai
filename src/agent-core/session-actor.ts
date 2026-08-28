type ActorTask = {
  work: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

export class SessionActor {
  private readonly queue: ActorTask[] = [];
  private readonly idleResolvers = new Set<() => void>();
  private closed = false;
  private running = false;

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Session actor is closed"));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        work,
        resolve: (value) => resolve(value as T),
        reject
      });
      this.drain();
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.add(resolve));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("Session actor is closed");
    for (const task of this.queue.splice(0)) task.reject(error);
    this.resolveIdle();
  }

  private drain(): void {
    if (this.running) return;
    const task = this.queue.shift();
    if (!task) {
      this.resolveIdle();
      return;
    }
    if (this.closed) {
      task.reject(new Error("Session actor is closed"));
      this.drain();
      return;
    }
    this.running = true;
    void Promise.resolve().then(task.work).then(task.resolve, task.reject).finally(() => {
      this.running = false;
      this.drain();
    });
  }

  private resolveIdle(): void {
    if (this.running || this.queue.length > 0) return;
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers.clear();
  }
}
