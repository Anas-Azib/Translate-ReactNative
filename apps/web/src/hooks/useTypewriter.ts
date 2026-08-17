import { useEffect, useRef, useState } from 'react';
import { reconcileText, sliceGraphemes, toGraphemes } from '@translate/shared';

export interface TypewriterOptions {
  /** Characters revealed per second. */
  charsPerSecond?: number;
  /**
   * Skip the animation and show text immediately. Wired to
   * `prefers-reduced-motion` by the caller.
   */
  instant?: boolean;
  /** Fired once the display has caught up with the target. */
  onSettled?: () => void;
}

export interface TypewriterResult {
  /** What to render right now. */
  text: string;
  /** True while characters are still being revealed. */
  typing: boolean;
}

/**
 * Reveals text one grapheme at a time, reconciling against what is already on
 * screen instead of restarting.
 *
 * ── Why it is written this way ──────────────────────────────────────────────
 *
 * Each update carries the **complete text so far**, not a delta. A stream of
 * `H`, `He`, `Hel`, `Hell`, `Hello` must end as `Hello`, never
 * `HHeHelHellHello`. Appending would produce the second; reconciling produces
 * the first. `reconcileText` classifies each update:
 *
 *  - *extended* — keep every revealed character and carry on typing. This is
 *    what makes a fast stream look like one continuous animation rather than a
 *    restart per update, and it is where the flicker in naive implementations
 *    comes from.
 *  - *diverged* — a correction arrived. Rewind only to the first character that
 *    actually differs, so "Hello ther" → "Hello there" does not retype the
 *    sentence.
 *  - *cleared* / *unchanged* — handled without touching the timer.
 *
 * Animation runs on `requestAnimationFrame` against elapsed time, not one
 * `setTimeout` per character: the reveal stays smooth on a slow device, and
 * React re-renders only when the visible grapheme count actually changes, not
 * on every frame.
 *
 * Each call site owns an independent instance, so the source text and the
 * translation animate concurrently and neither blocks the other.
 */
export function useTypewriter(target: string, options: TypewriterOptions = {}): TypewriterResult {
  const { charsPerSecond = 45, instant = false } = options;

  const [display, setDisplay] = useState('');
  const [typing, setTyping] = useState(false);

  // Everything the animation loop needs lives in refs: the loop must not
  // re-subscribe on every render, and these values change mid-flight.
  const targetRef = useRef('');
  const graphemesRef = useRef<string[]>([]);
  const revealedRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);
  const carryRef = useRef(0);
  const settledRef = useRef(options.onSettled);
  settledRef.current = options.onSettled;
  /**
   * Starts the animation loop if it is not already running.
   *
   * The loop stops itself once the display has caught up, so it cannot be
   * owned by a mount-only effect: text that arrives *after* the previous reveal
   * settled — which is every segment after the first — would then never animate.
   * Assigned in the loop effect below and called whenever new work appears.
   */
  const ensureLoopRef = useRef<() => void>(() => {});

  useEffect(() => {
    const previous = targetRef.current;
    const update = reconcileText(previous, target);

    if (update.kind === 'unchanged') return;

    targetRef.current = target;
    graphemesRef.current = toGraphemes(target);

    if (update.kind === 'cleared') {
      revealedRef.current = 0;
      carryRef.current = 0;
      setDisplay('');
      setTyping(false);
      return;
    }

    // Clamp the reveal head to what remains valid. For an extension this is a
    // no-op — which is precisely the point: the animation continues rather
    // than restarting.
    const keepGraphemes = update.keep > 0 ? toGraphemes(previous.slice(0, update.keep)).length : 0;
    revealedRef.current = Math.min(revealedRef.current, keepGraphemes);

    if (instant) {
      revealedRef.current = graphemesRef.current.length;
      setDisplay(target);
      setTyping(false);
      settledRef.current?.();
      return;
    }

    if (update.kind === 'diverged') {
      // Show the surviving prefix straight away so the correction does not
      // flash the old, wrong tail.
      setDisplay(sliceGraphemes(target, revealedRef.current));
    }

    const hasWork = revealedRef.current < graphemesRef.current.length;
    setTyping(hasWork);
    // Wake the loop: it parks itself whenever it catches up.
    if (hasWork) ensureLoopRef.current();
  }, [target, instant]);

  useEffect(() => {
    if (instant) return;

    const step = (now: number) => {
      const total = graphemesRef.current.length;

      if (revealedRef.current >= total) {
        // Caught up — park the loop instead of burning a frame every 16 ms
        // waiting for text that may never come. `ensureLoop` restarts it.
        rafRef.current = null;
        lastFrameRef.current = 0;
        carryRef.current = 0;
        setTyping((was) => {
          if (was) settledRef.current?.();
          return false;
        });
        return;
      }

      if (lastFrameRef.current === 0) lastFrameRef.current = now;
      const elapsed = now - lastFrameRef.current;
      lastFrameRef.current = now;

      // Accumulate fractional characters so the rate is honoured regardless of
      // frame rate, instead of being quantised to one char per frame.
      carryRef.current += (elapsed / 1000) * charsPerSecond;
      const advance = Math.floor(carryRef.current);

      if (advance > 0) {
        carryRef.current -= advance;
        const next = Math.min(total, revealedRef.current + advance);
        if (next !== revealedRef.current) {
          revealedRef.current = next;
          // The only setState in the loop, and only when the visible text
          // genuinely changed.
          setDisplay(sliceGraphemes(targetRef.current, next));
        }
      }

      rafRef.current = requestAnimationFrame(step);
    };

    const ensureLoop = () => {
      // Guard on the handle, not a boolean: one loop at a time, so a burst of
      // updates cannot stack several rAF chains and reveal at multiple speeds.
      if (rafRef.current !== null) return;
      lastFrameRef.current = 0;
      rafRef.current = requestAnimationFrame(step);
    };
    ensureLoopRef.current = ensureLoop;

    // Start now if text was already set before this effect ran.
    if (revealedRef.current < graphemesRef.current.length) ensureLoop();

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastFrameRef.current = 0;
      ensureLoopRef.current = () => {};
    };
  }, [charsPerSecond, instant]);

  return { text: display, typing };
}

/**
 * Reveals text without animation — used when the caller only needs the
 * reconciliation semantics (no duplication) and not the motion.
 */
export function useReconciledText(target: string): string {
  return useTypewriter(target, { instant: true }).text;
}
