import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConnectionState,
  QuotaSnapshot,
  ServerMessage,
  SessionEvent,
  SessionState,
} from '@translate/shared';
import { applyEvent, canStart, isBusy, isCapturing, micStateFor } from '@translate/shared';
import { AudioRecorder } from '../services/recorder';
import type { RecorderOptions } from '../services/recorder';
import { SpeechSynthesizer, haptics } from '../services/speech';
import { WsClient } from '../services/wsClient';
import type { ConversationEntry, MicState } from '../types';

export interface UseTranslationSessionOptions {
  deviceId: string;
  sourceLang: string;
  targetLang: string;
  /** From the `autoplay_tts` experiment. */
  autoplay: boolean;
  onTranslation?: (entry: ConversationEntry) => void;
  onSessionEnded?: (reason: string) => void;
  onError?: (error: Error) => void;
  recorderFactory?: (options: RecorderOptions) => AudioRecorder;
  synthesizerFactory?: () => SpeechSynthesizer;
  wsClientFactory?: (options: ConstructorParameters<typeof WsClient>[0]) => WsClient;
}

export interface TranslationSessionState {
  sessionState: SessionState;
  connectionState: ConnectionState;
  micState: MicState;
  level: number;
  quota: QuotaSnapshot | null;
  entries: ConversationEntry[];
  /** The segment currently being recognised/translated, if any. */
  pending: { segmentId: string; sourceText: string; translatedText: string } | null;
  notice: { text: string; tone: 'neutral' | 'warning' | 'error' } | null;
  canSpeak: boolean;
  busy: boolean;
  start: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<void>;
  toggle: () => Promise<void>;
  replay: (entry: ConversationEntry) => Promise<void>;
  clearNotice: () => void;
  reset: () => void;
}

/**
 * Owns the whole live-translation loop.
 *
 * The session is represented by a single `SessionState` driven through the
 * shared state machine — never by a set of independent booleans. That is what
 * makes contradictory states like "not recording, not paused, but the backend
 * thinks a session is live" unrepresentable, and it is enforced identically on
 * the server because both sides import the same reducer.
 */
export function useTranslationSession(options: UseTranslationSessionOptions): TranslationSessionState {
  const { deviceId, sourceLang, targetLang, autoplay } = options;

  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [pending, setPending] = useState<TranslationSessionState['pending']>(null);
  /**
   * Mirror of `pending` for the message handler.
   *
   * Finalising a segment fires side effects — haptics, speech, the experiment
   * callback — and those must never run inside a `setState` updater: React
   * double-invokes updaters in StrictMode, which would speak every translation
   * twice. The ref lets the handler read the current segment and finalise it
   * outside the updater.
   */
  const pendingRef = useRef<TranslationSessionState['pending']>(null);
  const [notice, setNotice] = useState<TranslationSessionState['notice']>(null);
  const [level, setLevel] = useState(0);
  const [canSpeak, setCanSpeak] = useState(true);

  const recorderRef = useRef<AudioRecorder | null>(null);
  const synthRef = useRef<SpeechSynthesizer | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const stateRef = useRef<SessionState>('idle');
  const mountedRef = useRef(true);

  const langsRef = useRef({ sourceLang, targetLang, autoplay });
  langsRef.current = { sourceLang, targetLang, autoplay };
  const handlersRef = useRef(options);
  handlersRef.current = options;

  /** Single funnel for state changes so client and server cannot diverge. */
  const dispatch = useCallback((event: SessionEvent): SessionState => {
    const next = applyEvent(stateRef.current, event);
    if (next !== stateRef.current) {
      stateRef.current = next;
      if (mountedRef.current) setSessionState(next);
    }
    return next;
  }, []);

  const getSynth = useCallback((): SpeechSynthesizer => {
    synthRef.current ??= handlersRef.current.synthesizerFactory?.() ?? new SpeechSynthesizer();
    return synthRef.current;
  }, []);

  const speak = useCallback(
    async (text: string, lang: string) => {
      const synth = getSynth();
      if (!synth.supported) {
        setCanSpeak(false);
        return;
      }
      try {
        await synth.speak(text, { lang });
      } catch {
        // No voice for this language — the text is still on screen.
      }
    },
    [getSynth],
  );

  // ── Server messages ─────────────────────────────────────────────────────

  const handleMessage = useCallback(
    (message: ServerMessage) => {
      if (!mountedRef.current) return;

      switch (message.type) {
        case 'session.state': {
          // The server is authoritative about whether a session exists.
          if (message.state === 'active') dispatch('STARTED');
          else if (message.state === 'idle') dispatch('STOPPED');
          if (message.quota) setQuota(message.quota);

          if (message.reason && message.reason !== 'user' && message.state === 'idle') {
            setNotice({ text: reasonMessage(message.reason), tone: 'warning' });
            handlersRef.current.onSessionEnded?.(message.reason);
            void teardownRecorder();
          }
          return;
        }

        case 'session.superseded': {
          // Another tab or device took the session. Stand down quietly rather
          // than fighting for it.
          dispatch('STOPPED');
          setNotice({ text: 'Translation continued on another tab or device.', tone: 'neutral' });
          void teardownRecorder();
          return;
        }

        case 'transcript': {
          // Stage one. Shown immediately, while the translation is still in
          // flight — the two texts animate independently from here.
          const current = pendingRef.current;
          const next =
            current?.segmentId === message.segmentId
              ? { ...current, sourceText: message.text }
              : { segmentId: message.segmentId, sourceText: message.text, translatedText: '' };
          pendingRef.current = next;
          setPending(next);
          return;
        }

        case 'translation': {
          const current = pendingRef.current;
          const merged =
            current?.segmentId === message.segmentId
              ? { ...current, translatedText: message.text }
              : { segmentId: message.segmentId, sourceText: '', translatedText: message.text };

          if (!message.isFinal) {
            pendingRef.current = merged;
            setPending(merged);
            return;
          }

          // Final: promote the pending segment into the transcript list. Done
          // outside any updater so the side effects below run exactly once.
          const entry: ConversationEntry = {
            id: message.segmentId,
            kind: 'translation',
            sourceText: merged.sourceText,
            translatedText: message.text,
            sourceLang: langsRef.current.sourceLang,
            targetLang: message.lang,
            confidence: 1,
            ...(message.matchQuality !== undefined ? { matchQuality: message.matchQuality } : {}),
            audioSeconds: 0,
            createdAt: Date.now(),
          };

          pendingRef.current = null;
          setPending(null);
          // Keyed by segment id, so a duplicate delivery cannot append twice.
          setEntries((prev) => (prev.some((e) => e.id === entry.id) ? prev : [...prev, entry]));
          setNotice(null);
          haptics.success();
          handlersRef.current.onTranslation?.(entry);
          if (langsRef.current.autoplay) void speak(message.text, message.lang);
          return;
        }

        case 'segment.skipped': {
          pendingRef.current = null;
          setPending(null);
          setNotice({ text: message.message, tone: 'neutral' });
          return;
        }

        case 'quota':
          setQuota(message.quota);
          return;

        case 'error': {
          setNotice({ text: message.message, tone: 'error' });
          haptics.warning();
          handlersRef.current.onError?.(new Error(message.message));
          if (message.fatal) {
            dispatch('FAIL');
            void teardownRecorder();
          }
          return;
        }

        default:
          return;
      }
    },
    [dispatch, speak],
  );

  const getClient = useCallback((): WsClient => {
    if (!wsRef.current) {
      const factory = handlersRef.current.wsClientFactory ?? ((o) => new WsClient(o));
      wsRef.current = factory({
        deviceId,
        onMessage: handleMessage,
        onStateChange: (state) => {
          if (!mountedRef.current) return;
          setConnectionState(state);
          // A drop mid-session moves to `reconnecting`, not `idle`: the UI
          // should show recovery rather than pretending the user stopped.
          if (state === 'disconnected' && stateRef.current === 'active') dispatch('CONNECTION_LOST');
          if (state === 'connected' && stateRef.current === 'reconnecting') dispatch('RECONNECTED');
        },
      });
    }
    return wsRef.current;
  }, [deviceId, dispatch, handleMessage]);

  // ── Recorder ────────────────────────────────────────────────────────────

  const teardownRecorder = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) await recorder.stop({ flush: false });
    if (mountedRef.current) setLevel(0);
  }, []);

  // ── Actions ─────────────────────────────────────────────────────────────

  const stopInternal = useCallback(async () => {
    if (stateRef.current === 'idle' || stateRef.current === 'stopping') return;
    dispatch('STOP');

    await teardownRecorder();
    // Tell the server explicitly. Even if this never arrives, closing the
    // socket releases the session — the message is the fast path, not the
    // guarantee.
    wsRef.current?.send({ type: 'session.stop' });
    dispatch('STOPPED');
    pendingRef.current = null;
    setPending(null);
  }, [dispatch, teardownRecorder]);

  const start = useCallback(async () => {
    // The guard that makes rapid tapping safe: START is only legal from `idle`
    // or `error`, so a second tap while starting or active does nothing.
    if (!canStart(stateRef.current)) return;
    dispatch('START');
    setNotice(null);

    try {
      // Unlock synthesis inside the tap, or iOS will refuse to speak later.
      const synth = getSynth();
      await synth.unlock();
      setCanSpeak(synth.supported);

      const client = getClient();
      await client.connect();

      client.send({
        type: 'session.start',
        sourceLang: langsRef.current.sourceLang,
        targetLang: langsRef.current.targetLang,
        // Deliberate user action: take the slot from any stale session this
        // device left behind. This is what stops "session already in progress".
        takeover: true,
      });

      const factory = handlersRef.current.recorderFactory ?? ((o: RecorderOptions) => new AudioRecorder(o));
      const recorder = factory({
        onLevel: setLevel,
        onSegment: ({ blob, durationSeconds }) => {
          if (!isCapturing(stateRef.current)) return;
          void client.sendSegment({ segmentId: crypto.randomUUID(), durationSeconds }, blob);
        },
        onIdleTimeout: () => {
          setNotice({ text: 'Paused — I stopped listening to save your time.', tone: 'neutral' });
          void stopInternal();
        },
        onError: (error) => {
          setNotice({ text: error.message, tone: 'error' });
          dispatch('FAIL');
          handlersRef.current.onError?.(error);
        },
      });

      await recorder.start();
      recorderRef.current = recorder;
      haptics.tap();
    } catch (err) {
      dispatch('FAIL');
      await teardownRecorder();
      const error = err instanceof Error ? err : new Error(String(err));
      setNotice({ text: error.message, tone: 'error' });
      handlersRef.current.onError?.(error);
    }
  }, [dispatch, getClient, getSynth, stopInternal, teardownRecorder]);

  const pause = useCallback(() => {
    if (applyEvent(stateRef.current, 'PAUSE') === stateRef.current) return;
    dispatch('PAUSE');
    recorderRef.current?.pause();
    setLevel(0);
    wsRef.current?.send({ type: 'session.pause' });
  }, [dispatch]);

  const resume = useCallback(() => {
    if (applyEvent(stateRef.current, 'RESUME') === stateRef.current) return;
    dispatch('RESUME');
    recorderRef.current?.resume();
    wsRef.current?.send({ type: 'session.resume' });
  }, [dispatch]);

  const toggle = useCallback(async () => {
    if (isCapturing(stateRef.current) || stateRef.current === 'paused') await stopInternal();
    else await start();
  }, [start, stopInternal]);

  const replay = useCallback(
    async (entry: ConversationEntry) => {
      await speak(entry.translatedText, entry.targetLang);
    },
    [speak],
  );

  const reset = useCallback(() => {
    setEntries([]);
    pendingRef.current = null;
    setPending(null);
    setNotice(null);
    dispatch('RESET');
  }, [dispatch]);

  // ── Lifecycle ───────────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // Unmount must leave nothing behind: no mic, no socket, no session.
      mountedRef.current = false;
      void recorderRef.current?.stop({ flush: false });
      recorderRef.current = null;
      synthRef.current?.dispose();
      synthRef.current = null;
      wsRef.current?.disconnect();
      wsRef.current = null;
    };
  }, []);

  /** Keep the server's language pair in step without restarting the session. */
  useEffect(() => {
    if (stateRef.current === 'idle') return;
    wsRef.current?.send({ type: 'session.languages', sourceLang, targetLang });
  }, [sourceLang, targetLang]);

  /**
   * Backgrounding a tab suspends timers and the audio graph, so a session left
   * running would silently record nothing while still spending its budget.
   * Pausing on hide makes that explicit and recoverable.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && stateRef.current === 'active') pause();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [pause]);

  const micState = useMemo<MicState>(() => {
    if (stateRef.current === 'active' && pending) return 'processing';
    return micStateFor(sessionState);
  }, [sessionState, pending]);

  return {
    sessionState,
    connectionState,
    micState,
    level,
    quota,
    entries,
    pending,
    notice,
    canSpeak,
    busy: isBusy(sessionState),
    start,
    pause,
    resume,
    stop: stopInternal,
    toggle,
    replay,
    clearNotice: () => setNotice(null),
    reset,
  };
}

function reasonMessage(reason: string): string {
  switch (reason) {
    case 'session_limit':
      return 'This session reached its time limit. Tap start to begin a new one.';
    case 'daily_limit':
      return "You've used all of today's translation time. It resets tomorrow.";
    case 'monthly_limit':
      return "You've used all of this month's translation time.";
    case 'global_limit':
      return 'The app is at capacity right now. Please try again shortly.';
    case 'expired':
      return 'The session timed out. Tap start to begin a new one.';
    default:
      return 'The session ended.';
  }
}
