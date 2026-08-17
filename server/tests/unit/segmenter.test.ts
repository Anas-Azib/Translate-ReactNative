import { describe, expect, it } from 'vitest';
import {
  clampToLimit,
  isFillerOnly,
  isProcessableAudio,
  normalizeTranscript,
  shouldTranslate,
  ttsCacheKey,
} from '../../src/services/segmenter.js';

/**
 * The segmenter is the app's main lever on Google spend: every transcript it
 * rejects is a translation call and a TTS call that never happen.
 */
describe('segmenter', () => {
  describe('shouldTranslate', () => {
    it('accepts a normal finalized sentence', () => {
      const decision = shouldTranslate('Where is the hospital?', 0.92);
      expect(decision.translate).toBe(true);
    });

    it('rejects empty and whitespace-only transcripts', () => {
      expect(shouldTranslate('', 0.9).reason).toBe('empty');
      expect(shouldTranslate('   \n  ', 0.9).reason).toBe('empty');
    });

    it('rejects filler sounds so hesitation is never billed', () => {
      expect(shouldTranslate('uh', 0.9).reason).toBe('filler_only');
      expect(shouldTranslate('um, uh', 0.9).reason).toBe('filler_only');
      expect(shouldTranslate('اه', 0.9).reason).toBe('filler_only');
    });

    it('keeps filler words when they are part of a real sentence', () => {
      expect(shouldTranslate('um where is the exit', 0.9).translate).toBe(true);
    });

    it('rejects low-confidence recognitions rather than translating noise', () => {
      expect(shouldTranslate('grbl mmph', 0.12).reason).toBe('low_confidence');
    });

    it('rejects a repeat of the previous segment', () => {
      const decision = shouldTranslate('Hello there', 0.9, 'Hello there');
      expect(decision.reason).toBe('duplicate_of_previous');
    });

    it('ignores whitespace differences when de-duplicating', () => {
      expect(shouldTranslate('Hello   there', 0.9, ' Hello there ').reason).toBe('duplicate_of_previous');
    });

    it('translates a genuinely new segment after a duplicate', () => {
      expect(shouldTranslate('Hello there', 0.9, 'Goodbye').translate).toBe(true);
    });

    it('honours a raised confidence floor', () => {
      expect(shouldTranslate('maybe', 0.5, undefined, { minConfidence: 0.8 }).reason).toBe('low_confidence');
    });

    it('normalises the text it returns', () => {
      expect(shouldTranslate('  hello    world  ', 0.9).normalized).toBe('hello world');
    });
  });

  describe('isFillerOnly', () => {
    it('is false for empty input, so "empty" stays a distinct reason', () => {
      expect(isFillerOnly('')).toBe(false);
    });

    it('handles punctuation attached to filler', () => {
      expect(isFillerOnly('um... uh,')).toBe(true);
    });
  });

  describe('clampToLimit', () => {
    it('leaves text under the limit untouched', () => {
      expect(clampToLimit('short text', 100)).toBe('short text');
    });

    it('cuts on a word boundary when one is available', () => {
      const result = clampToLimit('the quick brown fox jumps over', 20);
      expect(result.length).toBeLessThanOrEqual(20);
      expect(result).toBe('the quick brown fox');
    });

    it('hard-cuts when there is no usable word boundary', () => {
      const result = clampToLimit('a'.repeat(50), 10);
      expect(result).toHaveLength(10);
    });
  });

  describe('ttsCacheKey', () => {
    it('is stable for the same text, language, and voice', () => {
      const a = ttsCacheKey('Hello there', 'en-US', 'en-US-Standard-C');
      const b = ttsCacheKey('Hello there', 'en-US', 'en-US-Standard-C');
      expect(a).toBe(b);
    });

    it('ignores case and surrounding whitespace so replays hit the cache', () => {
      expect(ttsCacheKey('  Hello There  ', 'en-US', 'v')).toBe(ttsCacheKey('hello there', 'en-US', 'v'));
    });

    it('differs by language and by voice', () => {
      expect(ttsCacheKey('hi', 'en-US', 'v1')).not.toBe(ttsCacheKey('hi', 'fr-FR', 'v1'));
      expect(ttsCacheKey('hi', 'en-US', 'v1')).not.toBe(ttsCacheKey('hi', 'en-US', 'v2'));
    });
  });

  describe('isProcessableAudio', () => {
    it('rejects blips shorter than the speech floor', () => {
      expect(isProcessableAudio(0.1, 8000)).toBe(false);
    });

    it('rejects near-empty buffers regardless of claimed duration', () => {
      // A client claiming 5 seconds inside 100 bytes is not to be believed.
      expect(isProcessableAudio(5, 100)).toBe(false);
    });

    it('accepts a real utterance', () => {
      expect(isProcessableAudio(1.4, 12_000)).toBe(true);
    });
  });

  describe('normalizeTranscript', () => {
    it('collapses runs of whitespace and trims', () => {
      expect(normalizeTranscript('  a \n b\t c ')).toBe('a b c');
    });
  });
});
