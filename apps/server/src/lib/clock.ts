/**
 * Injectable clock. Quota windows roll over on calendar boundaries, which is
 * miserable to test against a real `Date.now()`, so every module that cares
 * about time takes one of these.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class FakeClock implements Clock {
  #now: number;
  constructor(start = Date.parse('2026-01-01T00:00:00.000Z')) {
    this.#now = start;
  }
  now(): number {
    return this.#now;
  }
  advance(ms: number): void {
    this.#now += ms;
  }
  set(ms: number): void {
    this.#now = ms;
  }
}

/** UTC day bucket, e.g. "2026-08-17". */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC month bucket, e.g. "2026-08". */
export function monthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}
