import { gsap } from 'gsap';
import { CustomEase } from 'gsap/CustomEase';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { Flip } from 'gsap/Flip';
import { MorphSVGPlugin } from 'gsap/MorphSVGPlugin';
import { MotionPathPlugin } from 'gsap/MotionPathPlugin';
import { Physics2DPlugin } from 'gsap/Physics2DPlugin';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

/**
 * Central GSAP configuration.
 *
 * Two things happen here that matter for the whole app:
 *
 *  1. Custom eases that match Apple's motion language. iOS animations are not
 *     linear or generic cubic-bezier — they decelerate hard and settle with a
 *     little overshoot. `apple-out` and `apple-spring` are used everywhere so
 *     the whole app moves like one system.
 *  2. A reduced-motion switch. When the OS asks for less motion we globally slow
 *     `gsap.globalTimeline` to an instant snap rather than shipping a second set
 *     of code paths, so accessibility never depends on remembering to check.
 */

let registered = false;

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export function setupGsap(): typeof gsap {
  if (registered) return gsap;
  registered = true;

  gsap.registerPlugin(
    CustomEase,
    DrawSVGPlugin,
    Flip,
    MorphSVGPlugin,
    MotionPathPlugin,
    Physics2DPlugin,
    ScrollTrigger,
  );

  // Apple's standard deceleration curve — fast start, long glide, no bounce.
  CustomEase.create('apple-out', 'M0,0 C0.16,1 0.3,1 1,1');
  // The settle you feel when a sheet snaps into place.
  CustomEase.create('apple-spring', 'M0,0 C0.34,1.56 0.64,1 1,1');
  // Symmetric curve for state cross-fades.
  CustomEase.create('apple-inout', 'M0,0 C0.65,0 0.35,1 1,1');
  // Sharp attack for haptic-feeling taps.
  CustomEase.create('haptic', 'M0,0 C0.2,1.4 0.4,1 1,1');

  gsap.defaults({ ease: 'apple-out', duration: 0.6 });

  // Dev-only handle for inspecting and scrubbing timelines from the console
  // (`gsap.globalTimeline.timeScale(0.2)`, `gsap.updateRoot(t)`). Stripped from
  // production builds by the `import.meta.env.DEV` guard.
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    (window as unknown as { gsap?: typeof gsap }).gsap = gsap;
  }

  if (prefersReducedMotion()) {
    // Everything still runs and still fires its callbacks — it just arrives
    // immediately, so state-dependent logic keeps working.
    gsap.globalTimeline.timeScale(200);
  }

  return gsap;
}

export {
  gsap,
  CustomEase,
  DrawSVGPlugin,
  Flip,
  MorphSVGPlugin,
  MotionPathPlugin,
  Physics2DPlugin,
  ScrollTrigger,
};

/**
 * Runs `fn` inside a GSAP context bound to `scope`, returning the cleanup
 * function React effects need. Every animation in this app is created this way,
 * so unmounting a component reliably kills its tweens and ScrollTriggers.
 */
export function withContext(
  scope: Element | null | undefined,
  fn: (ctx: gsap.Context) => void,
): () => void {
  if (!scope) return () => {};
  const ctx = gsap.context(fn, scope);
  return () => ctx.revert();
}

/** Deterministic pseudo-random in [min,max) — keeps "organic" motion testable. */
export function seededRange(seed: number, min: number, max: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return min + (x - Math.floor(x)) * (max - min);
}
