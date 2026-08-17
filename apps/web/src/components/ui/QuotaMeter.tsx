import { useEffect, useRef } from 'react';
import { gsap } from '../../animations/gsapSetup';
import type { QuotaSnapshot } from '../../types';

export interface QuotaMeterProps {
  quota: QuotaSnapshot | null;
  dailyLimitSeconds: number;
  sessionLimitSeconds: number;
}

/**
 * The time budget, shown as two nested arcs.
 *
 * Users have no idea what "quota" means, and a number ticking toward zero is
 * stressful, so this reads as remaining time in plain language ("1:38 left")
 * with the ring as the ambient signal. It turns amber under 30 s and red under
 * 10 s so the stop is never a surprise — the plan document requires sessions to
 * cut off, and an unannounced cutoff is the single most frustrating thing this
 * app could do to someone mid-sentence.
 */
export function QuotaMeter({ quota, dailyLimitSeconds, sessionLimitSeconds }: QuotaMeterProps) {
  const sessionArcRef = useRef<SVGCircleElement>(null);
  const dailyArcRef = useRef<SVGCircleElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

  const sessionLimit = quota?.sessionSecondsLimit ?? sessionLimitSeconds;
  const dailyLimit = quota?.dailySecondsLimit ?? dailyLimitSeconds;
  const sessionUsed = quota?.sessionSecondsUsed ?? 0;
  const dailyUsed = quota?.dailySecondsUsed ?? 0;

  const sessionLeft = Math.max(0, sessionLimit - sessionUsed);
  const dailyLeft = Math.max(0, dailyLimit - dailyUsed);

  const sessionRatio = sessionLimit > 0 ? sessionLeft / sessionLimit : 0;
  const dailyRatio = dailyLimit > 0 ? dailyLeft / dailyLimit : 0;

  useEffect(() => {
    const circumference = 2 * Math.PI * 15;
    if (sessionArcRef.current) {
      gsap.to(sessionArcRef.current, {
        strokeDashoffset: circumference * (1 - sessionRatio),
        duration: 0.7,
        ease: 'apple-out',
      });
    }
    if (dailyArcRef.current) {
      const outer = 2 * Math.PI * 20;
      gsap.to(dailyArcRef.current, {
        strokeDashoffset: outer * (1 - dailyRatio),
        duration: 0.7,
        ease: 'apple-out',
      });
    }
  }, [sessionRatio, dailyRatio]);

  // A pulse in the last ten seconds — peripheral vision catches motion, not text.
  useEffect(() => {
    if (!labelRef.current) return;
    if (sessionLeft > 0 && sessionLeft <= 10) {
      const tween = gsap.to(labelRef.current, {
        opacity: 0.45,
        duration: 0.55,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
      });
      return () => {
        tween.kill();
        gsap.set(labelRef.current, { opacity: 1 });
      };
    }
    gsap.set(labelRef.current, { opacity: 1 });
    return undefined;
  }, [sessionLeft]);

  const tone = sessionLeft <= 10 ? 'critical' : sessionLeft <= 30 ? 'warning' : 'ok';

  return (
    <div className="quota" data-tone={tone} data-intro data-testid="quota-meter">
      <svg viewBox="0 0 44 44" width="34" height="34" aria-hidden="true">
        <circle cx="22" cy="22" r="20" fill="none" stroke="var(--hairline)" strokeWidth="2.5" />
        <circle cx="22" cy="22" r="15" fill="none" stroke="var(--hairline)" strokeWidth="3" />
        <circle
          ref={dailyArcRef}
          cx="22"
          cy="22"
          r="20"
          fill="none"
          stroke="var(--teal)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={2 * Math.PI * 20}
          strokeDashoffset={0}
          transform="rotate(-90 22 22)"
        />
        <circle
          ref={sessionArcRef}
          cx="22"
          cy="22"
          r="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={2 * Math.PI * 15}
          strokeDashoffset={0}
          transform="rotate(-90 22 22)"
        />
      </svg>

      <span className="quota__text">
        <span ref={labelRef} className="quota__primary" data-testid="quota-session">
          {formatDuration(sessionLeft)} left
        </span>
        <span className="quota__secondary">{formatDuration(dailyLeft)} today</span>
      </span>
    </div>
  );
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
