import { gsap } from './gsapSetup';
import type { MicState } from '../types';

export interface MicOrbHandle {
  setState: (state: MicState) => void;
  /** Live microphone amplitude, 0–1. Called every animation frame. */
  setLevel: (level: number) => void;
  /** Session time consumed, 0–1. Drives the ring that empties as time runs out. */
  setProgress: (progress: number) => void;
  /** Celebratory particle burst when a translation lands. */
  burst: () => void;
  kill: () => void;
}

/** Morph targets for the core blob. Same command structure so MorphSVG interpolates cleanly. */
export const ORB_SHAPES = {
  // Perfect circle, as four cubic arcs.
  idle: 'M100,38 C134.2,38 162,65.8 162,100 C162,134.2 134.2,162 100,162 C65.8,162 38,134.2 38,100 C38,65.8 65.8,38 100,38 Z',
  // Squashed, asymmetric — reads as "alive and listening".
  listening:
    'M100,32 C140.6,34 168,70.4 166,104 C164,137.6 133.4,168 99,166 C64.6,164 34,136.6 34,99 C34,61.4 59.4,30 100,32 Z',
  // Pinched at the waist — reads as "working".
  processing:
    'M100,42 C128.2,42 158,63.8 158,92 C158,120.2 130.2,158 100,158 C69.8,158 42,120.2 42,92 C42,63.8 71.8,42 100,42 Z',
} as const;

const STATE_COLORS: Record<MicState, { from: string; to: string }> = {
  idle: { from: '#0a84ff', to: '#64d2ff' },
  listening: { from: '#ff375f', to: '#bf5af2' },
  processing: { from: '#bf5af2', to: '#5e5ce6' },
  speaking: { from: '#30d158', to: '#63e6e2' },
  blocked: { from: '#8e8e93', to: '#636366' },
};

/**
 * The microphone orb: one SVG driving five visual systems that all have to stay
 * in sync — ripple rings, a morphing core, a 40-bar circular equaliser, a
 * session-progress ring, and a particle burst.
 *
 * The equaliser is driven from `gsap.ticker` rather than from React state on
 * purpose. Amplitude updates arrive at ~60 Hz from the analyser; routing those
 * through React would re-render the tree 60 times a second. Instead the audio
 * level is written into a plain object and the ticker reads it, so the whole
 * visualisation runs entirely outside React's render cycle.
 */
export function createMicOrb(root: SVGSVGElement): MicOrbHandle {
  // Native queries rather than gsap.utils.selector: that helper is typed for
  // HTML elements, and every target here is SVG.
  const all = <T extends SVGElement>(selector: string): T[] =>
    Array.from(root.querySelectorAll<T>(selector));
  const one = <T extends SVGElement>(selector: string): T | null =>
    root.querySelector<T>(selector);

  const core = one<SVGPathElement>('.orb__core');
  const glow = one<SVGStopElement>('.orb__glow');
  const rings = all<SVGCircleElement>('.orb__ring');
  const barWraps = all<SVGGElement>('.orb__bar-wrap');
  const bars = all<SVGRectElement>('.orb__bar');
  const progressRing = one<SVGCircleElement>('.orb__progress');
  const gradFrom = one<SVGStopElement>('.orb__grad-from');
  const gradTo = one<SVGStopElement>('.orb__grad-to');
  const particleLayer = one<SVGGElement>('.orb__particles');

  let state: MicState = 'idle';
  let ripple: gsap.core.Timeline | null = null;
  let breathe: gsap.core.Tween | null = null;
  let spin: gsap.core.Tween | null = null;

  /** Shared mutable amplitude — written by audio, read by the ticker. */
  const audio = { level: 0, smoothed: 0 };

  // ── Bars: a circular equaliser -------------------------------------------
  // Rotation lives on the wrapper (about the orb centre), scale on the rect
  // (about its own inner edge). Setting both on one element would make the
  // bars shrink toward the middle and disappear behind the core.
  barWraps.forEach((wrap, i) => {
    gsap.set(wrap, { rotate: (i / Math.max(1, barWraps.length)) * 360, svgOrigin: '100 100' });
  });
  gsap.set(bars, { transformOrigin: '50% 100%', scaleY: 0.16, opacity: 0.3 });

  const tick = () => {
    // Exponential smoothing: raw analyser output is jittery, and an unsmoothed
    // bar chart looks like noise rather than a voice.
    audio.smoothed += (audio.level - audio.smoothed) * 0.22;
    const time = gsap.ticker.time;

    for (let i = 0; i < bars.length; i += 1) {
      // Each bar samples a travelling wave, so energy appears to circulate
      // around the orb instead of every bar pumping identically.
      const phase = (i / bars.length) * Math.PI * 2;
      const wave = 0.5 + 0.5 * Math.sin(time * 3.4 + phase * 3);
      const secondary = 0.5 + 0.5 * Math.sin(time * 1.7 - phase * 2);
      const amplitude = audio.smoothed * (0.45 + wave * 0.75 + secondary * 0.35);

      // Clamped so a shout cannot push a bar past the progress ring at r=88.
      const scale =
        state === 'listening'
          ? Math.min(0.95, 0.16 + amplitude * 0.8)
          : 0.16 + audio.smoothed * 0.2;

      gsap.set(bars[i]!, {
        scaleY: scale,
        opacity: 0.3 + Math.min(0.65, amplitude * 0.9),
      });
    }
  };
  gsap.ticker.add(tick);

  // ── Idle breathing -------------------------------------------------------
  const startBreathing = () => {
    breathe?.kill();
    if (!core) return;
    breathe = gsap.to(core, {
      scale: 1.045,
      duration: 2.4,
      ease: 'sine.inOut',
      repeat: -1,
      yoyo: true,
      transformOrigin: '50% 50%',
      svgOrigin: '100 100',
    });
  };

  // ── Listening ripples ----------------------------------------------------
  const startRipples = () => {
    ripple?.kill();
    if (rings.length === 0) return;
    gsap.set(rings, { opacity: 0, scale: 1, transformOrigin: '50% 50%', svgOrigin: '100 100' });

    ripple = gsap.timeline({ repeat: -1 });
    rings.forEach((ring, i) => {
      ripple!.fromTo(
        ring,
        { scale: 0.82, opacity: 0.55, strokeWidth: 2.5 },
        {
          scale: 1.9,
          opacity: 0,
          strokeWidth: 0.4,
          duration: 2.6,
          ease: 'apple-out',
        },
        // Even spacing produces a continuous outward wave rather than pulses.
        i * (2.6 / rings.length),
      );
    });
  };

  const stopRipples = () => {
    ripple?.kill();
    ripple = null;
    if (rings.length) gsap.to(rings, { opacity: 0, duration: 0.3 });
  };

  // ── Processing spin ------------------------------------------------------
  const startSpin = () => {
    spin?.kill();
    if (!progressRing) return;
    spin = gsap.to(progressRing, {
      rotate: 360,
      duration: 1.1,
      ease: 'none',
      repeat: -1,
      transformOrigin: '50% 50%',
      svgOrigin: '100 100',
    });
  };

  const stopSpin = () => {
    spin?.kill();
    spin = null;
    if (progressRing) gsap.set(progressRing, { rotate: -90 });
  };

  const applyColors = (next: MicState) => {
    const colors = STATE_COLORS[next];
    if (gradFrom) gsap.to(gradFrom, { attr: { 'stop-color': colors.from }, duration: 0.5 });
    if (gradTo) gsap.to(gradTo, { attr: { 'stop-color': colors.to }, duration: 0.5 });
    if (glow) {
      gsap.to(glow, {
        attr: { 'stop-color': colors.from },
        opacity: next === 'idle' ? 0.35 : 0.7,
        duration: 0.5,
      });
    }
  };

  if (progressRing) {
    gsap.set(progressRing, { rotate: -90, transformOrigin: '50% 50%', svgOrigin: '100 100' });
  }
  startBreathing();
  applyColors('idle');

  return {
    setState(next: MicState) {
      if (next === state) return;
      const previous = state;
      state = next;
      applyColors(next);

      const tl = gsap.timeline();

      // A quick squash on every transition — the tactile "give" of an iOS control.
      if (core) {
        tl.to(core, {
          scale: next === 'idle' ? 1 : 1.08,
          duration: 0.28,
          ease: 'haptic',
          transformOrigin: '50% 50%',
          svgOrigin: '100 100',
        });
      }

      if (core) {
        const shape =
          next === 'listening'
            ? ORB_SHAPES.listening
            : next === 'processing'
              ? ORB_SHAPES.processing
              : ORB_SHAPES.idle;
        tl.to(core, { morphSVG: shape, duration: 0.55, ease: 'apple-spring' }, 0);
      }

      if (next === 'listening') {
        breathe?.pause();
        stopSpin();
        startRipples();
      } else if (next === 'processing') {
        breathe?.pause();
        stopRipples();
        startSpin();
      } else if (next === 'speaking') {
        breathe?.pause();
        stopRipples();
        stopSpin();
      } else {
        stopRipples();
        stopSpin();
        if (previous !== 'idle') startBreathing();
        breathe?.play();
        audio.level = 0;
      }
    },

    setLevel(level: number) {
      audio.level = gsap.utils.clamp(0, 1, level);
    },

    setProgress(progress: number) {
      if (!progressRing) return;
      // DrawSVG draws the ring from 0% to `p`% of its own path length, so the
      // arc grows as the session budget is consumed.
      gsap.to(progressRing, {
        drawSVG: `0% ${gsap.utils.clamp(0, 100, progress * 100)}%`,
        duration: 0.6,
        ease: 'apple-out',
        overwrite: 'auto',
      });
    },

    burst() {
      if (!particleLayer) return;
      const dots = Array.from(particleLayer.querySelectorAll<SVGCircleElement>('circle'));
      if (dots.length === 0) return;

      gsap.set(dots, { x: 0, y: 0, opacity: 1, scale: 1 });
      // Physics2D gives each particle a real ballistic arc — a plain radial
      // scatter looks like a loading spinner, this looks like a celebration.
      gsap.to(dots, {
        duration: 1.1,
        physics2D: {
          velocity: 'random(90, 220)',
          angle: 'random(0, 360)',
          gravity: 160,
        },
        opacity: 0,
        scale: 'random(0.3, 1.1)',
        ease: 'none',
        stagger: 0.012,
      });
    },

    kill() {
      gsap.ticker.remove(tick);
      ripple?.kill();
      breathe?.kill();
      spin?.kill();
      gsap.killTweensOf([...bars, ...barWraps, ...rings]);
      if (core) gsap.killTweensOf(core);
    },
  };
}
