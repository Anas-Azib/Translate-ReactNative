import { describe, expect, it, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTranslationSession } from '../../src/hooks/useTranslationSession';
import type { SpeechSynthesizer } from '../../src/services/speech';
import type { WsClient } from '../../src/services/wsClient';
import { FakeSynthesizer, FakeWsClient, fakeRecorderFactory } from '../fakeRecorder';

/**
 * The production app renders inside `<StrictMode>`, which double-invokes
 * effects (mount → unmount → mount) and state updaters. The rest of the suite
 * renders without it, so this file exists to catch anything that only breaks
 * under the conditions the real app actually runs in.
 */
describe('under StrictMode', () => {
  let recorders: ReturnType<typeof fakeRecorderFactory>;
  let synth: FakeSynthesizer;
  let clients: FakeWsClient[] = [];

  beforeEach(() => {
    recorders = fakeRecorderFactory();
    synth = new FakeSynthesizer();
    clients = [];
  });

  function setup() {
    return renderHook(
      () =>
        useTranslationSession({
          deviceId: 'device-strict',
          sourceLang: 'ar-SA',
          targetLang: 'en-US',
          autoplay: false,
          recorderFactory: recorders.factory,
          synthesizerFactory: () => synth as unknown as SpeechSynthesizer,
          wsClientFactory: (options) => {
            const client = new FakeWsClient(options as never);
            clients.push(client);
            return client as unknown as WsClient;
          },
        }),
      { wrapper: StrictMode },
    );
  }

  /** The live client is whichever one the hook is currently using. */
  const live = () => clients[clients.length - 1]!;

  async function start(result: { current: ReturnType<typeof useTranslationSession> }) {
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      live().emit({ type: 'session.state', state: 'active', sessionId: 's-1', quota: null, reason: 'user' });
    });
  }

  it('starts a session', async () => {
    const { result } = setup();
    await start(result);
    expect(result.current.sessionState).toBe('active');
  });

  it('shows the transcript text', async () => {
    const { result } = setup();
    await start(result);

    act(() => {
      live().emit({
        type: 'transcript',
        segmentId: 'seg-1',
        text: 'أين أقرب مستشفى؟',
        lang: 'ar-SA',
        isFinal: true,
        confidence: 0.9,
      });
    });

    expect(result.current.pending?.sourceText).toBe('أين أقرب مستشفى؟');
  });

  /**
   * The reported symptom: cards appear with their language badges but no text.
   * That means an entry was created with empty `sourceText`/`translatedText`.
   */
  it('creates an entry carrying BOTH texts', async () => {
    const { result } = setup();
    await start(result);

    act(() => {
      live().emit({
        type: 'transcript',
        segmentId: 'seg-1',
        text: 'أين أقرب مستشفى؟',
        lang: 'ar-SA',
        isFinal: true,
        confidence: 0.9,
      });
    });
    act(() => {
      live().emit({
        type: 'translation',
        segmentId: 'seg-1',
        text: 'Where is the nearest hospital?',
        lang: 'en-US',
        isFinal: true,
      });
    });

    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.entries[0]!.sourceText).toBe('أين أقرب مستشفى؟');
    expect(result.current.entries[0]!.translatedText).toBe('Where is the nearest hospital?');
  });

  it('keeps working across several segments in a row', async () => {
    const { result } = setup();
    await start(result);

    for (let i = 1; i <= 3; i += 1) {
      act(() => {
        live().emit({
          type: 'transcript',
          segmentId: `seg-${i}`,
          text: `source ${i}`,
          lang: 'ar-SA',
          isFinal: true,
          confidence: 0.9,
        });
      });
      act(() => {
        live().emit({
          type: 'translation',
          segmentId: `seg-${i}`,
          text: `translated ${i}`,
          lang: 'en-US',
          isFinal: true,
        });
      });
    }

    await waitFor(() => expect(result.current.entries).toHaveLength(3));
    // Every entry must carry its text — this is what the screenshot shows failing.
    for (let i = 0; i < 3; i += 1) {
      expect(result.current.entries[i]!.sourceText).toBe(`source ${i + 1}`);
      expect(result.current.entries[i]!.translatedText).toBe(`translated ${i + 1}`);
    }
  });

  it('routes audio to the client the hook is actually using', async () => {
    const { result } = setup();
    await start(result);

    act(() => recorders.current().speak(2));

    // If the hook kept a reference to a client discarded by StrictMode's
    // double-mount, the segment would be sent into the void.
    expect(live().segments).toHaveLength(1);
  });
});
