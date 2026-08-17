/**
 * A/B experiment definitions.
 *
 * Assignment is deterministic — a user hashes to the same variant forever with
 * nothing stored — so the client and server agree without a round trip, and a
 * user never sees the UI flip between reloads.
 */

export interface Variant {
  key: string;
  label: string;
  /** Relative weight within the experiment. Need not sum to 1. */
  weight: number;
}

export interface Experiment {
  key: string;
  description: string;
  /** The single number this experiment is trying to move. */
  primaryMetric: MetricKey;
  variants: Variant[];
  enabled: boolean;
}

export type MetricKey =
  | 'session_started'
  | 'first_translation_completed'
  | 'translation_completed'
  | 'translation_replayed'
  | 'session_completed_without_error'
  | 'tts_played'
  | 'language_changed'
  | 'onboarding_finished';

export const METRICS: MetricKey[] = [
  'session_started',
  'first_translation_completed',
  'translation_completed',
  'translation_replayed',
  'session_completed_without_error',
  'tts_played',
  'language_changed',
  'onboarding_finished',
];

export const EXPERIMENTS: Experiment[] = [
  {
    key: 'mic_control',
    description:
      'Hold-to-talk (walkie-talkie) vs tap-to-toggle recording. Hold is more discoverable for first-time users; tap is easier to hold a long conversation with.',
    primaryMetric: 'first_translation_completed',
    enabled: true,
    variants: [
      { key: 'hold', label: 'Hold to talk', weight: 1 },
      { key: 'tap', label: 'Tap to start / tap to stop', weight: 1 },
    ],
  },
  {
    key: 'onboarding',
    description:
      'A 3-step guided coach-mark tour on first launch vs dropping the user straight onto the mic with inline hints.',
    primaryMetric: 'onboarding_finished',
    enabled: true,
    variants: [
      { key: 'guided', label: 'Guided tour', weight: 1 },
      { key: 'instant', label: 'Straight to the mic', weight: 1 },
    ],
  },
  {
    key: 'autoplay_tts',
    description:
      'Speak the translation automatically vs requiring a tap. Synthesis is now on-device and free, so this is purely a UX question: does hearing it immediately help the conversation, or does it talk over people?',
    primaryMetric: 'tts_played',
    enabled: true,
    variants: [
      { key: 'autoplay', label: 'Speak automatically', weight: 1 },
      { key: 'manual', label: 'Tap to hear it', weight: 1 },
    ],
  },
  {
    key: 'result_layout',
    description:
      'Two stacked cards (source above translation) vs a single card that flips between the two languages.',
    primaryMetric: 'translation_completed',
    enabled: true,
    variants: [
      { key: 'stacked', label: 'Stacked cards', weight: 1 },
      { key: 'flip', label: 'Flip card', weight: 1 },
    ],
  },
];

export const EXPERIMENTS_BY_KEY = new Map(EXPERIMENTS.map((e) => [e.key, e]));

export function getExperiment(key: string): Experiment | undefined {
  return EXPERIMENTS_BY_KEY.get(key);
}
