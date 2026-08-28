type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export class SubagentGate {
  private active = 0;
  private readonly queue: Waiter[] = [];
  private readonly idleResolvers = new Set<() => void>();

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("subagent concurrency limit must be a positive integer");
  }

  idle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.add(resolve));
  }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("subagent task cancelled before start"));
        return;
      }
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index === -1) return;
          this.queue.splice(index, 1);
          this.detach(waiter);
          reject(signal.reason ?? new Error("subagent task cancelled before start"));
          this.notifyIdle();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length) {
      const waiter = this.queue.shift()!;
      this.detach(waiter);
      this.active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
        this.notifyIdle();
      });
    }
  }

  private detach(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  }

  private notifyIdle(): void {
    if (this.active !== 0 || this.queue.length !== 0) return;
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers.clear();
  }
}
