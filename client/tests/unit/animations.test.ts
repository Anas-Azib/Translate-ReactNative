import { describe, expect, it, beforeAll } from 'vitest';
import { setupGsap, gsap, seededRange } from '../../src/animations/gsapSetup';
import { isComplexScript, revealText, splitText } from '../../src/animations/splitText';
import { ORB_SHAPES } from '../../src/animations/micOrb';
import { formatDuration } from '../../src/components/ui/QuotaMeter';

beforeAll(() => {
  setupGsap();
});

describe('gsapSetup', () => {
  it('registers the Apple-style custom eases', () => {
    // Every animation in the app references these by name; a missing ease
    // silently degrades to linear motion everywhere.
    for (const name of ['apple-out', 'apple-spring', 'apple-inout', 'haptic']) {
      expect(gsap.parseEase(name)).toBeTypeOf('function');
    }
  });

  it('produces eases that start at 0 and end at 1', () => {
    const ease = gsap.parseEase('apple-out')!;
    expect(ease(0)).toBeCloseTo(0, 3);
    expect(ease(1)).toBeCloseTo(1, 3);
  });

  it('gives apple-spring an overshoot — that is what makes it feel springy', () => {
    const ease = gsap.parseEase('apple-spring')!;
    const samples = Array.from({ length: 50 }, (_, i) => ease(i / 49));
    expect(Math.max(...samples)).toBeGreaterThan(1);
  });

  it('is idempotent, so repeated setup calls are harmless', () => {
    expect(setupGsap()).toBe(setupGsap());
  });

  it('sets a default ease so unstyled tweens still match the app', () => {
    // GSAP resolves the registered name into the ease function itself.
    expect(gsap.defaults().ease).toBe(gsap.parseEase('apple-out'));
  });
});

describe('seededRange', () => {
  it('is deterministic for a given seed', () => {
    expect(seededRange(3, 0, 10)).toBe(seededRange(3, 0, 10));
  });

  it('stays inside the requested range', () => {
    for (let i = 1; i < 200; i += 1) {
      const value = seededRange(i, 5, 15);
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThanOrEqual(15);
    }
  });

  it('produces different values for different seeds', () => {
    expect(seededRange(1, 0, 100)).not.toBe(seededRange(2, 0, 100));
  });
});

describe('splitText', () => {
  it('splits Latin text into characters', () => {
    const element = document.createElement('p');
    element.textContent = 'Hello';

    const result = splitText(element);

    expect(result.mode).toBe('chars');
    expect(result.parts).toHaveLength(5);
    expect(result.parts.map((p) => p.textContent).join('')).toBe('Hello');
  });

  it('splits Arabic by word, never by character', () => {
    // Per-character splitting breaks Arabic letter joining — "مرحبا" would
    // render as five disconnected isolated forms.
    const element = document.createElement('p');
    element.textContent = 'مرحبا كيف حالك';

    const result = splitText(element);

    expect(result.mode).toBe('words');
    expect(result.parts).toHaveLength(3);
    expect(result.parts[0]!.textContent).toBe('مرحبا');
  });

  it('preserves spaces as text nodes so words do not run together', () => {
    const element = document.createElement('p');
    element.textContent = 'a b';

    splitText(element);

    expect(element.textContent).toBe('a b');
  });

  it('restores the original text on revert', () => {
    const element = document.createElement('p');
    element.textContent = 'Hello world';

    const result = splitText(element);
    expect(element.querySelectorAll('span').length).toBeGreaterThan(0);

    result.revert();

    expect(element.textContent).toBe('Hello world');
    expect(element.querySelectorAll('span')).toHaveLength(0);
  });

  it('keeps the accessible name intact while the text is split', () => {
    // Each piece is its own inline-block, so without this the name computes
    // as "H e l l o   w o r l d".
    const element = document.createElement('h1');
    element.textContent = 'Speak normally';

    const result = splitText(element);

    expect(element).toHaveAttribute('aria-label', 'Speak normally');
    for (const part of result.parts) {
      expect(part).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('removes the temporary aria-label on revert', () => {
    const element = document.createElement('h1');
    element.textContent = 'Speak normally';

    splitText(element).revert();

    expect(element).not.toHaveAttribute('aria-label');
  });

  it('leaves the text visible when the reveal is killed part-way', () => {
    // A backgrounded tab, an unmount, or a gsap.context() revert can kill the
    // timeline mid-flight. The text must never be stranded at opacity 0.
    const element = document.createElement('h1');
    element.textContent = 'Speak normally';

    const tl = revealText(element);
    tl.progress(0.3);
    tl.kill();

    expect(element.textContent).toBe('Speak normally');
    expect(element.querySelectorAll('span')).toHaveLength(0);
    expect(element).not.toHaveAttribute('aria-label');
  });

  it('restores a pre-existing aria-label rather than deleting it', () => {
    const element = document.createElement('h1');
    element.textContent = 'Speak normally';
    element.setAttribute('aria-label', 'Custom label');

    splitText(element).revert();

    expect(element).toHaveAttribute('aria-label', 'Custom label');
  });

  it('keeps an emoji as a single unit rather than splitting surrogate pairs', () => {
    const element = document.createElement('p');
    element.textContent = 'a👋b';

    const result = splitText(element);

    expect(result.parts).toHaveLength(3);
    expect(result.parts[1]!.textContent).toBe('👋');
  });

  it('honours a forced mode', () => {
    const element = document.createElement('p');
    element.textContent = 'Hello world';

    expect(splitText(element, 'words').parts).toHaveLength(2);
  });

  it('handles empty text without throwing', () => {
    const element = document.createElement('p');
    element.textContent = '';

    expect(() => splitText(element)).not.toThrow();
  });
});

describe('isComplexScript', () => {
  it.each([
    ['مرحبا', true],
    ['اردو', true],
    ['नमस्ते', true],
    ['Hello', false],
    ['Bonjour ça va', false],
    ['你好', false],
  ])('classifies %s as complex=%s', (text, expected) => {
    expect(isComplexScript(text)).toBe(expected);
  });
});

describe('ORB_SHAPES', () => {
  it('gives every state a path', () => {
    expect(Object.keys(ORB_SHAPES)).toEqual(['idle', 'listening', 'processing']);
  });

  it('uses the same command structure so MorphSVG can interpolate cleanly', () => {
    // Different command counts make MorphSVG fall back to its slower, less
    // predictable path-matching, which visibly wobbles.
    const commandCounts = Object.values(ORB_SHAPES).map(
      (path) => (path.match(/[MCZ]/gi) ?? []).length,
    );
    expect(new Set(commandCounts).size).toBe(1);
  });

  it('closes every path', () => {
    for (const path of Object.values(ORB_SHAPES)) {
      expect(path.trim().endsWith('Z')).toBe(true);
    }
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [59, '0:59'],
    [60, '1:00'],
    [125, '2:05'],
    [600, '10:00'],
  ])('formats %i seconds as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it('never shows a negative time', () => {
    expect(formatDuration(-30)).toBe('0:00');
  });

  it('rounds to the nearest second', () => {
    expect(formatDuration(59.6)).toBe('1:00');
  });
});
