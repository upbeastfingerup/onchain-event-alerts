import type { Alert, Sink } from '../types.js';

export class SinkHttpError extends Error {
  constructor(public readonly status: number, public readonly retryAfterMs?: number) {
    super(`HTTP ${status}`);
  }
}

export interface ReliableOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Minimum spacing between sends (simple rate limit). 0 disables. */
  minIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const isRetryable = (e: unknown) => !(e instanceof SinkHttpError) || e.status === 429 || e.status >= 500;

/**
 * Wraps any Sink with rate limiting (serialised slots, min interval) and retry with
 * exponential backoff + jitter. 429s honour Retry-After; other 4xx fail immediately.
 */
export class ReliableSink implements Sink {
  private nextSlot = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly inner: Sink, private readonly o: ReliableOptions) {
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
    this.random = o.random ?? Math.random;
  }
  get name() { return this.inner.name; }

  private async acquire(): Promise<void> {
    const t = this.now();
    const slot = Math.max(t, this.nextSlot);
    this.nextSlot = slot + this.o.minIntervalMs;
    if (slot > t) await this.sleep(slot - t);
  }

  async send(alert: Alert): Promise<void> {
    let attempt = 0;
    for (;;) {
      await this.acquire();
      try {
        await this.inner.send(alert);
        return;
      } catch (e) {
        if (!isRetryable(e) || attempt >= this.o.maxRetries) throw e;
        const backoff = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** attempt);
        const jittered = backoff / 2 + this.random() * (backoff / 2);
        const retryAfter = e instanceof SinkHttpError ? e.retryAfterMs ?? 0 : 0;
        await this.sleep(Math.min(this.o.maxDelayMs, Math.max(jittered, retryAfter)));
        attempt++;
      }
    }
  }
}
