import type { Clock } from '../lib/clock.js';
import { systemClock } from '../lib/clock.js';
import type { MetricKey } from './registry.js';
import { EXPERIMENTS, getExperiment } from './registry.js';
import type { ComparisonResult } from './stats.js';
import { compareVariants, rate } from './stats.js';

export interface AbEvent {
  userId: string;
  experiment: string;
  variant: string;
  metric: MetricKey;
  at: number;
  value?: number;
}

export interface MetricBreakdown {
  metric: MetricKey;
  variants: Array<{
    variant: string;
    exposures: number;
    conversions: number;
    conversionRate: number;
    /** Total of `value` across events — e.g. seconds saved, characters spent. */
    valueSum: number;
  }>;
  comparison: ComparisonResult | null;
}

export interface ExperimentReport {
  experiment: string;
  description: string;
  primaryMetric: MetricKey;
  totalExposures: number;
  metrics: MetricBreakdown[];
}

/**
 * Collects experiment exposures and conversions in memory.
 *
 * Conversions are counted **per unique user**, not per event: a user who
 * completes ten translations is one conversion for `translation_completed`.
 * Counting raw events instead would let a single power user swing the result and
 * would violate the independence assumption the z-test rests on.
 */
export class ExperimentStore {
  /** experiment → variant → set of exposed users. */
  readonly #exposures = new Map<string, Map<string, Set<string>>>();
  /** experiment → metric → variant → set of converted users. */
  readonly #conversions = new Map<string, Map<string, Map<string, Set<string>>>>();
  /** experiment → metric → variant → summed value. */
  readonly #values = new Map<string, Map<string, Map<string, number>>>();

  readonly #events: AbEvent[] = [];
  readonly #maxEvents: number;
  readonly #clock: Clock;

  constructor(options: { clock?: Clock; maxEvents?: number } = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#maxEvents = options.maxEvents ?? 10_000;
  }

  /** Records that a user saw a variant. Idempotent per (experiment, user). */
  recordExposure(experiment: string, variant: string, userId: string): void {
    const byVariant = getOrCreate(this.#exposures, experiment, () => new Map<string, Set<string>>());
    // A user counts once per experiment, in the first variant they were shown.
    for (const users of byVariant.values()) {
      if (users.has(userId)) return;
    }
    getOrCreate(byVariant, variant, () => new Set<string>()).add(userId);
  }

  recordEvent(event: Omit<AbEvent, 'at'> & { at?: number }): AbEvent {
    const full: AbEvent = { ...event, at: event.at ?? this.#clock.now() };

    this.recordExposure(full.experiment, full.variant, full.userId);

    const byMetric = getOrCreate(this.#conversions, full.experiment, () => new Map());
    const byVariant = getOrCreate(byMetric, full.metric, () => new Map<string, Set<string>>());
    getOrCreate(byVariant, full.variant, () => new Set<string>()).add(full.userId);

    if (typeof full.value === 'number') {
      const valuesByMetric = getOrCreate(this.#values, full.experiment, () => new Map());
      const valuesByVariant = getOrCreate(valuesByMetric, full.metric, () => new Map<string, number>());
      valuesByVariant.set(full.variant, (valuesByVariant.get(full.variant) ?? 0) + full.value);
    }

    this.#events.push(full);
    if (this.#events.length > this.#maxEvents) this.#events.shift();

    return full;
  }

  exposures(experiment: string, variant: string): number {
    return this.#exposures.get(experiment)?.get(variant)?.size ?? 0;
  }

  conversions(experiment: string, metric: MetricKey, variant: string): number {
    return this.#conversions.get(experiment)?.get(metric)?.get(variant)?.size ?? 0;
  }

  report(experimentKey: string): ExperimentReport | null {
    const definition = getExperiment(experimentKey);
    if (!definition) return null;

    const variantKeys = definition.variants.map((v) => v.key);
    const totalExposures = variantKeys.reduce((sum, v) => sum + this.exposures(experimentKey, v), 0);

    const metricKeys = new Set<MetricKey>([definition.primaryMetric]);
    for (const metric of this.#conversions.get(experimentKey)?.keys() ?? []) {
      metricKeys.add(metric as MetricKey);
    }

    const metrics: MetricBreakdown[] = [...metricKeys].map((metric) => {
      const variants = variantKeys.map((variant) => {
        const exposures = this.exposures(experimentKey, variant);
        const conversions = this.conversions(experimentKey, metric, variant);
        return {
          variant,
          exposures,
          conversions,
          conversionRate: rate(conversions, exposures),
          valueSum: this.#values.get(experimentKey)?.get(metric)?.get(variant) ?? 0,
        };
      });

      // The first declared variant is the control by convention.
      const comparison =
        variants.length >= 2
          ? compareVariants(
              { variant: variants[0]!.variant, exposures: variants[0]!.exposures, conversions: variants[0]!.conversions },
              { variant: variants[1]!.variant, exposures: variants[1]!.exposures, conversions: variants[1]!.conversions },
            )
          : null;

      return { metric, variants, comparison };
    });

    return {
      experiment: definition.key,
      description: definition.description,
      primaryMetric: definition.primaryMetric,
      totalExposures,
      metrics,
    };
  }

  reportAll(): ExperimentReport[] {
    return EXPERIMENTS.map((e) => this.report(e.key)).filter((r): r is ExperimentReport => r !== null);
  }

  recentEvents(limit = 50): AbEvent[] {
    return this.#events.slice(-limit);
  }

  get eventCount(): number {
    return this.#events.length;
  }

  reset(): void {
    this.#exposures.clear();
    this.#conversions.clear();
    this.#values.clear();
    this.#events.length = 0;
  }
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = create();
  map.set(key, created);
  return created;
}
