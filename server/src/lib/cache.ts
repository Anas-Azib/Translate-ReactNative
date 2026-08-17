import type { Clock } from './clock.js';
import { systemClock } from './clock.js';

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Small LRU + TTL cache.
 *
 * Backs the TTS cache, which exists to satisfy the plan document's constraint
 * (p.4): "Do not regenerate TTS unnecessarily. Only synthesize speech when the
 * translated text has actually changed/finalized."
 */
export class TtlCache<V> {
  readonly #map = new Map<string, Entry<V>>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #clock: Clock;

  #hits = 0;
  #misses = 0;

  constructor(options: { maxEntries?: number; ttlMs?: number; clock?: Clock } = {}) {
    this.#maxEntries = options.maxEntries ?? 200;
    this.#ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.#clock = options.clock ?? systemClock;
  }

  get(key: string): V | undefined {
    const entry = this.#map.get(key);
    if (!entry) {
      this.#misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.#clock.now()) {
      this.#map.delete(key);
      this.#misses += 1;
      return undefined;
    }
    // Refresh LRU recency.
    this.#map.delete(key);
    this.#map.set(key, entry);
    this.#hits += 1;
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, { value, expiresAt: this.#clock.now() + this.#ttlMs });
    while (this.#map.size > this.#maxEntries) {
      const oldest = this.#map.keys().next();
      if (oldest.done) break;
      this.#map.delete(oldest.value);
    }
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.#map.clear();
    this.#hits = 0;
    this.#misses = 0;
  }

  get size(): number {
    return this.#map.size;
  }

  get stats(): { hits: number; misses: number; hitRate: number } {
    const total = this.#hits + this.#misses;
    return { hits: this.#hits, misses: this.#misses, hitRate: total === 0 ? 0 : this.#hits / total };
  }
}
