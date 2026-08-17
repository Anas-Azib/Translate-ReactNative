import { useCallback, useEffect, useRef, useState } from 'react';
import { gsap } from '../../animations/gsapSetup';
import { revealText } from '../../animations/splitText';

export interface OnboardingProps {
  /** From the `onboarding` experiment. `instant` shows a single tap-through. */
  variant: 'guided' | 'instant';
  onFinish: () => void;
}

interface Step {
  title: string;
  body: string;
  accent: string;
  art: 'speak' | 'translate' | 'listen';
}

/**
 * Copy is written for someone who has never used a translation app and may not
 * read English well: short sentences, concrete verbs, no jargon ("quota",
 * "session", "API" appear nowhere).
 */
const STEPS: Step[] = [
  {
    title: 'Speak normally',
    body: 'Hold the button and talk. Stop when you finish your sentence.',
    accent: '#0a84ff',
    art: 'speak',
  },
  {
    title: 'We translate it',
    body: 'Your words appear on screen in both languages, right away.',
    accent: '#bf5af2',
    art: 'translate',
  },
  {
    title: 'They hear it',
    body: 'The translation is spoken out loud. Show them your phone and talk.',
    accent: '#30d158',
    art: 'listen',
  },
];

export function Onboarding({ variant, onFinish }: OnboardingProps) {
  const [index, setIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const artRef = useRef<SVGSVGElement>(null);

  const steps = variant === 'guided' ? STEPS : [STEPS[0]!];
  const step = steps[index]!;
  const isLast = index === steps.length - 1;

  // Each step's illustration animates itself in, then loops a small idle motion
  // so a user who pauses to read still sees a living screen.
  useEffect(() => {
    if (!artRef.current || !rootRef.current) return;
    const ctx = gsap.context(() => {
      const svg = artRef.current!;
      gsap.fromTo(
        svg.querySelectorAll('[data-art-part]'),
        { scale: 0.4, opacity: 0, transformOrigin: '50% 50%' },
        { scale: 1, opacity: 1, duration: 0.8, stagger: 0.09, ease: 'apple-spring' },
      );
      gsap.to(svg.querySelectorAll('[data-art-pulse]'), {
        scale: 1.18,
        opacity: 0.25,
        duration: 1.5,
        repeat: -1,
        yoyo: true,
        stagger: 0.2,
        ease: 'sine.inOut',
        transformOrigin: '50% 50%',
      });
      if (titleRef.current) revealText(titleRef.current, { delay: 0.12 });
    }, rootRef);
    return () => ctx.revert();
  }, [index]);

  const advance = useCallback(() => {
    if (isLast) {
      // Exit as one piece: the panel drops away while the whole overlay fades,
      // so the app underneath is revealed rather than swapped.
      const tl = gsap.timeline({ onComplete: onFinish });
      tl.to('[data-onboard-panel]', { y: 60, opacity: 0, scale: 0.94, duration: 0.42, ease: 'apple-inout' })
        .to('[data-onboard-root]', { opacity: 0, duration: 0.32 }, '-=0.2');
      return;
    }
    const tl = gsap.timeline();
    tl.to('[data-onboard-content]', { x: -40, opacity: 0, duration: 0.26, ease: 'apple-inout' })
      .add(() => setIndex((i) => i + 1))
      .fromTo('[data-onboard-content]', { x: 40, opacity: 0 }, { x: 0, opacity: 1, duration: 0.42, ease: 'apple-out' });
  }, [isLast, onFinish]);

  return (
    <div ref={rootRef} className="onboard" data-onboard-root data-testid="onboarding">
      <div className="onboard__panel glass" data-onboard-panel>
        <div data-onboard-content>
          <svg
            ref={artRef}
            className="onboard__art"
            viewBox="0 0 200 140"
            aria-hidden="true"
            style={{ color: step.accent }}
          >
            <StepArt art={step.art} />
          </svg>

          <h1 ref={titleRef} className="onboard__title">
            {step.title}
          </h1>
          <p className="onboard__body">{step.body}</p>
        </div>

        {variant === 'guided' && (
          <div className="onboard__dots" role="tablist" aria-label="Steps">
            {steps.map((_, i) => (
              <span key={i} className="onboard__dot" data-active={i === index} role="tab" aria-selected={i === index} />
            ))}
          </div>
        )}

        <button
          type="button"
          className="onboard__cta"
          onClick={advance}
          data-testid="onboarding-next"
          style={{ background: `linear-gradient(135deg, ${step.accent}, ${step.accent}cc)` }}
        >
          {isLast ? "Start translating" : 'Next'}
        </button>

        {!isLast && (
          <button type="button" className="onboard__skip" onClick={onFinish} data-testid="onboarding-skip">
            Skip
          </button>
        )}
      </div>
    </div>
  );
}

function StepArt({ art }: { art: Step['art'] }) {
  if (art === 'speak') {
    return (
      <>
        <circle data-art-part data-art-pulse cx="100" cy="70" r="46" fill="currentColor" opacity="0.14" />
        <circle data-art-part data-art-pulse cx="100" cy="70" r="34" fill="currentColor" opacity="0.2" />
        <rect data-art-part x="92" y="50" width="16" height="30" rx="8" fill="currentColor" />
        <path
          data-art-part
          d="M84 74a16 16 0 0 0 32 0"
          fill="none"
          stroke="currentColor"
          strokeWidth="4.5"
          strokeLinecap="round"
        />
        <rect data-art-part x="97.5" y="90" width="5" height="10" rx="2.5" fill="currentColor" />
      </>
    );
  }
  if (art === 'translate') {
    return (
      <>
        <rect data-art-part x="26" y="38" width="62" height="42" rx="14" fill="currentColor" opacity="0.22" />
        <rect data-art-part x="112" y="60" width="62" height="42" rx="14" fill="currentColor" opacity="0.4" />
        <path
          data-art-part
          d="M92 62h16m0 0l-6-6m6 6l-6 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect data-art-part x="38" y="52" width="34" height="4.5" rx="2.25" fill="currentColor" opacity="0.7" />
        <rect data-art-part x="38" y="62" width="22" height="4.5" rx="2.25" fill="currentColor" opacity="0.5" />
        <rect data-art-part x="124" y="74" width="34" height="4.5" rx="2.25" fill="currentColor" opacity="0.9" />
        <rect data-art-part x="124" y="84" width="26" height="4.5" rx="2.25" fill="currentColor" opacity="0.7" />
      </>
    );
  }
  return (
    <>
      <circle data-art-part data-art-pulse cx="70" cy="70" r="40" fill="currentColor" opacity="0.16" />
      <path data-art-part d="M52 58h12l14-13v50l-14-13H52z" fill="currentColor" />
      <path
        data-art-part
        data-art-pulse
        d="M96 58a18 18 0 0 1 0 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="4.5"
        strokeLinecap="round"
      />
      <path
        data-art-part
        data-art-pulse
        d="M108 48a32 32 0 0 1 0 44"
        fill="none"
        stroke="currentColor"
        strokeWidth="4.5"
        strokeLinecap="round"
      />
      <path
        data-art-part
        data-art-pulse
        d="M120 38a46 46 0 0 1 0 64"
        fill="none"
        stroke="currentColor"
        strokeWidth="4.5"
        strokeLinecap="round"
        opacity="0.6"
      />
    </>
  );
}
