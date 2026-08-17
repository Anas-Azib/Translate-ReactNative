/**
 * Text reconciliation for incremental (streaming) updates.
 *
 * This is the logic that prevents the duplication problem: a recogniser that
 * emits `H`, `He`, `Hel`, `Hell`, `Hello` must render `Hello`, never
 * `HHeHelHellHello`. The rule is that each update is the **complete text so
 * far**, not a delta to append — so the renderer's job is to reconcile the new
 * target against what is already on screen, not to concatenate.
 *
 * Kept in `shared` because both the client (for the typewriter) and the server
 * (when deciding whether a new transcript supersedes the previous one) need
 * exactly the same notion of "extends" versus "diverges".
 */

/** Number of leading characters two strings agree on. */
export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

/** True when `next` is `previous` plus more text on the end. */
export function isExtensionOf(next: string, previous: string): boolean {
  return next.length >= previous.length && next.startsWith(previous);
}

export type TextUpdateKind =
  /** Nothing changed. */
  | 'unchanged'
  /** `next` continues `previous` — keep typing from where we are. */
  | 'extended'
  /** `next` diverges — rewind to the shared prefix, then type forward. */
  | 'diverged'
  /** `next` is empty — clear. */
  | 'cleared';

export interface TextUpdate {
  kind: TextUpdateKind;
  /**
   * How many characters of the currently-displayed text remain valid. The
   * renderer should show at most this many before typing the rest.
   */
  keep: number;
  next: string;
}

/**
 * Decides how to move the display from `previous` to `next`.
 *
 * The `extended` case is the important one: because we keep the already-typed
 * characters, a stream of growing prefixes types out smoothly and continuously
 * instead of restarting the animation on every update — which is what causes
 * the flicker the naive implementation suffers from.
 */
export function reconcileText(previous: string, next: string): TextUpdate {
  if (next === previous) return { kind: 'unchanged', keep: previous.length, next };
  if (next.length === 0) return { kind: 'cleared', keep: 0, next };
  if (isExtensionOf(next, previous)) return { kind: 'extended', keep: previous.length, next };
  // Rewind only as far as the first genuine disagreement. A late correction
  // like "Hello ther" → "Hello there" must not retype the whole sentence.
  return { kind: 'diverged', keep: commonPrefixLength(previous, next), next };
}

/**
 * Splits text into grapheme clusters so the typewriter never reveals half of an
 * emoji or separates a combining mark from its base letter.
 */
export function toGraphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new (Intl as unknown as {
      Segmenter: new (locale?: string, options?: { granularity: string }) => {
        segment: (input: string) => Iterable<{ segment: string }>;
      };
    }).Segmenter(undefined, { granularity: 'grapheme' });
    return [...segmenter.segment(text)].map((s) => s.segment);
  }
  return [...text];
}

/** Grapheme count, which is what "letters" means to a reader. */
export function graphemeLength(text: string): number {
  return toGraphemes(text).length;
}

/**
 * Takes the first `count` grapheme clusters.
 *
 * Slicing by code unit would be faster but can cut inside a surrogate pair or
 * an Arabic combining sequence, briefly rendering a replacement glyph — exactly
 * the flicker this animation is supposed to avoid.
 */
export function sliceGraphemes(text: string, count: number): string {
  if (count <= 0) return '';
  const graphemes = toGraphemes(text);
  if (count >= graphemes.length) return text;
  return graphemes.slice(0, count).join('');
}
