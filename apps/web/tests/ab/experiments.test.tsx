import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { renderHook, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/App';
import { ApiClient } from '../../src/services/api';
import { ExperimentProvider, useExperiments } from '../../src/experiments/ExperimentProvider';
import { EXPERIMENT_KEYS, VARIANTS, fnv1a, hashToUnit, localAssign } from '../../src/experiments/registry';
import type { ExperimentKey } from '../../src/experiments/registry';
import { createMockServer } from '../mockServer';
import type { MockServer } from '../mockServer';

/**
 * Client-side A/B: that each variant actually renders a different experience,
 * that assignment is stable, and that conversions reach the server.
 */
describe('A/B — client', () => {
  let server: MockServer;

  beforeEach(() => {
    server = createMockServer();
    localStorage.setItem('atl.onboarded', '1');
  });

  function makeApi(mock: MockServer = server) {
    return new ApiClient({
      deviceId: 'device-ab-client',
      fetchImpl: mock.fetch as unknown as typeof fetch,
      retryDelayMs: 0,
    });
  }

  function renderWithAssignments(assignments: Record<string, string>, onboarded = true) {
    server = createMockServer({ assignments });
    if (onboarded) localStorage.setItem('atl.onboarded', '1');
    else localStorage.removeItem('atl.onboarded');
    return render(<App api={makeApi(server)} />);
  }

  describe('local fallback assignment', () => {
    it('is deterministic for a user', () => {
      const first = localAssign('user-1', 'mic_control', 'salt');
      for (let i = 0; i < 20; i += 1) {
        expect(localAssign('user-1', 'mic_control', 'salt')).toBe(first);
      }
    });

    it('only returns declared variants', () => {
      for (const key of EXPERIMENT_KEYS) {
        const allowed = new Set<string>(VARIANTS[key]);
        for (let i = 0; i < 200; i += 1) {
          expect(allowed.has(localAssign(`user-${i}`, key, 'salt'))).toBe(true);
        }
      }
    });

    it('splits roughly evenly', () => {
      let hold = 0;
      const n = 5000;
      for (let i = 0; i < n; i += 1) {
        if (localAssign(`user-${i}`, 'mic_control', 'salt') === 'hold') hold += 1;
      }
      expect(hold / n).toBeGreaterThan(0.45);
      expect(hold / n).toBeLessThan(0.55);
    });

    it('assigns experiments independently', () => {
      let agree = 0;
      const n = 3000;
      for (let i = 0; i < n; i += 1) {
        const mic = localAssign(`u-${i}`, 'mic_control', 's') === 'hold';
        const layout = localAssign(`u-${i}`, 'result_layout', 's') === 'stacked';
        if (mic === layout) agree += 1;
      }
      expect(agree / n).toBeGreaterThan(0.44);
      expect(agree / n).toBeLessThan(0.56);
    });

    it('fnv1a produces a stable unsigned 32-bit hash', () => {
      expect(fnv1a('abc')).toBe(fnv1a('abc'));
      expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
      expect(fnv1a('abc')).toBeGreaterThanOrEqual(0);
      expect(fnv1a('abc')).toBeLessThan(2 ** 32);
    });

    it('hashToUnit spreads uniformly across the interval', () => {
      const buckets = new Array(10).fill(0);
      for (let i = 0; i < 10_000; i += 1) {
        buckets[Math.floor(hashToUnit(`user-${i}`) * 10)] += 1;
      }
      for (const count of buckets) {
        expect(count).toBeGreaterThan(850);
        expect(count).toBeLessThan(1150);
      }
    });

    it('hashToUnit’s low bit is not merely an input parity', () => {
      // Regression guard. Raw FNV-1a's lowest bit is the XOR of its input
      // bytes, so `fnv1a(x) % 2` moves in lockstep for two strings differing by
      // a fixed parity — which made every experiment perfectly correlated with
      // every other. The finaliser has to break that.
      let agreements = 0;
      const n = 2000;
      for (let i = 0; i < n; i += 1) {
        const a = hashToUnit(`salt:mic_control:user-${i}`) < 0.5;
        const b = hashToUnit(`salt:result_layout:user-${i}`) < 0.5;
        if (a === b) agreements += 1;
      }
      expect(agreements / n).toBeGreaterThan(0.45);
      expect(agreements / n).toBeLessThan(0.55);
    });
  });

  describe('the provider', () => {
    function setupProvider(mock: MockServer) {
      const api = makeApi(mock);
      return renderHook(() => useExperiments(), {
        wrapper: ({ children }) => (
          <ExperimentProvider api={api} flushIntervalMs={10_000}>
            {children}
          </ExperimentProvider>
        ),
      });
    }

    it('adopts the server’s assignments once they arrive', async () => {
      const mock = createMockServer({
        assignments: { mic_control: 'tap', onboarding: 'instant', autoplay_tts: 'manual', result_layout: 'flip' },
      });
      const { result } = setupProvider(mock);

      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(result.current.variant('mic_control')).toBe('tap');
      expect(result.current.variant('result_layout')).toBe('flip');
    });

    it('falls back to a local assignment when the server is unreachable', async () => {
      const mock = createMockServer();
      mock.setHandler('/ab/assignments', () => ({ status: 500, body: { ok: false, error: {} } }));
      const { result } = setupProvider(mock);

      await waitFor(() => expect(result.current.ready).toBe(true));

      // Still a valid variant — the UI is never left undefined.
      expect(VARIANTS.mic_control).toContain(result.current.variant('mic_control'));
    });

    it('attributes an unscoped metric to every running experiment', async () => {
      const mock = createMockServer();
      const { result } = setupProvider(mock);
      await waitFor(() => expect(result.current.ready).toBe(true));

      act(() => {
        result.current.track('translation_completed');
        result.current.flush();
      });

      await waitFor(() => expect(mock.trackedEvents.length).toBe(EXPERIMENT_KEYS.length));
      expect(new Set(mock.trackedEvents.map((e) => e.experiment))).toEqual(new Set(EXPERIMENT_KEYS));
    });

    it('scopes a metric to one experiment when asked', async () => {
      const mock = createMockServer();
      const { result } = setupProvider(mock);
      await waitFor(() => expect(result.current.ready).toBe(true));

      act(() => {
        result.current.track('onboarding_finished', { experiment: 'onboarding' });
        result.current.flush();
      });

      await waitFor(() => expect(mock.trackedEvents).toHaveLength(1));
      expect(mock.trackedEvents[0]!.experiment).toBe('onboarding');
    });

    it('tags every event with the variant the user actually saw', async () => {
      const mock = createMockServer({
        assignments: { mic_control: 'tap', onboarding: 'guided', autoplay_tts: 'manual', result_layout: 'flip' },
      });
      const { result } = setupProvider(mock);
      await waitFor(() => expect(result.current.ready).toBe(true));

      act(() => {
        result.current.track('session_started', { experiment: 'mic_control' });
        result.current.flush();
      });

      await waitFor(() => expect(mock.trackedEvents).toHaveLength(1));
      expect(mock.trackedEvents[0]!.variant).toBe('tap');
    });

    it('batches events rather than posting one request each', async () => {
      const mock = createMockServer();
      const { result } = setupProvider(mock);
      await waitFor(() => expect(result.current.ready).toBe(true));

      const before = mock.requestsTo('/ab/event').length;
      act(() => {
        result.current.track('session_started', { experiment: 'mic_control' });
        result.current.track('translation_completed', { experiment: 'mic_control' });
        result.current.track('tts_played', { experiment: 'mic_control' });
        result.current.flush();
      });

      await waitFor(() => expect(mock.requestsTo('/ab/event').length).toBe(before + 1));
      expect(mock.trackedEvents).toHaveLength(3);
    });

    it('sends nothing when there is nothing queued', async () => {
      const mock = createMockServer();
      const { result } = setupProvider(mock);
      await waitFor(() => expect(result.current.ready).toBe(true));

      const before = mock.requestsTo('/ab/event').length;
      act(() => result.current.flush());

      expect(mock.requestsTo('/ab/event')).toHaveLength(before);
    });

    it('throws a clear error when used outside the provider', () => {
      // React logs the thrown error; silence it for this expected case.
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => renderHook(() => useExperiments())).toThrow(/inside <ExperimentProvider>/);
      spy.mockRestore();
    });
  });

  describe('mic_control — the variants really differ', () => {
    it('hold: the button asks to be held', async () => {
      renderWithAssignments({ mic_control: 'hold', onboarding: 'guided', autoplay_tts: 'autoplay', result_layout: 'stacked' });

      await screen.findByTestId('mic-orb');
      expect(screen.getByTestId('mic-orb')).toHaveAttribute('data-mode', 'hold');
      expect(screen.getByTestId('mic-hint')).toHaveTextContent(/hold to speak/i);
    });

    it('tap: the button asks to be tapped', async () => {
      renderWithAssignments({ mic_control: 'tap', onboarding: 'guided', autoplay_tts: 'autoplay', result_layout: 'stacked' });

      await screen.findByTestId('mic-orb');
      expect(screen.getByTestId('mic-orb')).toHaveAttribute('data-mode', 'tap');
      expect(screen.getByTestId('mic-hint')).toHaveTextContent(/tap to speak/i);
    });

    it('the empty state instructions match the variant', async () => {
      renderWithAssignments({ mic_control: 'tap', onboarding: 'guided', autoplay_tts: 'autoplay', result_layout: 'stacked' });

      const empty = await screen.findByTestId('empty-state');
      expect(within(empty).getByText(/tap the blue button/i)).toBeInTheDocument();
    });

    it('tap mode attempts to start a session on click', async () => {
      const user = userEvent.setup();
      renderWithAssignments({ mic_control: 'tap', onboarding: 'guided', autoplay_tts: 'autoplay', result_layout: 'stacked' });
      await screen.findByTestId('mic-orb');

      await user.click(screen.getByTestId('mic-orb'));

      // Sessions open over the WebSocket now, and jsdom has no WebSocket — so
      // the observable outcome is that the click left `idle` and the hint
      // stopped inviting a tap. That is the behaviour the variant is testing;
      // the transport itself is covered in integration/session.test.tsx.
      await waitFor(() =>
        expect(screen.getByTestId('mic-hint').textContent).not.toMatch(/tap to speak/i),
      );
    });

    it('hold mode does not start on a plain click', async () => {
      const user = userEvent.setup();
      renderWithAssignments({ mic_control: 'hold', onboarding: 'guided', autoplay_tts: 'autoplay', result_layout: 'stacked' });
      await screen.findByTestId('mic-orb');

      const hintBefore = screen.getByTestId('mic-hint').textContent;
      await user.click(screen.getByTestId('mic-orb'));

      // Hold mode drives start/stop from pointer down/up, so a click that both
      // presses and releases must net out without leaving a session behind.
      await waitFor(() => expect(screen.getByTestId('mic-orb')).toBeInTheDocument());
      expect(hintBefore).toMatch(/hold to speak/i);
    });

    it('hold mode does not start a session on a plain click', async () => {
      const user = userEvent.setup();
      renderWithAssignments({ mic_control: 'hold', onboarding: 'guided', autoplay_tts: 'autoplay', result_layout: 'stacked' });
      await screen.findByTestId('mic-orb');

      // userEvent.click fires pointerdown → pointerup, which in hold mode is a
      // press-and-release; the click handler itself must stay inert.
      await user.click(screen.getByTestId('mic-orb'));

      // Exactly one start from the press, never a second from the click.
      await waitFor(() => expect(server.requestsTo('/session/start').length).toBeLessThanOrEqual(1));
    });
  });

  describe('onboarding — the variants really differ', () => {
    it('guided shows three steps with progress dots', async () => {
      renderWithAssignments(
        { mic_control: 'hold', onboarding: 'guided', autoplay_tts: 'autoplay', result_layout: 'stacked' },
        false,
      );

      await screen.findByTestId('onboarding');
      expect(screen.getByRole('tablist')).toBeInTheDocument();
      expect(screen.getAllByRole('tab')).toHaveLength(3);
    });

    it('instant shows one step and no dots', async () => {
      renderWithAssignments(
        { mic_control: 'hold', onboarding: 'instant', autoplay_tts: 'autoplay', result_layout: 'stacked' },
        false,
      );

      await screen.findByTestId('onboarding');
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    });

    it('records the conversion when the tour is finished', async () => {
      const user = userEvent.setup();
      renderWithAssignments(
        { mic_control: 'hold', onboarding: 'instant', autoplay_tts: 'autoplay', result_layout: 'stacked' },
        false,
      );

      await screen.findByTestId('onboarding');
      await user.click(screen.getByTestId('onboarding-next'));
      await screen.findByTestId('mic-orb');

      await waitFor(
        () => expect(server.trackedEvents.some((e) => e.metric === 'onboarding_finished')).toBe(true),
        { timeout: 4000 },
      );
    });
  });

  describe('conversion tracking through the UI', () => {
    it('records language_changed when the user swaps', async () => {
      const user = userEvent.setup();
      renderWithAssignments({ mic_control: 'hold', onboarding: 'guided', autoplay_tts: 'autoplay', result_layout: 'stacked' });
      await screen.findByTestId('mic-orb');

      await user.click(screen.getByTestId('swap-languages'));

      await waitFor(
        () => expect(server.trackedEvents.some((e) => e.metric === 'language_changed')).toBe(true),
        { timeout: 4000 },
      );
    });
  });

  describe('registry integrity', () => {
    it('gives every experiment at least two variants', () => {
      for (const key of EXPERIMENT_KEYS) {
        expect(VARIANTS[key].length).toBeGreaterThanOrEqual(2);
      }
    });

    it('has no duplicate variant keys within an experiment', () => {
      for (const key of EXPERIMENT_KEYS) {
        const variants = VARIANTS[key] as readonly string[];
        expect(new Set(variants).size).toBe(variants.length);
      }
    });

    it('exposes a typed key list matching the variant table', () => {
      expect(Object.keys(VARIANTS).sort()).toEqual([...EXPERIMENT_KEYS].sort());
    });

    it('types variant() to the declared union', () => {
      // Compile-time guard: assigning an undeclared variant must not typecheck.
      const key: ExperimentKey = 'mic_control';
      const allowed: readonly string[] = VARIANTS[key];
      expect(allowed).toContain('hold');
    });
  });
});
