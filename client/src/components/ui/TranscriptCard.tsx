import { useEffect, useRef, useState } from 'react';
import { gsap } from '../../animations/gsapSetup';
import { enterCard } from '../../animations/interactions';
import { revealText } from '../../animations/splitText';
import type { ConversationEntry, LanguageOption } from '../../types';

export interface TranscriptCardProps {
  entry: ConversationEntry;
  languages: LanguageOption[];
  /** From the `result_layout` experiment. */
  layout: 'stacked' | 'flip';
  isLatest: boolean;
  onReplay: (entry: ConversationEntry) => void;
}

/**
 * One exchange: what was heard, and what it became.
 *
 * The translation is the hero — larger type, full colour, and the only half
 * that animates in character by character. The source text is deliberately
 * quieter: it is there for confirmation ("did it hear me right?"), not for
 * reading.
 */
export function TranscriptCard({ entry, languages, layout, isLatest, onReplay }: TranscriptCardProps) {
  const cardRef = useRef<HTMLElement>(null);
  const translatedRef = useRef<HTMLParagraphElement>(null);
  const [flipped, setFlipped] = useState(false);

  const sourceLang = languages.find((l) => l.speechCode === entry.sourceLang);
  const targetLang = languages.find((l) => l.speechCode === entry.targetLang);

  useEffect(() => {
    if (!cardRef.current) return;
    const ctx = gsap.context(() => {
      enterCard(cardRef.current!);
      // Only the newest translation gets the character reveal. Replaying it on
      // older cards during a re-render would be noise, and re-splitting text
      // that is already on screen costs layout work for nothing.
      if (isLatest && translatedRef.current) {
        revealText(translatedRef.current, { rtl: targetLang?.rtl ?? false, delay: 0.22 });
      }
    }, cardRef);
    return () => ctx.revert();
    // Intentionally keyed to the entry id: a card animates once, when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id]);

  const handleFlip = () => {
    if (layout !== 'flip' || !cardRef.current) return;
    const next = !flipped;
    setFlipped(next);
    gsap.to(cardRef.current, {
      rotateY: next ? 180 : 0,
      duration: 0.7,
      ease: 'apple-spring',
      transformPerspective: 900,
      transformOrigin: '50% 50%',
    });
  };

  const confidenceLow = entry.confidence > 0 && entry.confidence < 0.6;

  return (
    <article
      ref={cardRef}
      className="card glass"
      data-layout={layout}
      data-flipped={flipped}
      data-testid="transcript-card"
      onClick={handleFlip}
    >
      <div className="card__face card__face--front">
        {/* `dir` sits on the whole section, not just the paragraph, so the
            badge and the text hang off the same edge. With it only on the text,
            an Arabic phrase reads right-aligned under a left-aligned label and
            the two stop looking like one block. */}
        <section className="card__section" dir={sourceLang?.rtl ? 'rtl' : 'ltr'}>
          <header className="card__row" data-stagger>
            <span className="card__badge card__badge--source">
              <span aria-hidden="true">{sourceLang?.flag}</span>
              {sourceLang?.labelNative ?? entry.sourceLang}
            </span>
            {confidenceLow && (
              <span className="card__confidence" title="Recognition was uncertain">
                not sure
              </span>
            )}
          </header>

          <p
            className="card__source"
            lang={sourceLang?.translateCode}
            data-stagger
            data-testid="card-source"
          >
            {entry.sourceText}
          </p>
        </section>

        <div className="card__divider" data-stagger aria-hidden="true">
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
          <header className="card__row" data-stagger>
            <span className="card__badge card__badge--target">
              <span aria-hidden="true">{targetLang?.flag}</span>
              {targetLang?.labelNative ?? entry.targetLang}
            </span>
          </header>

          <p
            ref={translatedRef}
            className="card__translated"
            lang={targetLang?.translateCode}
            data-stagger
            data-testid="card-translated"
          >
            {entry.translatedText}
          </p>
        </section>

        <footer className="card__actions" data-stagger>
          <button
            type="button"
            className="card__play"
            data-testid="replay-button"
            onClick={(event) => {
              event.stopPropagation();
              onReplay(entry);
            }}
            aria-label={`Play the ${targetLang?.labelEn ?? 'translated'} audio again`}
          >
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
              <path d="M4 9.5h3.6L12 5.4v13.2L7.6 14.5H4z" fill="currentColor" />
              <path
                d="M15.6 9a4.2 4.2 0 0 1 0 6M18.2 6.4a7.8 7.8 0 0 1 0 11.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
              />
            </svg>
            Play again
          </button>

          {entry.ttsCached && (
            <span className="card__meta" title="Reused cached audio — no extra API cost">
              cached
            </span>
          )}
        </footer>
      </div>
    </article>
  );
}
