import { useEffect, useRef } from 'react';
import { gsap } from '../../animations/gsapSetup';
import { shake } from '../../animations/interactions';

export interface NoticePillProps {
  text: string | null;
  tone: 'neutral' | 'warning' | 'error';
  onDismiss?: () => void;
}

/**
 * Status pill, styled after the Dynamic Island: it expands from a dot, holds
 * the message, and contracts away.
 *
 * Chosen over a toast because it sits in the same place every time and never
 * covers the mic button — a user mid-sentence should never lose the control
 * they're holding to a piece of chrome.
 */
export function NoticePill({ text, tone, onDismiss }: NoticePillProps) {
  const pillRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const shownRef = useRef(false);

  useEffect(() => {
    const pill = pillRef.current;
    if (!pill) return;

    if (text) {
      const tl = gsap.timeline();
      if (!shownRef.current) {
        // Expand from a capsule: width and height animate on different curves,
        // which is what makes it read as one continuous piece of material
        // rather than a box fading in.
        tl.fromTo(
          pill,
          { scaleX: 0.25, scaleY: 0.6, opacity: 0, y: -14 },
          { scaleX: 1, scaleY: 1, opacity: 1, y: 0, duration: 0.62, ease: 'apple-spring' },
        ).fromTo(
          contentRef.current,
          { opacity: 0, y: 6 },
          { opacity: 1, y: 0, duration: 0.34, ease: 'apple-out' },
          '-=0.28',
        );
        shownRef.current = true;
      } else {
        // Already open — cross-fade the text and give the pill a small nudge.
        tl.fromTo(contentRef.current, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3 })
          .to(pill, { scale: 1.04, duration: 0.14, ease: 'haptic' }, 0)
          .to(pill, { scale: 1, duration: 0.3, ease: 'apple-spring' }, 0.14);
      }
      if (tone === 'error') shake(pill);
      return;
    }

    if (shownRef.current) {
      shownRef.current = false;
      gsap.to(pill, {
        scaleX: 0.25,
        scaleY: 0.6,
        opacity: 0,
        y: -12,
        duration: 0.38,
        ease: 'apple-inout',
      });
    }
  }, [text, tone]);

  // Neutral notices are informational; they clear themselves so the user is not
  // left tapping a status message to get on with the conversation.
  useEffect(() => {
    if (!text || tone !== 'neutral' || !onDismiss) return;
    const timer = setTimeout(onDismiss, 4200);
    return () => clearTimeout(timer);
  }, [text, tone, onDismiss]);

  return (
    <div
      ref={pillRef}
      className="pill glass"
      data-tone={tone}
      data-testid="notice-pill"
      role="status"
      aria-live="polite"
      style={{ opacity: 0 }}
    >
      <span className="pill__dot" aria-hidden="true" />
      <span ref={contentRef} className="pill__text">
        {text}
      </span>
      {onDismiss && text && tone !== 'neutral' && (
        <button type="button" className="pill__close" onClick={onDismiss} aria-label="Dismiss message">
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      )}
    </div>
  );
}
