import { gsap } from './gsapSetup';

/**
 * Character/word splitting for text reveals.
 *
 * Hand-rolled rather than using GSAP's SplitText because this app renders
 * Arabic, and naive per-character splitting destroys Arabic shaping — letters
 * are cursive and change form based on their neighbours. Wrapping each
 * codepoint in its own element would render "مرحبا" as five disconnected
 * isolated glyphs. So: RTL/complex scripts split by **word**, Latin scripts
 * split by **character**. Grapheme segmentation keeps emoji and combining marks
 * intact in both paths.
 */

export interface SplitResult {
  /** The wrapper elements created, in document order. */
  parts: HTMLElement[];
  /** Restores the original text content. */
  revert: () => void;
  mode: 'chars' | 'words';
}

/** Scripts whose glyphs join or stack, and must never be split per-character. */
const COMPLEX_SCRIPT =
  /[؀-ۿݐ-ݿࢠ-ࣿऀ-ॿ฀-๿ﭐ-﷿ﹰ-﻿]/;

export function isComplexScript(text: string): boolean {
  return COMPLEX_SCRIPT.test(text);
}

function segment(text: string, granularity: 'grapheme' | 'word'): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new (Intl as any).Segmenter(undefined, { granularity });
    return [...segmenter.segment(text)].map((s: { segment: string }) => s.segment);
  }
  return granularity === 'word' ? text.split(/(\s+)/) : [...text];
}

export function splitText(element: HTMLElement, forceMode?: 'chars' | 'words'): SplitResult {
  const original = element.textContent ?? '';
  const mode = forceMode ?? (isComplexScript(original) ? 'words' : 'chars');
  const pieces = segment(original, mode === 'words' ? 'word' : 'grapheme');

  const fragment = document.createDocumentFragment();
  const parts: HTMLElement[] = [];

  for (const piece of pieces) {
    if (piece.trim() === '') {
      fragment.appendChild(document.createTextNode(piece));
      continue;
    }
    const span = document.createElement('span');
    span.className = `split-${mode === 'words' ? 'word' : 'char'}`;
    span.style.display = 'inline-block';
    span.style.willChange = 'transform, opacity';
    // Hidden from assistive tech: `inline-block` makes each piece its own
    // layout box, so a screen reader computing the accessible name from the
    // subtree would announce "S p e a k   n o r m a l l y". The aria-label
    // below carries the real string for as long as the split is in place.
    span.setAttribute('aria-hidden', 'true');
    span.textContent = piece;
    fragment.appendChild(span);
    parts.push(span);
  }

  const previousLabel = element.getAttribute('aria-label');
  element.replaceChildren(fragment);
  element.setAttribute('aria-label', original);

  return {
    parts,
    mode,
    revert: () => {
      element.textContent = original;
      if (previousLabel === null) element.removeAttribute('aria-label');
      else element.setAttribute('aria-label', previousLabel);
    },
  };
}

/**
 * The signature reveal: parts rise from below the baseline while rotating on
 * X in 3D, staggered from the leading edge. Direction follows the text, so
 * Arabic reveals right-to-left the way it reads.
 */
export function revealText(
  element: HTMLElement,
  options: {
    rtl?: boolean;
    delay?: number;
    stagger?: number;
    duration?: number;
    onComplete?: () => void;
  } = {},
): gsap.core.Timeline {
  const { parts, mode, revert } = splitText(element);
  const stagger = options.stagger ?? (mode === 'words' ? 0.055 : 0.022);

  element.style.perspective = '600px';

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    // Collapse back to plain text: hundreds of spans are expensive for the
    // browser to keep laying out, and the flat string is what we want left in
    // the DOM either way.
    revert();
  };

  const tl = gsap.timeline({
    delay: options.delay ?? 0,
    onComplete: () => {
      restore();
      options.onComplete?.();
    },
    // If the timeline is killed before it finishes — a component unmounting, a
    // gsap.context() revert, React's StrictMode double-invoking effects — the
    // spans would otherwise be abandoned at `opacity: 0` and the text would be
    // invisible for good. Restoring here makes the resting state the plain,
    // visible text no matter how the animation ends.
    onInterrupt: restore,
  });

  tl.fromTo(
    parts,
    { yPercent: 110, opacity: 0, rotateX: -75, transformOrigin: '50% 100% -20px' },
    {
      yPercent: 0,
      opacity: 1,
      rotateX: 0,
      duration: options.duration ?? 0.75,
      ease: 'apple-out',
      stagger: { each: stagger, from: options.rtl ? 'end' : 'start' },
    },
  );

  return tl;
}

/**
 * Scramble-in effect used while a translation is still arriving: the target
 * text materialises out of noise. Gives the wait a sense of work happening
 * rather than a spinner doing nothing.
 */
export function scrambleIn(
  element: HTMLElement,
  finalText: string,
  options: { duration?: number; chars?: string } = {},
): gsap.core.Tween {
  const pool = options.chars ?? '▚▞░▒▓█◤◢◣◥╱╲';
  const graphemes = segment(finalText, 'grapheme');
  const state = { progress: 0 };

  return gsap.to(state, {
    progress: 1,
    duration: options.duration ?? 0.9,
    ease: 'apple-inout',
    onUpdate: () => {
      const settled = Math.floor(state.progress * graphemes.length);
      const out = graphemes.map((g, i) => {
        if (i < settled || g.trim() === '') return g;
        return pool[Math.floor(Math.random() * pool.length)]!;
      });
      element.textContent = out.join('');
    },
    onComplete: () => {
      element.textContent = finalText;
    },
  });
}
