import { stableHash } from '../lib/crypto.js';

/**
 * Decides which recognised transcripts are worth paying Google for.
 *
 * Plan doc, p.4:
 *  - "Do not send every tiny partial transcript to Translation. Translate
 *     meaningful finalized segments instead."
 *  - "Do not regenerate TTS unnecessarily. Only synthesize speech when the
 *     translated text has actually changed/finalized."
 */

export interface SegmentGateOptions {
  minChars?: number;
  minWords?: number;
  minConfidence?: number;
  maxChars?: number;
}

export type SegmentSkipReason =
  | 'empty'
  | 'too_short'
  | 'too_few_words'
  | 'low_confidence'
  | 'filler_only'
  | 'duplicate_of_previous';

export interface SegmentDecision {
  translate: boolean;
  reason?: SegmentSkipReason;
  normalized: string;
}

const DEFAULTS: Required<SegmentGateOptions> = {
  minChars: 2,
  minWords: 1,
  minConfidence: 0.3,
  maxChars: 800,
};

/**
 * Hesitation sounds every STT engine happily returns from an otherwise silent
 * room. Translating them wastes characters and produces nonsense.
 */
const FILLER = new Set([
  'uh',
  'um',
  'uhm',
  'erm',
  'er',
  'ah',
  'ahh',
  'hm',
  'hmm',
  'mm',
  'mmm',
  'eh',
  'أه',
  'اه',
  'ايه',
  'ممم',
  'همم',
]);

/** Collapses whitespace and strips trailing punctuation-only noise. */
export function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function isFillerOnly(text: string): boolean {
  const words = normalizeTranscript(text)
    .toLowerCase()
    .split(/[\s,.!?،؟]+/)
    .filter(Boolean);
  if (words.length === 0) return false;
  return words.every((w) => FILLER.has(w.replace(/[.!?،؟]/g, '')));
}

/**
 * @param previousText the last transcript we already paid to translate, if any
 */
export function shouldTranslate(
  text: string,
  confidence: number,
  previousText?: string,
  options: SegmentGateOptions = {},
): SegmentDecision {
  const opts = { ...DEFAULTS, ...options };
  const normalized = normalizeTranscript(text);

  if (normalized.length === 0) return { translate: false, reason: 'empty', normalized };
  if (isFillerOnly(normalized)) return { translate: false, reason: 'filler_only', normalized };
  if (normalized.length < opts.minChars) return { translate: false, reason: 'too_short', normalized };

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < opts.minWords) return { translate: false, reason: 'too_few_words', normalized };

  if (confidence < opts.minConfidence) return { translate: false, reason: 'low_confidence', normalized };

  if (previousText !== undefined && normalizeTranscript(previousText) === normalized) {
    return { translate: false, reason: 'duplicate_of_previous', normalized };
  }

  return { translate: true, normalized };
}

/** Trims to the per-request character cap without splitting a word. */
export function clampToLimit(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice).trim();
}

/**
 * Cache key for synthesised speech. Identical (text, language, voice) must map
 * to the same key so a repeated phrase is never re-synthesised.
 */
export function ttsCacheKey(text: string, languageCode: string, voiceName: string): string {
  return stableHash(normalizeTranscript(text).toLowerCase(), languageCode, voiceName);
}

/**
 * Server-side floor on segment length. The client's VAD is the primary silence
 * gate, but a client is never trusted — a 40 ms blip is silence no matter what
 * the caller claims.
 */
export function isProcessableAudio(durationSeconds: number, byteLength: number): boolean {
  return durationSeconds >= 0.35 && byteLength > 512;
}
