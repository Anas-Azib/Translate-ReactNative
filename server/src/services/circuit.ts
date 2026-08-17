import type { FailureKind, ProviderName } from '../types/index.js';
import { PipelineError } from '../lib/errors.js';
import type { Clock } from '../lib/clock.js';
import { systemClock } from '../lib/clock.js';

export interface HaltRecord {
  provider: ProviderName;
  kind: FailureKind;
  haltedAt: number;
  until: number;
}

/**
 * Implements the plan document's hard-stop behaviour (p.2):
 *
 *   Azure quota exceeded → STOP API requests → Do NOT retry
 *                        → Tell user service limit was reached
 *
 * Once a provider reports an auth failure or a quota stop, every subsequent
 * call to it is refused locally. The point is that we stop *spending* and stop
 * hammering a service that has already told us to go away — a retry loop against
 * a 429 is exactly what turns a small overage into a large bill.
 */
export class ProviderCircuit {
  readonly #halts = new Map<ProviderName, HaltRecord>();
  readonly #clock: Clock;
  readonly #cooldownMs: number;

  constructor(options: { clock?: Clock; cooldownMs?: number } = {}) {
    this.#clock = options.clock ?? systemClock;
    // Auth/quota problems are fixed by a human, not by waiting — but a permanent
    // in-process halt would need a redeploy, so we re-probe after a long cooldown.
    this.#cooldownMs = options.cooldownMs ?? 10 * 60 * 1000;
  }

  halt(provider: ProviderName, kind: FailureKind): void {
    const now = this.#clock.now();
    this.#halts.set(provider, { provider, kind, haltedAt: now, until: now + this.#cooldownMs });
  }

  isHalted(provider: ProviderName): boolean {
    const record = this.#halts.get(provider);
    if (!record) return false;
    if (record.until <= this.#clock.now()) {
      this.#halts.delete(provider);
      return false;
    }
    return true;
  }

  /** Throws the original failure kind without touching the network. */
  assertAvailable(provider: ProviderName): void {
    const record = this.#halts.get(provider);
    if (!record) return;
    if (record.until <= this.#clock.now()) {
      this.#halts.delete(provider);
      return;
    }
    throw new PipelineError(record.kind, provider, 'halted — not retrying');
  }

  /** Records a failure and halts the provider when the policy says to. */
  record(error: PipelineError): void {
    if (error.policy.haltProvider && error.provider !== 'backend') {
      this.halt(error.provider, error.kind);
    }
  }

  status(): HaltRecord[] {
    return [...this.#halts.values()].filter((r) => r.until > this.#clock.now());
  }

  reset(): void {
    this.#halts.clear();
  }
}
