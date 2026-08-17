import { describe, expect, it } from 'vitest';
import {
  commonPrefixLength,
  graphemeLength,
  isExtensionOf,
  reconcileText,
  sliceGraphemes,
  toGraphemes,
} from '../src/text.js';

describe('reconcileText', () => {
  /**
   * The headline requirement: a recogniser emitting H / He / Hel / Hell / Hello
   * must end up displaying "Hello", never "HHeHelHellHello".
   */
  describe('the duplication guarantee', () => {
    it('never concatenates a growing prefix stream', () => {
      const stream = ['H', 'He', 'Hel', 'Hell', 'Hello'];
      let displayed = '';

      for (const update of stream) {
        const result = reconcileText(displayed, update);
        // The renderer keeps `keep` characters and then reveals the rest of
        // `next` — it never appends `next` to what is already there.
        displayed = result.next;
      }

      expect(displayed).toBe('Hello');
      expect(displayed).not.toBe('HHeHelHellHello');
    });

    it('classifies every step of that stream as an extension', () => {
      const stream = ['H', 'He', 'Hel', 'Hell', 'Hello'];
      let previous = '';

      for (const update of stream) {
        const result = reconcileText(previous, update);
        expect(result.kind).toBe('extended');
        // Everything already revealed stays revealed: this is what keeps the
        // animation continuous instead of restarting on each update.
        expect(result.keep).toBe(previous.length);
        previous = update;
      }
    });

    it('handles the translation stream the same way', () => {
      const stream = ['M', 'Ma', 'Mar', 'Mars'];
      let displayed = '';
      for (const update of stream) displayed = reconcileText(displayed, update).next;

      expect(displayed).toBe('Mars');
    });

    it('keeps all revealed characters across a long fast stream', () => {
      const sentence = 'Where is the nearest hospital?';
      let previous = '';
      for (let i = 1; i <= sentence.length; i += 1) {
        const next = sentence.slice(0, i);
        const result = reconcileText(previous, next);
        expect(result.kind).toBe('extended');
        expect(result.keep).toBe(i - 1);
        previous = next;
      }
      expect(previous).toBe(sentence);
    });
  });

  describe('corrections', () => {
    it('rewinds only to the first differing character', () => {
      // A late correction must not retype the whole sentence.
      const result = reconcileText('Hello ther', 'Hello there');
      expect(result.kind).toBe('extended');
      expect(result.keep).toBe('Hello ther'.length);
    });

    it('detects a genuine divergence and keeps the shared prefix', () => {
      const result = reconcileText('Hello world', 'Hello there');
      expect(result.kind).toBe('diverged');
      expect(result.keep).toBe('Hello '.length);
    });

    it('handles a completely different sentence', () => {
      const result = reconcileText('Good morning', 'Where is the exit');
      expect(result.kind).toBe('diverged');
      expect(result.keep).toBe(0);
    });

    it('treats a shortened string as a divergence', () => {
      const result = reconcileText('Hello there', 'Hello');
      expect(result.kind).toBe('diverged');
      expect(result.keep).toBe(5);
    });
  });

  describe('edge cases', () => {
    it('reports no change for identical text', () => {
      const result = reconcileText('Hello', 'Hello');
      expect(result.kind).toBe('unchanged');
      expect(result.keep).toBe(5);
    });

    it('clears on empty text', () => {
      const result = reconcileText('Hello', '');
      expect(result.kind).toBe('cleared');
      expect(result.keep).toBe(0);
    });

    it('handles starting from empty', () => {
      const result = reconcileText('', 'Hello');
      expect(result.kind).toBe('extended');
      expect(result.keep).toBe(0);
    });

    it('handles empty to empty', () => {
      expect(reconcileText('', '').kind).toBe('unchanged');
    });

    it('handles Arabic, where the app spends most of its time', () => {
      const stream = ['أ', 'أي', 'أين', 'أين أ', 'أين أقرب'];
      let previous = '';
      for (const update of stream) {
        expect(reconcileText(previous, update).kind).toBe('extended');
        previous = update;
      }
      expect(previous).toBe('أين أقرب');
    });
  });
});

describe('commonPrefixLength', () => {
  it('counts shared leading characters', () => {
    expect(commonPrefixLength('Hello world', 'Hello there')).toBe(6);
  });

  it('is 0 with nothing in common', () => {
    expect(commonPrefixLength('abc', 'xyz')).toBe(0);
  });

  it('is the full length when one contains the other', () => {
    expect(commonPrefixLength('Hello', 'Hello world')).toBe(5);
  });

  it('handles empty inputs', () => {
    expect(commonPrefixLength('', 'abc')).toBe(0);
    expect(commonPrefixLength('abc', '')).toBe(0);
  });
});

describe('isExtensionOf', () => {
  it('is true for a growing prefix', () => {
    expect(isExtensionOf('Hello', 'Hell')).toBe(true);
    expect(isExtensionOf('Hello', 'Hello')).toBe(true);
  });

  it('is false for a divergence', () => {
    expect(isExtensionOf('Hella', 'Hell0')).toBe(false);
  });

  it('is false when the new text is shorter', () => {
    expect(isExtensionOf('Hell', 'Hello')).toBe(false);
  });
});

describe('grapheme handling', () => {
  /**
   * Slicing by code unit would cut inside a surrogate pair or split a combining
   * mark from its base letter, flashing a replacement glyph mid-animation —
   * exactly the flicker the typewriter is meant to avoid.
   */
  it('keeps an emoji whole', () => {
    expect(toGraphemes('a👋b')).toEqual(['a', '👋', 'b']);
    expect(graphemeLength('a👋b')).toBe(3);
  });

  it('never reveals half of an emoji', () => {
    expect(sliceGraphemes('a👋b', 2)).toBe('a👋');
  });

  it('keeps a family emoji together despite its many codepoints', () => {
    const family = '👨‍👩‍👧‍👦';
    expect(graphemeLength(family)).toBe(1);
    expect(sliceGraphemes(family, 1)).toBe(family);
  });

  it('slices Arabic without separating combining marks', () => {
    const text = 'أين';
    const partial = sliceGraphemes(text, 2);
    expect(text.startsWith(partial)).toBe(true);
  });

  it('returns an empty string for a non-positive count', () => {
    expect(sliceGraphemes('Hello', 0)).toBe('');
    expect(sliceGraphemes('Hello', -1)).toBe('');
  });

  it('returns the whole string when the count exceeds its length', () => {
    expect(sliceGraphemes('Hi', 99)).toBe('Hi');
  });

  it('reveals a string one grapheme at a time, ending exactly at the original', () => {
    const text = 'Hello 👋 world';
    const revealed: string[] = [];
    for (let i = 0; i <= graphemeLength(text); i += 1) revealed.push(sliceGraphemes(text, i));

    expect(revealed[0]).toBe('');
    expect(revealed.at(-1)).toBe(text);
    // Every step must be a prefix of the final text — no duplication anywhere.
    for (const step of revealed) expect(text.startsWith(step)).toBe(true);
  });
});
