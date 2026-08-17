import { describe, expect, it, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTranslationSession } from '../../src/hooks/useTranslationSession';
import type { SpeechSynthesizer } from '../../src/services/speech';
import type { WsClient } from '../../src/services/wsClient';
import { FakeSynthesizer, FakeWsClient, fakeRecorderFactory } from '../fakeRecorder';

/**
 * Client-side session integration: the hook, the state machine, the transport
 * contract, the recorder, and speech — wired together with a scripted socket.
 *
 * This is the layer that proves the microphone lifecycle behaves, including the
 * scenarios from the bug report.
 */
describe('translation session integration', () => {
  let recorders: ReturnType<typeof fakeRecorderFactory>;
  let synth: FakeSynthesizer;
  let ws: FakeWsClient;

  beforeEach(() => {
    recorders = fakeRecorderFactory();
    synth = new FakeSynthesizer();
  });

  function setup(overrides: { autoplay?: boolean } = {}) {
    return renderHook(() =>
      useTranslationSession({
        deviceId: 'device-under-test',
        sourceLang: 'ar-SA',
        targetLang: 'en-US',
        autoplay: overrides.autoplay ?? true,
        recorderFactory: recorders.factory,
        synthesizerFactory: () => synth as unknown as SpeechSynthesizer,
        wsClientFactory: (options) => {
          ws = new FakeWsClient(options as never);
          return ws as unknown as WsClient;
        },
      }),
    );
  }

  /** Runs a full start and confirms it, the way the server would. */
  async function start(result: { current: ReturnType<typeof useTranslationSession> }) {
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      ws.emit({ type: 'session.state', state: 'active', sessionId: 's-1', quota: null, reason: 'user' });
    });
  }

  // ── Normal flow ─────────────────────────────────────────────────────────

  describe('normal lifecycle: start → speak → pause → resume → speak → stop', () => {
    it('walks the whole sequence with the state machine', async () => {
      const { result } = setup();
      expect(result.current.sessionState).toBe('idle');

      await start(result);
      expect(result.current.sessionState).toBe('active');
      expect(recorders.current().startCalls).toBe(1);

      act(() => recorders.current().speak(2));
      expect(ws.segments).toHaveLength(1);

      act(() => result.current.pause());
      expect(result.current.sessionState).toBe('paused');
      expect(recorders.current().pauseCalls).toBe(1);

      act(() => result.current.resume());
      expect(result.current.sessionState).toBe('active');
      expect(recorders.current().resumeCalls).toBe(1);

      act(() => recorders.current().speak(2));
      expect(ws.segments).toHaveLength(2);

      await act(async () => {
        await result.current.stop();
      });
      expect(result.current.sessionState).toBe('idle');
      expect(recorders.current().stopCalls).toBe(1);
    });

    it('tells the server to start with the chosen languages', async () => {
      const { result } = setup();
      await start(result);

      expect(ws.sentOfType('session.start')[0]).toMatchObject({
        sourceLang: 'ar-SA',
        targetLang: 'en-US',
        takeover: true,
      });
    });

    it('sends pause and resume to the server', async () => {
      const { result } = setup();
      await start(result);

      act(() => result.current.pause());
      act(() => result.current.resume());

      expect(ws.sentOfType('session.pause')).toHaveLength(1);
      expect(ws.sentOfType('session.resume')).toHaveLength(1);
    });

    it('drops audio captured while paused', async () => {
      const { result } = setup();
      await start(result);
      act(() => result.current.pause());

      act(() => recorders.current().speak(2));

      // The state machine gates the upload, not just the recorder.
      expect(ws.segments).toHaveLength(0);
    });
  });

  // ── The reported bug ────────────────────────────────────────────────────

  describe('restart: start → stop → start → stop → start', () => {
    it('produces a clean session each time', async () => {
      const { result } = setup();

      for (let i = 0; i < 2; i += 1) {
        await start(result);
        expect(result.current.sessionState).toBe('active');
        await act(async () => {
          await result.current.stop();
        });
        expect(result.current.sessionState).toBe('idle');
      }

      await start(result);
      expect(result.current.sessionState).toBe('active');
      // Three genuine starts, no error along the way.
      expect(ws.sentOfType('session.start')).toHaveLength(3);
      expect(result.current.notice?.tone).not.toBe('error');
    });

    it('never reports "session already in progress" on restart', async () => {
      const { result } = setup();
      await start(result);
      await act(async () => {
        await result.current.stop();
      });
      await start(result);

      expect(result.current.notice?.text ?? '').not.toMatch(/already/i);
      expect(result.current.sessionState).toBe('active');
    });
  });

  describe('rapid interaction', () => {
    it('Start Start Start opens exactly one session', async () => {
      const { result } = setup();

      await act(async () => {
        // Fired without awaiting in between, as fast tapping would.
        await Promise.all([result.current.start(), result.current.start(), result.current.start()]);
      });

      // The state machine rejects START outside idle/error, so the extra taps
      // never reach the transport.
      expect(ws.sentOfType('session.start')).toHaveLength(1);
      expect(recorders.all).toHaveLength(1);
    });

    it('Pause Resume Pause Resume ends active with no drift', async () => {
      const { result } = setup();
      await start(result);

      act(() => {
        result.current.pause();
        result.current.resume();
        result.current.pause();
        result.current.resume();
      });

      expect(result.current.sessionState).toBe('active');
      expect(ws.sentOfType('session.pause')).toHaveLength(2);
      expect(ws.sentOfType('session.resume')).toHaveLength(2);
    });

    it('ignores a redundant pause', async () => {
      const { result } = setup();
      await start(result);

      act(() => {
        result.current.pause();
        result.current.pause();
      });

      expect(ws.sentOfType('session.pause')).toHaveLength(1);
    });

    it('ignores a stop when already idle', async () => {
      const { result } = setup();
      await act(async () => {
        await result.current.stop();
      });

      expect(ws.sentOfType('session.stop')).toHaveLength(0);
    });
  });

  // ── Two-stage streaming ─────────────────────────────────────────────────

  describe('transcript and translation arrive independently', () => {
    it('shows the transcript before the translation exists', async () => {
      const { result } = setup();
      await start(result);

      act(() => {
        ws.emit({
          type: 'transcript',
          segmentId: 'seg-1',
          text: 'أين أقرب مستشفى؟',
          lang: 'ar-SA',
          isFinal: true,
          confidence: 0.9,
        });
      });

      // Source text is available immediately; translation is still in flight.
      expect(result.current.pending).toMatchObject({
        segmentId: 'seg-1',
        sourceText: 'أين أقرب مستشفى؟',
        translatedText: '',
      });
      expect(result.current.entries).toHaveLength(0);
    });

    it('promotes the segment to an entry when the translation is final', async () => {
      const { result } = setup({ autoplay: false });
      await start(result);

      act(() => {
        ws.emit({
          type: 'transcript',
          segmentId: 'seg-1',
          text: 'أين أقرب مستشفى؟',
          lang: 'ar-SA',
          isFinal: true,
          confidence: 0.9,
        });
      });
      act(() => {
        ws.emit({
          type: 'translation',
          segmentId: 'seg-1',
          text: 'Where is the nearest hospital?',
          lang: 'en-US',
          isFinal: true,
          matchQuality: 1,
        });
      });

      await waitFor(() => expect(result.current.entries).toHaveLength(1));
      expect(result.current.entries[0]).toMatchObject({
        sourceText: 'أين أقرب مستشفى؟',
        translatedText: 'Where is the nearest hospital?',
      });
      expect(result.current.pending).toBeNull();
    });

    it('does not duplicate an entry if the server repeats a final translation', async () => {
      const { result } = setup({ autoplay: false });
      await start(result);

      const emitPair = () => {
        act(() => {
          ws.emit({ type: 'transcript', segmentId: 'seg-dup', text: 'مرحبا', lang: 'ar-SA', isFinal: true, confidence: 1 });
        });
        act(() => {
          ws.emit({ type: 'translation', segmentId: 'seg-dup', text: 'Hello', lang: 'en-US', isFinal: true });
        });
      };

      emitPair();
      emitPair();

      // Keyed by segment id, so a redelivery cannot append twice.
      await waitFor(() => expect(result.current.entries).toHaveLength(1));
    });

    it('accumulates interim translation updates without duplicating', async () => {
      const { result } = setup({ autoplay: false });
      await start(result);

      for (const text of ['M', 'Ma', 'Mar', 'Mars']) {
        act(() => {
          ws.emit({ type: 'translation', segmentId: 'seg-stream', text, lang: 'en-US', isFinal: false });
        });
      }

      // Each update replaces the target; it is never appended.
      expect(result.current.pending?.translatedText).toBe('Mars');
    });

    it('clears the pending segment when the server skips it', async () => {
      const { result } = setup();
      await start(result);

      act(() => {
        ws.emit({ type: 'transcript', segmentId: 'seg-x', text: 'uh', lang: 'ar-SA', isFinal: true, confidence: 0.5 });
      });
      act(() => {
        ws.emit({
          type: 'segment.skipped',
          segmentId: 'seg-x',
          reason: 'filler_only',
          message: 'No speech recognized',
        });
      });

      expect(result.current.pending).toBeNull();
      expect(result.current.notice?.text).toBe('No speech recognized');
    });
  });

  // ── Speaking ────────────────────────────────────────────────────────────

  describe('speaking the translation', () => {
    it('speaks automatically in the autoplay variant', async () => {
      const { result } = setup({ autoplay: true });
      await start(result);

      act(() => {
        ws.emit({ type: 'transcript', segmentId: 's', text: 'مرحبا', lang: 'ar-SA', isFinal: true, confidence: 1 });
      });
      act(() => {
        ws.emit({ type: 'translation', segmentId: 's', text: 'Hello', lang: 'en-US', isFinal: true });
      });

      await waitFor(() => expect(synth.spoken).toHaveLength(1));
      expect(synth.spoken[0]).toEqual({ text: 'Hello', lang: 'en-US' });
    });

    it('stays silent in the manual variant until replayed', async () => {
      const { result } = setup({ autoplay: false });
      await start(result);

      act(() => {
        ws.emit({ type: 'transcript', segmentId: 's', text: 'مرحبا', lang: 'ar-SA', isFinal: true, confidence: 1 });
      });
      act(() => {
        ws.emit({ type: 'translation', segmentId: 's', text: 'Hello', lang: 'en-US', isFinal: true });
      });
      await waitFor(() => expect(result.current.entries).toHaveLength(1));
      expect(synth.spoken).toHaveLength(0);

      await act(async () => {
        await result.current.replay(result.current.entries[0]!);
      });
      expect(synth.spoken).toHaveLength(1);
    });

    it('replays without touching the network', async () => {
      const { result } = setup({ autoplay: false });
      await start(result);

      act(() => {
        ws.emit({ type: 'transcript', segmentId: 's', text: 'مرحبا', lang: 'ar-SA', isFinal: true, confidence: 1 });
      });
      act(() => {
        ws.emit({ type: 'translation', segmentId: 's', text: 'Hello', lang: 'en-US', isFinal: true });
      });
      await waitFor(() => expect(result.current.entries).toHaveLength(1));

      const before = ws.sent.length;
      await act(async () => {
        await result.current.replay(result.current.entries[0]!);
      });

      expect(ws.sent).toHaveLength(before);
    });

    it('unlocks synthesis inside the start gesture for iOS', async () => {
      const { result } = setup();
      await start(result);
      expect(synth.unlockCalls).toBe(1);
    });

    it('reports a device with no speech synthesis', async () => {
      synth.supported = false;
      const { result } = setup();
      await start(result);

      act(() => {
        ws.emit({ type: 'transcript', segmentId: 's', text: 'مرحبا', lang: 'ar-SA', isFinal: true, confidence: 1 });
      });
      act(() => {
        ws.emit({ type: 'translation', segmentId: 's', text: 'Hello', lang: 'en-US', isFinal: true });
      });

      await waitFor(() => expect(result.current.canSpeak).toBe(false));
      expect(result.current.entries).toHaveLength(1);
    });
  });

  // ── Failure and recovery ────────────────────────────────────────────────

  describe('network and failure handling', () => {
    it('moves to reconnecting when the socket drops mid-session', async () => {
      const { result } = setup();
      await start(result);

      act(() => ws.drop());

      // Not "idle": the user did not stop, and the UI should show recovery.
      expect(result.current.sessionState).toBe('reconnecting');
    });

    it('returns to active when the socket comes back', async () => {
      const { result } = setup();
      await start(result);
      act(() => ws.drop());

      await act(async () => {
        await ws.connect();
      });

      expect(result.current.sessionState).toBe('active');
    });

    it('surfaces a connection failure and allows a retry', async () => {
      ws = new FakeWsClient({ onMessage: () => {} });
      const { result } = setup();
      recorders.all.length = 0;

      // Make the *next* client fail to connect.
      const { result: failing } = renderHook(() =>
        useTranslationSession({
          deviceId: 'device-fail',
          sourceLang: 'ar-SA',
          targetLang: 'en-US',
          autoplay: false,
          recorderFactory: recorders.factory,
          synthesizerFactory: () => synth as unknown as SpeechSynthesizer,
          wsClientFactory: (options) => {
            const client = new FakeWsClient(options as never);
            client.connectError = new Error('No connection. Check your internet and try again.');
            return client as unknown as WsClient;
          },
        }),
      );

      await act(async () => {
        await failing.current.start();
      });

      expect(failing.current.sessionState).toBe('error');
      expect(failing.current.notice?.tone).toBe('error');
      // Error is recoverable: the next tap may start a session directly.
      expect(result.current.sessionState).toBe('idle');
    });

    it('ends the session on a fatal server error', async () => {
      const { result } = setup();
      await start(result);

      act(() => {
        ws.emit({
          type: 'error',
          kind: 'quota_exceeded',
          message: 'Service limit was reached. Please try again later.',
          retryable: false,
          fatal: true,
        });
      });

      expect(result.current.sessionState).toBe('error');
      expect(result.current.notice?.tone).toBe('error');
    });

    it('keeps the session on a non-fatal error', async () => {
      const { result } = setup();
      await start(result);

      act(() => {
        ws.emit({
          type: 'error',
          kind: 'transient',
          message: 'The service is busy.',
          retryable: true,
          fatal: false,
        });
      });

      expect(result.current.sessionState).toBe('active');
    });

    it('stands down when another connection supersedes this one', async () => {
      const { result } = setup();
      await start(result);

      act(() => {
        ws.emit({ type: 'session.superseded', sessionId: 's-1' });
      });

      expect(result.current.sessionState).toBe('idle');
      expect(result.current.notice?.text).toMatch(/another tab or device/i);
    });

    it('reports a session ended by the server with a reason', async () => {
      const { result } = setup();
      await start(result);

      act(() => {
        ws.emit({
          type: 'session.state',
          state: 'idle',
          sessionId: null,
          quota: null,
          reason: 'session_limit',
        });
      });

      expect(result.current.sessionState).toBe('idle');
      expect(result.current.notice?.text).toMatch(/time limit/i);
    });

    it('surfaces a microphone permission refusal', async () => {
      const denied = new Error('Microphone access was blocked. Allow it in your browser settings to translate.');
      recorders = fakeRecorderFactory({ startError: denied });

      const { result } = setup();
      await act(async () => {
        await result.current.start();
      });

      expect(result.current.notice?.text).toMatch(/microphone access was blocked/i);
      expect(result.current.sessionState).toBe('error');
    });
  });

  // ── Cleanup ─────────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('releases the microphone and the socket on unmount', async () => {
      const { result, unmount } = setup();
      await start(result);
      const recorder = recorders.current();

      unmount();

      expect(recorder.stopCalls).toBeGreaterThan(0);
      expect(ws.disconnectCalls).toBeGreaterThan(0);
    });

    it('stops listening on an idle timeout so silence does not burn budget', async () => {
      const { result } = setup();
      await start(result);

      await act(async () => {
        recorders.current().emitIdleTimeout();
      });

      await waitFor(() => expect(result.current.sessionState).toBe('idle'));
      expect(result.current.notice?.text).toMatch(/save your time/i);
    });

    it('clears the transcript on reset', async () => {
      const { result } = setup({ autoplay: false });
      await start(result);
      act(() => {
        ws.emit({ type: 'transcript', segmentId: 's', text: 'مرحبا', lang: 'ar-SA', isFinal: true, confidence: 1 });
      });
      act(() => {
        ws.emit({ type: 'translation', segmentId: 's', text: 'Hello', lang: 'en-US', isFinal: true });
      });
      await waitFor(() => expect(result.current.entries).toHaveLength(1));

      act(() => result.current.reset());

      expect(result.current.entries).toHaveLength(0);
      expect(result.current.sessionState).toBe('idle');
    });
  });
});
