import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gsap } from '../../animations/gsapSetup';
import { playIntro } from '../../animations/interactions';
import { useExperiments } from '../../experiments/ExperimentProvider';
import { useTranslationSession } from '../../hooks/useTranslationSession';
import type { ApiClient } from '../../services/api';
import type { AppConfigResponse, LanguageOption } from '../../types';
import { Aurora } from '../ui/Aurora';
import { LanguageBar } from '../ui/LanguageBar';
import { LanguageSheet } from '../ui/LanguageSheet';
import { MicOrb } from '../ui/MicOrb';
import { NoticePill } from '../ui/NoticePill';
import { QuotaMeter } from '../ui/QuotaMeter';
import { TranscriptCard } from '../ui/TranscriptCard';
import { LiveTranscript } from '../ui/LiveTranscript';

export interface TranslateScreenProps {
  api: ApiClient;
  config: AppConfigResponse;
}

const STORAGE_KEYS = { source: 'atl.source', target: 'atl.target' };

export function TranslateScreen({ api, config }: TranslateScreenProps) {
  const { variant, track } = useExperiments();

  const micMode = variant('mic_control');
  const layout = variant('result_layout');
  const autoplay = variant('autoplay_tts') === 'autoplay';

  const [source, setSource] = useState(() => remember(STORAGE_KEYS.source, config.defaults.source));
  const [target, setTarget] = useState(() => remember(STORAGE_KEYS.target, config.defaults.target));
  const [sheet, setSheet] = useState<'source' | 'target' | null>(null);
  const [celebrate, setCelebrate] = useState(0);

  const shellRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstTranslationRef = useRef(true);

  const session = useTranslationSession({
    deviceId: api.deviceId,
    sourceLang: source,
    targetLang: target,
    autoplay,
    onTranslation: () => {
      setCelebrate((n) => n + 1);
      track('translation_completed');
      if (firstTranslationRef.current) {
        firstTranslationRef.current = false;
        track('first_translation_completed');
      }
      if (autoplay) track('tts_played');
    },
    onSessionEnded: () => track('session_completed_without_error'),
  });

  const languages = config.languages;

  // App-launch choreography, once.
  useEffect(() => {
    if (!shellRef.current) return;
    const ctx = gsap.context(() => playIntro(shellRef.current!), shellRef);
    return () => ctx.revert();
  }, []);

  // Keep the newest card in view. `smooth` only when the user is already near
  // the bottom, so scrolling back through history is never yanked away.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || session.entries.length === 0) return;
    const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (distanceFromBottom < 260) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    }
  }, [session.entries.length, session.pending?.segmentId]);

  useEffect(() => {
    persist(STORAGE_KEYS.source, source);
    persist(STORAGE_KEYS.target, target);
  }, [source, target]);

  const handleSwap = useCallback(() => {
    setSource(target);
    setTarget(source);
    track('language_changed');
  }, [source, target, track]);

  const handleSelect = useCallback(
    (code: string) => {
      if (sheet === 'source') setSource(code);
      else if (sheet === 'target') setTarget(code);
      setSheet(null);
      track('language_changed');
    },
    [sheet, track],
  );

  const handleStart = useCallback(() => {
    track('session_started');
    void session.start();
  }, [session, track]);

  const sessionProgress = useMemo(() => {
    const q = session.quota;
    if (!q || q.sessionSecondsLimit <= 0) return 0;
    return Math.min(1, q.sessionSecondsUsed / q.sessionSecondsLimit);
  }, [session.quota]);

  const listening = session.micState === 'listening';
  const hint = buildHint(session.sessionState, micMode);

  return (
    <>
      {/* Background energy tracks the voice while listening. */}
      <Aurora energy={listening ? Math.min(1, session.level * 1.4) : 0} />

      <div className="app" ref={shellRef}>
        <header className="topbar" data-intro>
          <div className="topbar__brand">
            <span className="topbar__mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path
                  d="M4 7h9M8.5 7c0 4.5-2 8-4.5 10M7 12.5c1.6 2.6 3.8 4.2 6 5M13.5 20l4-10 4 10M15.2 16.6h5.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="topbar__title">Translate</span>
          </div>

          <QuotaMeter
            quota={session.quota}
            dailyLimitSeconds={config.limits.dailySeconds}
            sessionLimitSeconds={config.limits.sessionSeconds}
          />
        </header>

        <NoticePill
          text={session.notice?.text ?? null}
          tone={session.notice?.tone ?? 'neutral'}
          onDismiss={session.clearNotice}
        />

        <LanguageBar
          languages={languages}
          source={source}
          target={target}
          onPick={setSheet}
          onSwap={handleSwap}
          disabled={listening}
        />

        <main className="stream" ref={scrollRef} data-intro>
          {session.entries.length === 0 && !session.pending ? (
            <EmptyState mode={micMode} languages={languages} source={source} target={target} />
          ) : (
            <>
              {session.entries.map((entry) => (
                <TranscriptCard
                  key={entry.id}
                  entry={entry}
                  languages={languages}
                  layout={layout}
                  onReplay={(e) => {
                    track('translation_replayed');
                    track('tts_played');
                    void session.replay(e);
                  }}
                />
              ))}

              {/* The segment still arriving. Rendered separately from settled
                  history so its two typewriters own their own state and are not
                  restarted when a previous card re-renders. */}
              {session.pending && (
                <LiveTranscript
                  key={session.pending.segmentId}
                  sourceText={session.pending.sourceText}
                  translatedText={session.pending.translatedText}
                  sourceLang={languages.find((l) => l.speechCode === source)}
                  targetLang={languages.find((l) => l.speechCode === target)}
                />
              )}
            </>
          )}
        </main>

        <footer className="dock">
          <div data-intro-orb>
            <MicOrb
              state={session.micState}
              level={session.level}
              progress={sessionProgress}
              mode={micMode}
              disabled={session.busy}
              celebrateKey={celebrate}
              onPressStart={handleStart}
              onPressEnd={() => void session.stop()}
              onToggle={() => {
                if (!listening) track('session_started');
                void session.toggle();
              }}
            />
          </div>

          <p className="dock__hint" data-intro data-testid="mic-hint">
            {hint}
          </p>

          {(session.sessionState === 'active' || session.sessionState === 'paused') && (
            <button
              type="button"
              className="dock__secondary"
              data-testid="pause-resume"
              onClick={() => (session.sessionState === 'paused' ? session.resume() : session.pause())}
            >
              {session.sessionState === 'paused' ? 'Resume' : 'Pause'}
            </button>
          )}

          {!session.canSpeak && (
            <p className="dock__note">
              This device can’t speak out loud — show the translation on screen instead.
            </p>
          )}

          {session.sessionState === 'error' && (
            <button type="button" className="dock__reset" onClick={session.reset}>
              Try again
            </button>
          )}
        </footer>
      </div>

      <LanguageSheet
        open={sheet !== null}
        role={sheet ?? 'source'}
        languages={languages}
        selected={sheet === 'target' ? target : source}
        otherSelected={sheet === 'target' ? source : target}
        onSelect={handleSelect}
        onClose={() => setSheet(null)}
        behindRef={shellRef}
      />

      {/* Announces results to screen readers without stealing focus. */}
      <div className="sr-only" role="status" aria-live="polite">
        {session.entries.at(-1)?.translatedText ?? ''}
      </div>
    </>
  );
}

function EmptyState({
  mode,
  languages,
  source,
  target,
}: {
  mode: 'hold' | 'tap';
  languages: LanguageOption[];
  source: string;
  target: string;
}) {
  const from = languages.find((l) => l.speechCode === source);
  const to = languages.find((l) => l.speechCode === target);

  return (
    <div className="empty" data-testid="empty-state">
      <div className="empty__pair" aria-hidden="true">
        <span className="empty__flag">{from?.flag}</span>
        <span className="empty__arrow">→</span>
        <span className="empty__flag">{to?.flag}</span>
      </div>
      <h2 className="empty__title">
        Say something in {from?.labelEn ?? 'your language'}
      </h2>
      <p className="empty__body">
        {mode === 'hold'
          ? 'Hold the blue button below and speak. Let go when you are done.'
          : 'Tap the blue button below and speak. Tap again when you are done.'}
      </p>
    </div>
  );
}

/** Hint text derived from the session state machine, not ad-hoc booleans. */
function buildHint(state: string, mode: 'hold' | 'tap'): string {
  switch (state) {
    case 'starting':
      return 'Connecting…';
    case 'active':
      return mode === 'hold' ? 'Listening… let go when you finish' : 'Listening… tap to stop';
    case 'paused':
      return 'Paused — tap resume to continue';
    case 'stopping':
      return 'Finishing up…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'error':
      return 'Something went wrong. Tap to try again.';
    default:
      return mode === 'hold' ? 'Hold to speak' : 'Tap to speak';
  }
}

function remember(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode — preferences just won't persist.
  }
}
