import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClient, ApiError } from '../services/api';
import { AudioRecorder } from '../services/recorder';
import type { RecorderOptions } from '../services/recorder';
import { AudioPlayer, haptics } from '../services/audioPlayer';
import type { ConversationEntry, MicState, QuotaSnapshot } from '../types';

export interface UseTranslationSessionOptions {
  api: ApiClient;
  sourceLang: string;
  targetLang: string;
  /** From the `autoplay_tts` experiment. */
  autoplay: boolean;
  onTranslation?: (entry: ConversationEntry) => void;
  onSessionEnded?: (reason: string) => void;
  onError?: (error: ApiError | Error) => void;
  recorderFactory?: (options: RecorderOptions) => AudioRecorder;
  playerFactory?: () => AudioPlayer;
}

export interface TranslationSessionState {
  micState: MicState;
  level: number;
  quota: QuotaSnapshot | null;
  entries: ConversationEntry[];
  notice: { text: string; tone: 'neutral' | 'warning' | 'error' } | null;
  busy: boolean;
  /** True once a provider told us to stop; the mic stays disabled. */
  halted: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  toggle: () => Promise<void>;
  replay: (entry: ConversationEntry) => Promise<void>;
  clearNotice: () => void;
  reset: () => void;
}

/**
 * Owns the whole live-translation loop: session lifecycle, microphone,
 * segment upload, and playback.
 *
 * Audio level is intentionally *not* React state — see `micOrb.ts`. Everything
 * else here is, because it changes at human speed.
 */
export function useTranslationSession(options: UseTranslationSessionOptions): TranslationSessionState {
  const { api, sourceLang, targetLang, autoplay } = options;

  const [micState, setMicState] = useState<MicState>('idle');
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [notice, setNotice] = useState<TranslationSessionState['notice']>(null);
  const [busy, setBusy] = useState(false);
  const [halted, setHalted] = useState(false);
  const [level, setLevel] = useState(0);

  const recorderRef = useRef<AudioRecorder | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const previousTextRef = useRef<string | undefined>(undefined);
  const inFlightRef = useRef(0);
  // Latest values for callbacks that outlive a render.
  const langsRef = useRef({ sourceLang, targetLang, autoplay });
  langsRef.current = { sourceLang, targetLang, autoplay };
  const handlersRef = useRef(options);
  handlersRef.current = options;

  const getPlayer = useCallback((): AudioPlayer => {
    if (!playerRef.current) {
      playerRef.current = handlersRef.current.playerFactory?.() ?? new AudioPlayer();
    }
    return playerRef.current;
  }, []);

  const fail = useCallback((error: ApiError | Error) => {
    const isApi = error instanceof ApiError;
    setNotice({ text: error.message, tone: isApi && error.kind === 'no_match' ? 'warning' : 'error' });
    // An auth failure or a provider quota stop is terminal — the plan document
    // says stop requesting, so the mic is locked rather than left inviting a
    // retry that cannot succeed.
    if (isApi && (error.haltProvider || error.kind === 'auth_failure' || error.kind === 'quota_exceeded')) {
      setHalted(true);
      setMicState('blocked');
    }
    haptics.warning();
    handlersRef.current.onError?.(error);
  }, []);

  const playAudio = useCallback(
    async (base64: string, mimeType = 'audio/mpeg') => {
      try {
        setMicState('speaking');
        const player = getPlayer();
        await player.play(base64, mimeType);
        await new Promise<void>((resolve) => {
          const off = player.onEnded(() => {
            off();
            resolve();
          });
          // Very short clips can finish before this listener is attached, and
          // an 'ended' event we missed would leave the UI stuck on "speaking"
          // forever. If playback is already over, there is nothing to wait for.
          if (!player.playing) {
            off();
            resolve();
          }
        });
      } catch {
        // Autoplay refused — the replay button is still there.
      } finally {
        setMicState((current) => (current === 'speaking' ? 'listening' : current));
      }
    },
    [getPlayer],
  );

  const sendSegment = useCallback(
    async (blob: Blob, durationSeconds: number) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;

      inFlightRef.current += 1;
      setBusy(true);
      setMicState((current) => (current === 'listening' ? 'processing' : current));

      try {
        const outcome = await api.translateSegment({
          sessionId,
          audio: blob,
          durationSeconds,
          sourceLang: langsRef.current.sourceLang,
          targetLang: langsRef.current.targetLang,
          ...(previousTextRef.current ? { previousText: previousTextRef.current } : {}),
          speak: true,
        });

        setQuota(outcome.quota);

        if (outcome.status === 'recognized') {
          previousTextRef.current = outcome.segment.sourceText;
          const entry: ConversationEntry = { ...outcome.segment, kind: 'translation' };
          setEntries((prev) => [...prev, entry]);
          setNotice(null);
          haptics.success();
          handlersRef.current.onTranslation?.(entry);

          if (langsRef.current.autoplay && entry.audioBase64) {
            await playAudio(entry.audioBase64, 'audio/mpeg');
          }
        } else {
          // no_speech / skipped are normal outcomes, not errors — they get a
          // gentle inline notice instead of an error treatment.
          setNotice({ text: outcome.message, tone: 'neutral' });
        }

        if (outcome.quota.sessionEnded) {
          await stopInternal('limit');
          handlersRef.current.onSessionEnded?.(outcome.quota.endedReason ?? 'session_limit');
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        if (err instanceof ApiError && !err.retryable && err.kind !== 'no_match') {
          await stopInternal('error');
        }
      } finally {
        inFlightRef.current -= 1;
        if (inFlightRef.current === 0) {
          setBusy(false);
          setMicState((current) =>
            current === 'processing' ? (recorderRef.current?.status === 'recording' ? 'listening' : 'idle') : current,
          );
        }
      }
    },
    [api, fail, playAudio],
  );

  const stopInternal = useCallback(
    async (reason: 'user' | 'limit' | 'error' | 'idle') => {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) await recorder.stop({ flush: reason === 'user' });

      setLevel(0);
      setMicState((current) => (current === 'blocked' ? current : 'idle'));

      const sessionId = sessionIdRef.current;
      if (sessionId && reason === 'user') {
        try {
          const result = await api.stopSession(sessionId);
          setQuota(result.quota);
        } catch {
          // The server reaps idle sessions anyway.
        }
      }
      if (reason !== 'user') sessionIdRef.current = sessionId;
      if (reason === 'user' || reason === 'limit') sessionIdRef.current = null;
    },
    [api],
  );

  const start = useCallback(async () => {
    if (halted) return;
    setNotice(null);
    setBusy(true);

    try {
      // Unlock audio inside the tap that started the session, or iOS will
      // refuse to autoplay the translation later.
      await getPlayer().unlock();

      const session = await api.startSession();
      sessionIdRef.current = session.sessionId;
      setQuota(session.quota);
      previousTextRef.current = undefined;

      const factory = handlersRef.current.recorderFactory ?? ((o) => new AudioRecorder(o));
      const recorder = factory({
        onLevel: setLevel,
        onSpeechStart: () => setMicState((c) => (c === 'idle' ? 'listening' : c)),
        onSegment: ({ blob, durationSeconds }) => {
          void sendSegment(blob, durationSeconds);
        },
        onIdleTimeout: () => {
          setNotice({ text: 'Paused — I stopped listening to save your time.', tone: 'neutral' });
          void stopInternal('idle');
        },
        onError: (error) => fail(error),
      });

      await recorder.start();
      recorderRef.current = recorder;
      setMicState('listening');
      haptics.tap();
    } catch (err) {
      sessionIdRef.current = null;
      fail(err instanceof Error ? err : new Error(String(err)));
      setMicState((c) => (c === 'blocked' ? c : 'idle'));
    } finally {
      setBusy(false);
    }
  }, [api, fail, getPlayer, halted, sendSegment, stopInternal]);

  const stop = useCallback(() => stopInternal('user'), [stopInternal]);

  const toggle = useCallback(async () => {
    if (recorderRef.current?.status === 'recording') await stop();
    else await start();
  }, [start, stop]);

  const replay = useCallback(
    async (entry: ConversationEntry) => {
      if (entry.audioBase64) {
        await playAudio(entry.audioBase64, 'audio/mpeg');
        return;
      }
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      try {
        const result = await api.speak({
          sessionId,
          text: entry.translatedText,
          targetLang: entry.targetLang,
        });
        await playAudio(result.audioBase64, result.mimeType);
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    },
    [api, fail, playAudio],
  );

  const reset = useCallback(() => {
    setEntries([]);
    setNotice(null);
    setHalted(false);
    setMicState('idle');
    previousTextRef.current = undefined;
  }, []);

  useEffect(() => {
    return () => {
      void recorderRef.current?.stop({ flush: false });
      playerRef.current?.dispose();
    };
  }, []);

  return {
    micState,
    level,
    quota,
    entries,
    notice,
    busy,
    halted,
    start,
    stop,
    toggle,
    replay,
    clearNotice: () => setNotice(null),
    reset,
  };
}
