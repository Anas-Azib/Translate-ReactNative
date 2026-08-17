import { useCallback, useEffect, useRef } from 'react';
import { createMicOrb, ORB_SHAPES } from '../../animations/micOrb';
import type { MicOrbHandle } from '../../animations/micOrb';
import { pressIn, pressOut } from '../../animations/interactions';
import type { MicState } from '../../types';

const BAR_COUNT = 40;
const PARTICLE_COUNT = 22;

export interface MicOrbProps {
  state: MicState;
  /** Live amplitude, 0–1. */
  level: number;
  /** Session budget consumed, 0–1. Draws the ring around the orb. */
  progress: number;
  /** `hold` = walkie-talkie, `tap` = toggle. From the `mic_control` experiment. */
  mode: 'hold' | 'tap';
  disabled?: boolean;
  onPressStart: () => void;
  onPressEnd: () => void;
  onToggle: () => void;
  /** Bumped by the parent to fire the celebration burst. */
  celebrateKey?: number;
}

/**
 * The primary control.
 *
 * Both interaction modes are wired to pointer events rather than mouse/touch
 * pairs, which avoids the double-fire that plagues hybrid devices. In `hold`
 * mode the pointer is captured on the button so a finger that slides off mid-
 * sentence does not silently cut the recording — a real problem on a phone held
 * one-handed.
 */
export function MicOrb({
  state,
  level,
  progress,
  mode,
  disabled = false,
  onPressStart,
  onPressEnd,
  onToggle,
  celebrateKey = 0,
}: MicOrbProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const orbRef = useRef<MicOrbHandle | null>(null);
  const holdingRef = useRef(false);

  useEffect(() => {
    if (!svgRef.current) return;
    orbRef.current = createMicOrb(svgRef.current);
    return () => orbRef.current?.kill();
  }, []);

  useEffect(() => orbRef.current?.setState(state), [state]);
  useEffect(() => orbRef.current?.setLevel(level), [level]);
  useEffect(() => orbRef.current?.setProgress(progress), [progress]);
  useEffect(() => {
    if (celebrateKey > 0) orbRef.current?.burst();
  }, [celebrateKey]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (disabled) return;
      if (buttonRef.current) {
        pressIn(buttonRef.current);
        // Keeps events flowing to this button even if the finger drifts off it.
        buttonRef.current.setPointerCapture?.(event.pointerId);
      }
      if (mode === 'hold') {
        holdingRef.current = true;
        onPressStart();
      }
    },
    [disabled, mode, onPressStart],
  );

  const handlePointerUp = useCallback(() => {
    if (disabled) return;
    if (buttonRef.current) pressOut(buttonRef.current);
    if (mode === 'hold' && holdingRef.current) {
      holdingRef.current = false;
      onPressEnd();
    }
  }, [disabled, mode, onPressEnd]);

  const handleClick = useCallback(() => {
    if (disabled || mode !== 'tap') return;
    onToggle();
  }, [disabled, mode, onToggle]);

  // Keyboard parity: Space/Enter drives whichever model is active.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (disabled || (event.key !== ' ' && event.key !== 'Enter')) return;
      event.preventDefault();
      if (event.repeat) return;
      if (mode === 'hold') {
        holdingRef.current = true;
        onPressStart();
      }
    },
    [disabled, mode, onPressStart],
  );

  const handleKeyUp = useCallback(
    (event: React.KeyboardEvent) => {
      if (disabled || (event.key !== ' ' && event.key !== 'Enter')) return;
      event.preventDefault();
      if (mode === 'hold' && holdingRef.current) {
        holdingRef.current = false;
        onPressEnd();
      } else if (mode === 'tap') {
        onToggle();
      }
    },
    [disabled, mode, onPressEnd, onToggle],
  );

  const listening = state === 'listening';
  const label =
    state === 'blocked'
      ? 'Translation unavailable'
      : listening
        ? 'Stop listening'
        : mode === 'hold'
          ? 'Hold to speak'
          : 'Start listening';

  return (
    <button
      ref={buttonRef}
      type="button"
      className="orb"
      data-state={state}
      data-mode={mode}
      data-testid="mic-orb"
      disabled={disabled}
      aria-label={label}
      aria-pressed={listening}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg ref={svgRef} viewBox="0 0 200 200" className="orb__svg" aria-hidden="true">
        <defs>
          <linearGradient id="orbGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop className="orb__grad-from" offset="0%" stopColor="#0a84ff" />
            <stop className="orb__grad-to" offset="100%" stopColor="#64d2ff" />
          </linearGradient>
          <radialGradient id="orbGlow">
            <stop className="orb__glow" offset="0%" stopColor="#0a84ff" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#0a84ff" stopOpacity="0" />
          </radialGradient>
          <filter id="orbBlur" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>

        {/* Ambient glow */}
        <circle cx="100" cy="100" r="96" fill="url(#orbGlow)" />

        {/* Expanding ripples while listening */}
        {[0, 1, 2].map((i) => (
          <circle
            key={i}
            className="orb__ring"
            cx="100"
            cy="100"
            r="70"
            fill="none"
            stroke="url(#orbGrad)"
            strokeWidth="2"
            opacity="0"
          />
        ))}

        {/* Session-budget ring */}
        <circle
          className="orb__progress"
          cx="100"
          cy="100"
          r="88"
          fill="none"
          stroke="url(#orbGrad)"
          strokeWidth="3"
          strokeLinecap="round"
          opacity="0.85"
        />

        {/* Circular equaliser — driven by gsap.ticker, not React.
            Each bar needs two different transform origins: it rotates about the
            orb's centre but grows from its own inner edge. One element cannot
            do both, so the wrapper <g> owns the rotation and the <rect> owns
            the scale. The rect sits at r=66, clear of the r=62 core, and at
            full scale reaches r≈86, just inside the r=88 progress ring. */}
        <g className="orb__bars">
          {Array.from({ length: BAR_COUNT }, (_, i) => (
            <g key={i} className="orb__bar-wrap">
              <rect className="orb__bar" x="98.4" y="12" width="3.2" height="22" rx="1.6" fill="url(#orbGrad)" />
            </g>
          ))}
        </g>

        {/* Morphing core */}
        <path className="orb__core" d={ORB_SHAPES.idle} fill="url(#orbGrad)" filter="url(#orbBlur)" opacity="0.55" />
        <path className="orb__core-solid" d={ORB_SHAPES.idle} fill="url(#orbGrad)" opacity="0.92" />

        {/* Mic glyph */}
        <g className="orb__icon" fill="#fff">
          <rect x="92" y="78" width="16" height="30" rx="8" />
          <path
            d="M84 102 a16 16 0 0 0 32 0"
            fill="none"
            stroke="#fff"
            strokeWidth="4.5"
            strokeLinecap="round"
          />
          <rect x="97.5" y="118" width="5" height="10" rx="2.5" />
        </g>

        {/* Celebration particles */}
        <g className="orb__particles">
          {Array.from({ length: PARTICLE_COUNT }, (_, i) => (
            <circle key={i} cx="100" cy="100" r="3" fill="url(#orbGrad)" opacity="0" />
          ))}
        </g>
      </svg>

      <span className="sr-only">{label}</span>
    </button>
  );
}
