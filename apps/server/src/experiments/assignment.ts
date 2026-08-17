import { hashToUnitInterval } from '../lib/crypto.js';
import type { Experiment, Variant } from './registry.js';
import { EXPERIMENTS } from './registry.js';

export type Assignments = Record<string, string>;

/**
 * Deterministic bucketing: `hash(salt : experiment : userId)` → [0,1) → variant.
 *
 * Two properties matter here.
 *  1. Stability — the same user always lands in the same variant, so nothing has
 *     to be persisted and the UI never changes under them mid-session.
 *  2. Independence — the experiment key is part of the hash input, so a user in
 *     variant A of one experiment is not correlated with variant A of another.
 */
export function assignVariant(experiment: Experiment, userId: string, salt: string): string {
  const enabled = experiment.variants.filter((v) => v.weight > 0);
  if (!experiment.enabled || enabled.length === 0) {
    return experiment.variants[0]?.key ?? 'control';
  }

  const total = enabled.reduce((sum, v) => sum + v.weight, 0);
  const point = hashToUnitInterval(`${salt}:${experiment.key}:${userId}`) * total;

  let cursor = 0;
  for (const variant of enabled) {
    cursor += variant.weight;
    if (point < cursor) return variant.key;
  }
  return enabled[enabled.length - 1]!.key;
}

export function assignAll(
  userId: string,
  salt: string,
  experiments: Experiment[] = EXPERIMENTS,
): Assignments {
  const result: Assignments = {};
  for (const experiment of experiments) {
    result[experiment.key] = assignVariant(experiment, userId, salt);
  }
  return result;
}

/**
 * Lets QA and the integration tests pin a variant via `?ab_mic_control=tap`.
 * Only honours variants that actually exist, so a typo can't create a phantom
 * cohort that pollutes the results.
 */
export function applyOverrides(
  assignments: Assignments,
  overrides: Record<string, string | undefined>,
  experiments: Experiment[] = EXPERIMENTS,
): Assignments {
  const result = { ...assignments };
  for (const experiment of experiments) {
    const requested = overrides[`ab_${experiment.key}`] ?? overrides[experiment.key];
    if (!requested) continue;
    if (experiment.variants.some((v: Variant) => v.key === requested)) {
      result[experiment.key] = requested;
    }
  }
  return result;
}
