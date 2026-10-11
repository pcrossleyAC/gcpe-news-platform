export type BreakerState = "closed" | "open" | "half-open";

/** Thrown instead of calling the provider: the caller falls back (spec §4). */
export class BreakerOpenError extends Error {
  readonly code = "breaker_open";
  constructor() {
    super("circuit breaker open");
    this.name = "BreakerOpenError";
  }
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

/**
 * Closed until `failureThreshold` consecutive failures; then open for `cooldownMs`, rejecting
 * every call with BreakerOpenError; then half-open, letting exactly one probe through. A
 * successful probe closes it and resets the count; a failed one re-opens it for a fresh cooldown.
 */
export class CircuitBreaker {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  private readonly now: () => number;
  private isOpen = false;
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  get state(): BreakerState {
    if (!this.isOpen) return "closed";
    return this.now() - this.openedAt >= this.cooldownMs ? "half-open" : "open";
  }

  /**
   * `signal` is the caller's own signal, checked only by its `.aborted` flag after `fn` rejects
   * (never by the error's shape, which a provider's internal timeout can reproduce exactly). A
   * caller abort is neutral: it isn't counted as a failure or a success, and if it was the
   * half-open probe, the slot is freed without reopening, so the breaker stays half-open for the
   * next caller. A provider-side timeout — `signal` absent or not aborted — still counts.
   */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.isOpen) {
      if (this.now() - this.openedAt < this.cooldownMs || this.probing) throw new BreakerOpenError();
      this.probing = true;
      try {
        const value = await fn();
        this.isOpen = false;
        this.failures = 0;
        return value;
      } catch (e) {
        if (!signal?.aborted) this.openedAt = this.now();
        throw e;
      } finally {
        this.probing = false;
      }
    }
    try {
      const value = await fn();
      this.failures = 0;
      return value;
    } catch (e) {
      if (!signal?.aborted) {
        this.failures += 1;
        if (!this.isOpen && this.failures >= this.failureThreshold) {
          this.isOpen = true;
          this.openedAt = this.now();
        }
      }
      throw e;
    }
  }
}
