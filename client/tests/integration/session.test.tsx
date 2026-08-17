import { describe, expect, it, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTranslationSession } from '../../src/hooks/useTranslationSession';
import { ApiClient } from '../../src/services/api';
import type { AudioPlayer } from '../../src/services/audioPlayer';
import { FakePlayer, fakeRecorderFactory } from '../fakeRecorder';
import { apiError, createMockServer, quotaSnapshot } from '../mockServer';
import type { MockServer } from '../mockServer';

/**
 * Client-side integration: the hook, the API client, the recorder contract, and
 * playback wired together against a scripted backend. This is the layer where
 * "user speaks → card appears → audio plays" is actually proven.
 */
describe('translation session integration', () => {
  let server: MockServer;
  let recorders: ReturnType<typeof fakeRecorderFactory>;
  let player: FakePlayer;

  beforeEach(() => {
    server = createMockServer();
    recorders = fakeRecorderFactory();
    player = new FakePlayer();
  });

  function setup(overrides: { autoplay?: boolean } = {}) {
    const api = new ApiClient({
      deviceId: 'device-integration',
      fetchImpl: server.fetch as unknown as typeof fetch,
      retryDelayMs: 0,
    });

    return renderHook(() =>
      useTranslationSession({
        api,
        sourceLang: 'ar-SA',
        targetLang: 'en-US',
        autoplay: overrides.autoplay ?? true,
        recorderFactory: recorders.factory,
        playerFactory: () => player as unknown as AudioPlayer,
      }),
    );
  }

  describe('the happy path', () => {
    it('starts a session and begins listening', async () => {
      const { result } = setup();

      await act(async () => {
        await result.current.start();
      });

      expect(result.current.micState).toBe('listening');
      expect(server.requestsTo('/session/start')).toHaveLength(1);
      expect(recorders.current().startCalls).toBe(1);
    });

    it('unlocks audio inside the start gesture, so iOS will autoplay later', async () => {
      const { result } = setup();

      await act(async () => {
        await result.current.start();
      });

      expect(player.unlockCalls).toBe(1);
    });

    it('turns a spoken utterance into a transcript card', async () => {
      const { result } = setup();
      await act(async () => {
        await result.current.start();
      });

      await act(async () => {
        recorders.current().speak(2);
      });

      await waitFor(() => expect(result.current.entries).toHaveLength(1));
      expect(result.current.entries[0]!.sourceText).toBe('مرحبا، كيف حالك؟');
      expect(result.current.entries[0]!.translatedText).toBe('Hello, how are you?');
    });

    it('uploads the audio with the session and language fields', async () => {
      const { result } = setup();
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        recorders.current().speak(3.5);
      });

      await waitFor(() => expect(server.requestsTo('/translate/segment')).toHaveLength(1));

      const body = server.requestsTo('/translate/segment')[0]!.body as Record<string, string>;
      expect(body.sessionId).toBe('session-test');
      expect(body.sourceLang).toBe('ar-SA');
      expect(body.targetLang).toBe('en-US');
      expect(body.durationSeconds).toBe('3.5');
    });

    it('sends the previous transcript so the server can de-duplicate', async () => {
      const { result } = setup();
      await act(async () => {
        await result.current.start();
      });

      await act(async () => {
        recorders.current().speak();
      });
      await waitFor(() => expect(result.current.entries).toHaveLength(1));

      await act(async () => {
        recorders.current().speak();
      });
      await waitFor(() => expect(server.requestsTo('/translate/segment')).toHaveLength(2));

      const second = server.requestsTo('/translate/segment')[1]!.body as Record<string, string>;
      expect(second.previousText).toBe('مرحبا، كيف حالك؟');
    });

    it('updates the quota snapshot from the server, not from local counting', async () => {
      const { result } = setup();
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        recorders.current().speak();
      });

      await waitFor(() => expect(result.current.quota?.sessionSecondsUsed).toBe(2));
    });

    it('stops the session and tells the server', async () => {
      const { result } = setup();
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        await result.current.stop();
      });

      expect(result.current.micState).toBe('idle');
      expect(recorders.current().stopCalls).toBe(1);
      // A user-initiated stop flushes whatever was mid-sentence.
      expect(recorders.current().lastStopFlush).toBe(true);
      expect(server.requestsTo('/stop')).toHaveLength(1);
    });

    it('toggles between listening and idle', async () => {
      const { result } = setup();

      await act(async () => {
        await result.current.toggle();
      });
      expect(result.current.micState).toBe('listening');

      await act(async () => {
        await result.current.toggle();
      });
      expect(result.current.micState).toBe('idle');
    });
  });

  describe('playback', () => {
    it('plays the translated audio automatically in the autoplay variant', async () => {
      const { result } = setup({ autoplay: true });
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        recorders.current().speak();
      });

      await waitFor(() => expect(player.played).toHaveLength(1));
      expect(player.played[0]!.base64).toBe('QUJD');
    });

    it('stays silent in the manual variant until asked', async () => {
      const { result } = setup({ autoplay: false });
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        recorders.current().speak();
      });
      await waitFor(() => expect(result.current.entries).toHaveLength(1));

      expect(player.played).toHaveLength(0);

      await act(async () => {
        await result.current.replay(result.current.entries[0]!);
      });

      expect(player.played).toHaveLength(1);
    });

    it('replays from the cached audio without calling the server again', async () => {
      const { result } = setup({ autoplay: false });
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        recorders.current().speak();
      });
      await waitFor(() => expect(result.current.entries).toHaveLength(1));

      await act(async () => {
        await result.current.replay(result.current.entries[0]!);
      });

      expect(server.requestsTo('/translate/speak')).toHaveLength(0);
    });

    it('asks the server to synthesise when a segment has no audio', async () => {
      server.segmentResponses.push({
        status: 200,
        body: {
          ok: true,
          status: 'recognized',
          segment: {
            id: 'no-audio',
            sourceText: 'مرحبا',
            translatedText: 'Hello',
            sourceLang: 'ar-SA',
            targetLang: 'en-US',
            confidence: 0.9,
            audioBase64: null,
            ttsCached: false,
            audioSeconds: 1,
            createdAt: Date.now(),
          },
          quota: quotaSnapshot(),
        },
      });

      const { result } = setup({ autoplay: false });
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        recorders.current().speak();
      });
      await waitFor(() => expect(result.current.entries).toHaveLength(1));

      await act(async () => {
        await result.current.replay(result.current.entries[0]!);
      });

      expect(server.requestsTo('/translate/speak')).toHaveLength(1);
    });
  });

  describe('non-error outcomes', () => {
    it('shows a neutral notice for silence and adds no card', async () => {
      server.segmentResponses.push({
        status: 200,
        body: { ok: true, status: 'no_speech', message: 'No speech recognized', quota: quotaSnapshot() },
      });

      const { result } = setup();
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        recorders.current().speak();
      });

      await waitFor(() => expect(result.current.notice?.text).toBe('No speech recognized'));
      expect(result.current.notice?.tone).toBe('neutral');
      expect(result.current.entries).toHaveLength(0);
    });

    it('shows a neutral notice when a segment was skipped as a duplicate', async () => {
      server.segmentResponses.push({
        status: 200,
        body: {
          ok: true,
          status: 'skipped',
          reason: 'duplicate_of_previous',
          sourceText: 'مرحبا',
          message: 'Same as the last phrase — nothing new to translate.',
          quota: quotaSnapshot(),
        },
      });

      const { result } = setup();
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        recorders.current().speak();
      });

      await waitFor(() => expect(result.current.notice?.tone).toBe('neutral'));
      expect(result.current.entries).toHaveLength(0);
    });

    it('stops listening on an idle timeout so silence does not burn the budget', async () => {
      const { result } = setup();
      await act(async () => {
        await result.current.start();
      });

      await act(async () => {
        recorders.current().emitIdleTimeout();
      });

      await waitFor(() => expect(result.current.micState).toBe('idle'));
      expect(result.current.notice?.text).toMatch(/save your time/i);
    });
  });

  describe('failure handling', () => {
    it('surfaces a mic permission refusal in plain language', async () => {
      const denied = new Error(
        'Microphone access was blocked. Allow it in your browser settings to translate.',
      );
      recorders = fakeRecorderFactory({ startError: denied });

      const { result } = setup();
      await act(async () => {
        await result.current.start();
      });

      expect(result.current.micState).toBe('idle');
      expect(result.current.notice?.text).toMatch(/microphone access was blocked/i);
      expect(result.current.notice?.tone).toBe('error');
      // A permission problem is not a provider outage — the mic stays usable
      // so the user can retry after granting access.
      expect(result.current.halted).toBe(false);
    });

    it('halts and blocks the mic on an auth failure', async () => {
      server.segmentResponses.push({
        status: 502,
        body: apiError('auth_failure', 'Speech service authentication failed.', { haltProvider: true }),
      });

      const { result } = setup();
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        recorders.current().speak();
      });

      await waitFor(() => expect(result.current.halted).toBe(true));
      expect(result.current.micState).toBe('blocked');
      expect(result.current.notice?.text).toBe('Speech service authentication failed.');
      expect(result.current.notice?.tone).toBe('error');
    });

    it('refuses to start again while halted', async () => {
      server.segmentResponses.push({
        status: 429,
        body: apiError('quota_exceeded', 'Service limit was reached. Please try again later.', {
          haltProvider: true,
        }),
      });

      const { result } = setup();
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        recorders.current().speak();
      });
      await waitFor(() => expect(result.current.halted).toBe(true));

      const before = server.requestsTo('/session/start').length;
      await act(async () => {
        await result.current.start();
      });

      expect(server.requestsTo('/session/start')).toHaveLength(before);
    });

    it('does not halt on a retryable transient failure', async () => {
      server.segmentResponses.push({
        status: 503,
        body: apiError('transient', 'The service is busy. Please try again in a moment.', { retryable: true }),
      });

      const { result } = setup();
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        recorders.current().speak();
      });

      await waitFor(() => expect(result.current.notice?.tone).toBe('error'));
      expect(result.current.halted).toBe(false);
    });

    it('clears the halt and the transcript on reset', async () => {
      server.segmentResponses.push({
        status: 502,
        body: apiError('auth_failure', 'Speech service authentication failed.', { haltProvider: true }),
      });

      const { result } = setup();
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        recorders.current().speak();
      });
      await waitFor(() => expect(result.current.halted).toBe(true));

      act(() => {
        result.current.reset();
      });

      expect(result.current.halted).toBe(false);
      expect(result.current.micState).toBe('idle');
      expect(result.current.entries).toHaveLength(0);
    });

    it('reports a refused session start without leaving the mic on', async () => {
      server.setHandler('/session/start', () => ({
        status: 429,
        body: apiError('internal_quota_exceeded', "You've used all of today's translation time."),
      }));

      const { result } = setup();
      await act(async () => {
        await result.current.start();
      });

      expect(result.current.micState).toBe('idle');
      expect(result.current.notice?.text).toMatch(/today/i);
      expect(recorders.all).toHaveLength(0); // the mic was never opened
    });
  });

  describe('session limits', () => {
    it('stops listening when the server reports the session ended', async () => {
      server.segmentResponses.push({
        status: 200,
        body: {
          ok: true,
          status: 'recognized',
          segment: {
            id: 'final',
            sourceText: 'مرحبا',
            translatedText: 'Hello',
            sourceLang: 'ar-SA',
            targetLang: 'en-US',
            confidence: 0.9,
            audioBase64: 'QUJD',
            ttsCached: false,
            audioSeconds: 20,
            createdAt: Date.now(),
          },
          quota: quotaSnapshot({
            sessionSecondsUsed: 120,
            sessionEnded: true,
            endedReason: 'session_limit',
          }),
        },
      });

      const { result } = setup({ autoplay: false });
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        recorders.current().speak();
      });

      // The final sentence still lands, and then the mic stops.
      await waitFor(() => expect(result.current.entries).toHaveLength(1));
      await waitFor(() => expect(result.current.micState).toBe('idle'));
      expect(recorders.current().stopCalls).toBe(1);
    });
  });
});
