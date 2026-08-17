import type { UsageTotals } from '../types/index.js';
import { dayKey, monthKey } from '../lib/clock.js';

const EMPTY: UsageTotals = {
  audioSeconds: 0,
  translatedChars: 0,
  sttRequests: 0,
  translateRequests: 0,
};

/**
 * Server-side usage counters.
 *
 * Plan doc, p.4: "Maintain a server-side usage counter rather than trusting the
 * mobile application to report its own usage." Nothing here is ever populated
 * from a client-supplied number — every increment is derived from bytes and
 * characters the backend itself handled.
 *
 * In-memory by design for this build; the interface is deliberately narrow
 * (get / increment / prune) so it can be swapped for Redis `HINCRBY` without
 * touching QuotaManager.
 */
export class UsageStore {
  readonly #buckets = new Map<string, UsageTotals>();

  static userDay(userId: string, at: number): string {
    return `u:${userId}:d:${dayKey(at)}`;
  }
  static userMonth(userId: string, at: number): string {
    return `u:${userId}:m:${monthKey(at)}`;
  }
  static globalDay(at: number): string {
    return `g:d:${dayKey(at)}`;
  }
  static globalMonth(at: number): string {
    return `g:m:${monthKey(at)}`;
  }

  get(key: string): UsageTotals {
    return this.#buckets.get(key) ?? { ...EMPTY };
  }

  increment(key: string, delta: Partial<UsageTotals>): UsageTotals {
    const current = this.#buckets.get(key) ?? { ...EMPTY };
    const next: UsageTotals = {
      audioSeconds: current.audioSeconds + (delta.audioSeconds ?? 0),
      translatedChars: current.translatedChars + (delta.translatedChars ?? 0),
      sttRequests: current.sttRequests + (delta.sttRequests ?? 0),
      translateRequests: current.translateRequests + (delta.translateRequests ?? 0),
    };
    this.#buckets.set(key, next);
    return next;
  }

  /** Drops buckets whose day/month window has rolled past, keeping memory flat. */
  prune(now: number): number {
    const today = dayKey(now);
    const thisMonth = monthKey(now);
    let removed = 0;
    for (const key of [...this.#buckets.keys()]) {
      const isDay = key.includes(':d:');
      const window = key.slice(key.lastIndexOf(':') + 1);
      if (isDay ? window !== today : window !== thisMonth) {
        this.#buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.#buckets.clear();
  }

  get size(): number {
    return this.#buckets.size;
  }

  snapshot(): Record<string, UsageTotals> {
    return Object.fromEntries(this.#buckets);
  }
}
