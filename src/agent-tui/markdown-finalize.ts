import { batch } from "solid-js";

type FinalizeTimer = ReturnType<typeof setTimeout>;

type FinalizeClock = {
  now(): number;
  setTimer(callback: () => void, delayMs: number): FinalizeTimer;
  clearTimer(timer: FinalizeTimer): void;
};

const systemClock: FinalizeClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer)
};

export function createMarkdownFinalizeScheduler(delayMs = 70, clock: FinalizeClock = systemClock) {
  const queue = new Map<() => void, number>();
  let timer: FinalizeTimer | undefined;
  let timerDeadline = 0;

  function setTimer(deadline: number): void {
    if (timer) clock.clearTimer(timer);
    timerDeadline = deadline;
    timer = clock.setTimer(flush, Math.max(0, Math.ceil(deadline - clock.now())));
  }

  function flush(): void {
    timer = undefined;
    timerDeadline = 0;
    const now = clock.now();
    const callbacks: Array<() => void> = [];
    let nextDeadline = Number.POSITIVE_INFINITY;
    for (const [callback, deadline] of queue) {
      if (deadline <= now) {
        queue.delete(callback);
        callbacks.push(callback);
      } else {
        nextDeadline = Math.min(nextDeadline, deadline);
      }
    }
    if (callbacks.length > 0) {
      batch(() => {
        for (const finalize of callbacks) finalize();
      });
    }
    if (Number.isFinite(nextDeadline)) setTimer(nextDeadline);
  }

  function schedule(callback: () => void): () => void {
    const deadline = clock.now() + delayMs;
    queue.set(callback, deadline);
    if (!timer || deadline < timerDeadline) setTimer(deadline);
    return () => {
      if (!queue.delete(callback)) return;
      if (queue.size > 0 || !timer) return;
      clock.clearTimer(timer);
      timer = undefined;
      timerDeadline = 0;
    };
  }

  return { schedule };
}

export const scheduleMarkdownFinalize = createMarkdownFinalizeScheduler().schedule;
