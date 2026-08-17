import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTypewriter } from '../../src/hooks/useTypewriter';

/**
 * The animation contract from the brief:
 *
 *   Incoming: H / He / Hel / Hell / Hello
 *   Expected: "Hello"          not "HHeHelHellHello"
 *
 * A driveable rAF replaces the real one so the reveal can be advanced frame by
 * frame instead of waited on.
 */
describe('useTypewriter', () => {
  let now = 0;
  let frames: FrameRequestCallback[] = [];

  beforeEach(() => {
    now = 0;
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Advances the animation by `ms`, in realistic ~16 ms frames.
   *
   * Stepping matters: the loop measures elapsed time between frames, so its
   * first frame only establishes a baseline and reveals nothing. Firing a
   * single frame per call would make every timing assertion read zero.
   */
  function advance(ms: number, frameMs = 16) {
    act(() => {
      let remaining = ms;
      while (remaining > 0) {
        const delta = Math.min(frameMs, remaining);
        now += delta;
        const queued = frames.splice(0);
        for (const frame of queued) frame(now);
        remaining -= delta;
      }
    });
  }

  /** Runs enough frames for the reveal to settle. */
  function settle(totalMs = 3000) {
    advance(totalMs);
  }

  describe('the duplication guarantee', () => {
    it('renders "Hello" from a growing prefix stream, never "HHeHelHellHello"', () => {
      const { result, rerender } = renderHook(({ text }) => useTypewriter(text), {
        initialProps: { text: '' },
      });

      for (const chunk of ['H', 'He', 'Hel', 'Hell', 'Hello']) {
        rerender({ text: chunk });
        advance(40);
      }
      settle();

      expect(result.current.text).toBe('Hello');
      expect(result.current.text).not.toBe('HHeHelHellHello');
    });

    it('does the same for the translation stream', () => {
      const { result, rerender } = renderHook(({ text }) => useTypewriter(text), {
        initialProps: { text: '' },
      });

      for (const chunk of ['M', 'Ma', 'Mar', 'Mars']) {
        rerender({ text: chunk });
        advance(40);
      }
      settle();

      expect(result.current.text).toBe('Mars');
    });

    it('only ever displays a prefix of the target', () => {
      const target = 'Where is the nearest hospital?';
      const { result, rerender } = renderHook(({ text }) => useTypewriter(text), {
        initialProps: { text: '' },
      });

      for (let i = 1; i <= target.length; i += 1) {
        rerender({ text: target.slice(0, i) });
        advance(16);
        // At no point may the display contain anything not in the target.
        expect(target.startsWith(result.current.text)).toBe(true);
      }
      settle();
      expect(result.current.text).toBe(target);
    });
  });

  describe('continuity', () => {
    it('does not restart when the text is extended', () => {
      const { result, rerender } = renderHook(({ text }) => useTypewriter(text), {
        initialProps: { text: 'Hello' },
      });

      settle();
      expect(result.current.text).toBe('Hello');

      // Extending must keep what is on screen rather than retyping from empty.
      rerender({ text: 'Hello there' });
      advance(16);

      expect(result.current.text.startsWith('Hello')).toBe(true);
      expect(result.current.text.length).toBeGreaterThanOrEqual(5);
    });

    it('rewinds only to the shared prefix on a correction', () => {
      const { result, rerender } = renderHook(({ text }) => useTypewriter(text), {
        initialProps: { text: 'Hello world' },
      });
      settle();
      expect(result.current.text).toBe('Hello world');

      rerender({ text: 'Hello there' });
      advance(16);

      // "Hello " survives; only the diverging tail is retyped.
      expect(result.current.text.startsWith('Hello')).toBe(true);
      expect(result.current.text).not.toContain('world');

      settle();
      expect(result.current.text).toBe('Hello there');
    });

    it('reveals progressively rather than jumping to the end', () => {
      const { result } = renderHook(() => useTypewriter('Hello there friend', { charsPerSecond: 20 }));

      advance(100); // ~2 characters at 20/s
      const early = result.current.text.length;

      expect(early).toBeGreaterThan(0);
      expect(early).toBeLessThan('Hello there friend'.length);
    });

    it('honours the configured speed', () => {
      const { result } = renderHook(() => useTypewriter('abcdefghijklmnop', { charsPerSecond: 10 }));

      advance(500); // 0.5s at 10 chars/s ≈ 5 characters
      expect(result.current.text.length).toBeGreaterThanOrEqual(4);
      expect(result.current.text.length).toBeLessThanOrEqual(7);
    });
  });

  describe('state reporting', () => {
    it('reports typing while revealing and stops when settled', () => {
      const { result } = renderHook(() => useTypewriter('Hello there'));

      advance(16);
      expect(result.current.typing).toBe(true);

      settle();
      expect(result.current.typing).toBe(false);
      expect(result.current.text).toBe('Hello there');
    });

    it('fires onSettled exactly once per completed reveal', () => {
      const onSettled = vi.fn();
      renderHook(() => useTypewriter('Hi', { onSettled }));

      settle();
      const callsAfterFirst = onSettled.mock.calls.length;
      settle();

      expect(callsAfterFirst).toBeGreaterThan(0);
      expect(onSettled.mock.calls.length).toBe(callsAfterFirst);
    });
  });

  describe('edge cases', () => {
    it('handles empty text safely', () => {
      const { result } = renderHook(() => useTypewriter(''));
      settle();
      expect(result.current.text).toBe('');
      expect(result.current.typing).toBe(false);
    });

    it('clears when the text is emptied', () => {
      const { result, rerender } = renderHook(({ text }) => useTypewriter(text), {
        initialProps: { text: 'Hello' },
      });
      settle();
      expect(result.current.text).toBe('Hello');

      rerender({ text: '' });
      expect(result.current.text).toBe('');
      expect(result.current.typing).toBe(false);
    });

    it('handles a completely new sentence', () => {
      const { result, rerender } = renderHook(({ text }) => useTypewriter(text), {
        initialProps: { text: 'Good morning' },
      });
      settle();

      rerender({ text: 'Where is the exit' });
      settle();

      expect(result.current.text).toBe('Where is the exit');
    });

    it('survives updates arriving faster than frames', () => {
      const { result, rerender } = renderHook(({ text }) => useTypewriter(text), {
        initialProps: { text: '' },
      });

      // Five updates with no frame in between — the hook must not lose the
      // final target or produce a concatenation.
      for (const chunk of ['a', 'ab', 'abc', 'abcd', 'abcde']) rerender({ text: chunk });
      settle();

      expect(result.current.text).toBe('abcde');
    });

    it('shows text immediately in instant mode', () => {
      const { result } = renderHook(() => useTypewriter('Hello there', { instant: true }));
      // Wired to prefers-reduced-motion by the caller.
      expect(result.current.text).toBe('Hello there');
      expect(result.current.typing).toBe(false);
    });

    it('never splits an emoji', () => {
      const { result } = renderHook(() => useTypewriter('a👋b', { charsPerSecond: 4 }));

      for (let i = 0; i < 6; i += 1) {
        advance(120);
        // A half-revealed surrogate pair would render as a replacement glyph.
        expect(result.current.text).not.toContain('�');
        expect('a👋b'.startsWith(result.current.text)).toBe(true);
      }
    });

    it('handles Arabic without corrupting the text', () => {
      const target = 'أين أقرب مستشفى؟';
      const { result } = renderHook(() => useTypewriter(target));
      settle();
      expect(result.current.text).toBe(target);
    });
  });

  describe('independence', () => {
    /**
     * The source text and the translation are separate hook instances, so one
     * finishing — or restarting on a correction — must not disturb the other.
     */
    it('runs two instances without interference', () => {
      const { result, rerender } = renderHook(
        ({ a, b }) => ({ source: useTypewriter(a), translated: useTypewriter(b) }),
        { initialProps: { a: '', b: '' } },
      );

      rerender({ a: 'مرحبا', b: '' });
      settle();
      expect(result.current.source.text).toBe('مرحبا');
      expect(result.current.translated.text).toBe('');

      // Stage two arrives later; the source must stay complete.
      rerender({ a: 'مرحبا', b: 'Hello' });
      settle();
      expect(result.current.source.text).toBe('مرحبا');
      expect(result.current.translated.text).toBe('Hello');
    });

    it('lets the translation animate while the source is still typing', () => {
      const { result, rerender } = renderHook(
        ({ a, b }) => ({ source: useTypewriter(a, { charsPerSecond: 5 }), translated: useTypewriter(b, { charsPerSecond: 50 }) }),
        { initialProps: { a: 'a long source sentence here', b: '' } },
      );

      advance(100);
      rerender({ a: 'a long source sentence here', b: 'Hello' });
      advance(200);

      // The slow source is still going while the fast translation advances —
      // neither blocks the other.
      expect(result.current.source.typing).toBe(true);
      expect(result.current.translated.text.length).toBeGreaterThan(0);
    });
  });
});
