import { Flip, gsap } from './gsapSetup';

/**
 * Shared interaction motion — the small, repeated animations that make an app
 * feel like one product rather than a pile of screens.
 */

/** Entrance for a newly-arrived conversation card. */
export function enterCard(element: HTMLElement, options: { delay?: number; from?: 'bottom' | 'top' } = {}) {
  const dir = options.from === 'top' ? -1 : 1;
  return gsap
    .timeline({ delay: options.delay ?? 0 })
    .fromTo(
      element,
      { y: 42 * dir, opacity: 0, scale: 0.94, filter: 'blur(8px)' },
      { y: 0, opacity: 1, scale: 1, filter: 'blur(0px)', duration: 0.7, ease: 'apple-spring' },
    )
    // The inner rows cascade after the card itself, so the eye lands on the
    // container first and then reads the content.
    .fromTo(
      element.querySelectorAll('[data-stagger]'),
      { y: 14, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.5, stagger: 0.07, ease: 'apple-out' },
      '-=0.42',
    );
}

export function exitCard(element: HTMLElement, onComplete?: () => void) {
  return gsap.to(element, {
    y: -24,
    opacity: 0,
    scale: 0.95,
    filter: 'blur(6px)',
    duration: 0.36,
    ease: 'apple-inout',
    onComplete,
  });
}

/**
 * Swaps the source and target language chips using FLIP.
 *
 * FLIP is the right tool here rather than a hand-written tween: the chips are
 * different widths ("Arabic" vs "Portuguese"), so the distance each must travel
 * is only knowable after the DOM has actually reordered. FLIP measures the real
 * before/after geometry and inverts it, which is why the swap stays correct at
 * any label length or screen size.
 */
export function swapLanguages(
  container: HTMLElement,
  mutate: () => void,
  options: { onComplete?: () => void } = {},
): void {
  const targets = container.querySelectorAll<HTMLElement>('[data-flip-id]');
  const state = Flip.getState(targets, { props: 'color,backgroundColor' });

  mutate();

  Flip.from(state, {
    duration: 0.72,
    ease: 'apple-spring',
    absolute: true,
    // Chips travel along an arc rather than a straight line — they pass around
    // each other instead of through each other.
    spin: false,
    onEnter: (els) => gsap.fromTo(els, { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.4 }),
    onComplete: options.onComplete ?? (() => {}),
  });
}

/** The 180° arc the swap button traces on tap. */
export function spinSwapButton(button: HTMLElement) {
  return gsap
    .timeline()
    .to(button, { scale: 0.86, duration: 0.12, ease: 'haptic' })
    .to(button, { rotate: '+=180', duration: 0.6, ease: 'apple-spring' }, 0)
    .to(button, { scale: 1, duration: 0.4, ease: 'apple-spring' }, 0.12);
}

/** Press feedback for any tappable control. Mirrors UIKit's highlight scale. */
export function pressIn(element: HTMLElement) {
  return gsap.to(element, { scale: 0.95, duration: 0.14, ease: 'apple-out', overwrite: 'auto' });
}

export function pressOut(element: HTMLElement) {
  return gsap.to(element, { scale: 1, duration: 0.42, ease: 'apple-spring', overwrite: 'auto' });
}

/**
 * iOS-style sheet presentation: the sheet rises while the content behind it
 * scales down and dims, which is what sells the sense of depth.
 */
export function presentSheet(sheet: HTMLElement, backdrop: HTMLElement, behind?: HTMLElement | null) {
  const tl = gsap.timeline();
  tl.fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: 0.34, ease: 'apple-out' })
    .fromTo(
      sheet,
      { yPercent: 100 },
      { yPercent: 0, duration: 0.58, ease: 'apple-spring' },
      0,
    )
    .fromTo(
      sheet.querySelectorAll('[data-sheet-item]'),
      { y: 24, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.45, stagger: 0.028, ease: 'apple-out' },
      0.14,
    );

  if (behind) {
    tl.to(behind, { scale: 0.94, opacity: 0.6, duration: 0.5, ease: 'apple-out' }, 0);
  }
  return tl;
}

export function dismissSheet(
  sheet: HTMLElement,
  backdrop: HTMLElement,
  behind: HTMLElement | null | undefined,
  onComplete: () => void,
) {
  const tl = gsap.timeline({ onComplete });
  tl.to(sheet, { yPercent: 100, duration: 0.4, ease: 'apple-inout' })
    .to(backdrop, { opacity: 0, duration: 0.32 }, 0);
  if (behind) tl.to(behind, { scale: 1, opacity: 1, duration: 0.45, ease: 'apple-out' }, 0);
  return tl;
}

/** Error shake. Short, sharp, decaying — the iOS passcode shake. */
export function shake(element: HTMLElement) {
  return gsap.fromTo(
    element,
    { x: 0 },
    {
      keyframes: { x: [-9, 8, -6, 4, -2, 0] },
      duration: 0.5,
      ease: 'power2.out',
    },
  );
}

/** Draws an SVG path on, used for the check mark and the quota ring. */
export function drawPath(path: SVGPathElement | SVGCircleElement, options: { duration?: number; delay?: number } = {}) {
  return gsap.fromTo(
    path,
    { drawSVG: '0%' },
    { drawSVG: '100%', duration: options.duration ?? 0.6, delay: options.delay ?? 0, ease: 'apple-out' },
  );
}

/**
 * Staggered app-launch reveal. Elements carrying `data-intro` rise in reading
 * order; the mic orb arrives last with a spring so it is the thing the user's
 * eye finishes on.
 */
export function playIntro(root: HTMLElement) {
  const items = root.querySelectorAll<HTMLElement>('[data-intro]');
  const orb = root.querySelector<HTMLElement>('[data-intro-orb]');

  const tl = gsap.timeline();
  tl.fromTo(
    items,
    { y: 26, opacity: 0, filter: 'blur(10px)' },
    { y: 0, opacity: 1, filter: 'blur(0px)', duration: 0.8, stagger: 0.09, ease: 'apple-out' },
  );

  if (orb) {
    tl.fromTo(
      orb,
      { scale: 0.35, opacity: 0, rotate: -25 },
      { scale: 1, opacity: 1, rotate: 0, duration: 1.05, ease: 'apple-spring' },
      '-=0.55',
    );
  }
  return tl;
}
