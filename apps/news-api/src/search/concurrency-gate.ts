import { availableParallelism } from "node:os";

/** At most max(2, cores - 1) vector scans at once: one core stays free for everything else. */
export function defaultSemanticConcurrency(cores: number = availableParallelism()): number {
  return Math.max(2, cores - 1);
}

export interface GateOptions {
  maxActive: number;
  /** Callers allowed to wait for a slot; one more is refused at once. */
  maxQueue: number;
  /** How long a queued caller waits before it is refused. */
  queueWaitMs: number;
}

/**
 * Admission control: `acquire` resolves to a release function when a slot is free (or frees up
 * within queueWaitMs and the queue has room), and to null when the caller should do something
 * cheaper instead. Release is idempotent. An aborted waiter leaves the queue.
 */
export class ConcurrencyGate {
  private active = 0;
  private readonly waiters: { grant: () => void }[] = [];

  constructor(private readonly o: GateOptions) {}

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<(() => void) | null> {
    if (signal?.aborted) return null;
    if (this.active < this.o.maxActive) return this.take();
    if (this.waiters.length >= this.o.maxQueue || this.o.queueWaitMs <= 0) return null;
    return new Promise((resolve) => {
      const done = (v: (() => void) | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(v);
      };
      const w = { grant: () => done(this.take()) };
      const onAbort = () => done(null);
      const timer = setTimeout(() => done(null), this.o.queueWaitMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(w);
    });
  }

  private take(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters[0]?.grant();
    };
  }
}
