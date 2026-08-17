/**
 * Client mirror of the server's experiment registry.
 *
 * Kept as literal types so `variant('mic_control')` is checked at compile time
 * and a renamed variant becomes a type error rather than a silently dead branch
 * in the UI.
 */

export const EXPERIMENT_KEYS = ['mic_control', 'onboarding', 'autoplay_tts', 'result_layout'] as const;
export type ExperimentKey = (typeof EXPERIMENT_KEYS)[number];

export const VARIANTS = {
  mic_control: ['hold', 'tap'],
  onboarding: ['guided', 'instant'],
  autoplay_tts: ['autoplay', 'manual'],
  result_layout: ['stacked', 'flip'],
} as const satisfies Record<ExperimentKey, readonly string[]>;

export type VariantOf<K extends ExperimentKey> = (typeof VARIANTS)[K][number];

/** The first entry of each list is the control, matching the server. */
export const DEFAULT_ASSIGNMENTS: { [K in ExperimentKey]: VariantOf<K> } = {
  mic_control: 'hold',
  onboarding: 'guided',
  autoplay_tts: 'autoplay',
  result_layout: 'stacked',
};

export const METRICS = [
  'session_started',
  'first_translation_completed',
  'translation_completed',
  'translation_replayed',
  'session_completed_without_error',
  'tts_played',
  'language_changed',
  'onboarding_finished',
] as const;

export type MetricKey = (typeof METRICS)[number];

/**
 * Offline fallback bucketing.
 *
 * The server's assignment is authoritative; this only runs when `/ab/assignments`
 * is unreachable, so the UI still has a stable variant instead of flickering
 * between defaults. FNV-1a rather than SHA-256 because `crypto.subtle` is async
 * and this has to resolve during the first render.
 */
export function localAssign(userId: string, experiment: ExperimentKey, salt: string): string {
  const variants = VARIANTS[experiment] as readonly string[];
  return variants[Math.floor(hashToUnit(`${salt}:${experiment}:${userId}`) * variants.length)]!;
}

export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Maps a string onto [0,1).
 *
 * The avalanche step is not decoration. FNV-1a's multiplier is odd, so its
 * lowest bit reduces to the parity of the input bytes — which means a plain
 * `hash % 2` makes two experiments whose names differ in that parity land in
 * perfectly correlated (or perfectly anti-correlated) buckets for *every* user.
 * That silently destroys the independence the analysis assumes. fmix32
 * (MurmurHash3's finalizer) diffuses every input bit across all 32 output bits,
 * and taking the value as a whole rather than one bit keeps the split clean for
 * any number of variants.
 */
export function hashToUnit(input: string): number {
  let h = fnv1a(input);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}
