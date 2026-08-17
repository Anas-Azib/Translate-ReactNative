import { useEffect, useRef } from 'react';
import { gsap } from '../../animations/gsapSetup';
import { prefersReducedMotion } from '../../animations/gsapSetup';
import { useTypewriter } from '../../hooks/useTypewriter';
import type { LanguageOption } from '../../types';

export interface LiveTranscriptProps {
  sourceText: string;
  translatedText: string;
  sourceLang?: LanguageOption;
  targetLang?: LanguageOption;
}

/**
 * The in-progress segment: what was just heard, and its translation arriving
 * behind it.
 *
 * The two texts run **independent** typewriters. That matters because the
 * server delivers them as separate stages — the transcript is pushed the moment
 * recognition finishes, while translation is still in flight — so the source
 * text must be free to animate to completion without waiting for, or being
 * restarted by, the translation.
 */
export function LiveTranscript({ sourceText, translatedText, sourceLang, targetLang }: LiveTranscriptProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const reduced = prefersReducedMotion();

  // Source types slightly faster: it is confirmation, not the thing being read.
  const source = useTypewriter(sourceText, { charsPerSecond: 55, instant: reduced });
  const translated = useTypewriter(translatedText, { charsPerSecond: 42, instant: reduced });

  useEffect(() => {
    if (!cardRef.current) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        cardRef.current,
        { y: 24, opacity: 0, scale: 0.97 },
        { y: 0, opacity: 1, scale: 1, duration: 0.5, ease: 'apple-spring' },
      );
    }, cardRef);
    return () => ctx.revert();
  }, []);

  return (
    <div ref={cardRef} className="card card--live glass" data-testid="live-transcript" aria-live="polite">
      <div className="card__face card__face--front">
        <section className="card__section" dir={sourceLang?.rtl ? 'rtl' : 'ltr'}>
          <header className="card__row">
            <span className="card__badge card__badge--source">
              <span aria-hidden="true">{sourceLang?.flag}</span>
              {sourceLang?.labelNative ?? ''}
            </span>
            <span className="card__live" aria-hidden="true">
              <span className="card__live-dot" />
              live
            </span>
          </header>
          <p className="card__source" lang={sourceLang?.translateCode} data-testid="live-source">
            {source.text}
            {source.typing && <Caret />}
          </p>
        </section>

        {/* The translation half only appears once there is something to show,
            so an empty block does not reserve space before stage two lands. */}
        {(translated.text.length > 0 || translatedText.length > 0) && (
          <>
            <div className="card__divider" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="15" height="15">
                <path
                  d="M12 5v14M12 19l-4.5-4.5M12 19l4.5-4.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>

            <section className="card__section" dir={targetLang?.rtl ? 'rtl' : 'ltr'}>
              <header className="card__row">
                <span className="card__badge card__badge--target">
                  <span aria-hidden="true">{targetLang?.flag}</span>
                  {targetLang?.labelNative ?? ''}
                </span>
              </header>
              <p
                className="card__translated"
                lang={targetLang?.translateCode}
                data-testid="live-translated"
              >
                {translated.text}
                {translated.typing && <Caret />}
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/** Blinking cursor. Purely decorative, so hidden from assistive tech. */
function Caret() {
  return <span className="typing-caret" aria-hidden="true" />;
}
