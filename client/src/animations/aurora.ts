import { gsap, seededRange } from './gsapSetup';

export interface AuroraHandle {
  /** Ramps the whole field up while listening, and back down when idle. */
  setEnergy: (energy: number) => void;
  kill: () => void;
}

/**
 * The living background.
 *
 * Each blob gets its own independent, infinitely-repeating timeline with a
 * different period, so the composite never visibly loops — the alternative
 * (one shared timeline) reads as a mechanical cycle within about ten seconds.
 * Scale and drift are decoupled from opacity so the field can be energised by
 * the mic without restarting any tween.
 */
export function createAurora(container: HTMLElement): AuroraHandle {
  const blobs = Array.from(container.querySelectorAll<HTMLElement>('.aurora__blob'));
  const timelines: gsap.core.Timeline[] = [];
  const energy = { value: 0 };

  blobs.forEach((blob, i) => {
    const seed = i + 1;
    const driftX = seededRange(seed * 3.1, 12, 34);
    const driftY = seededRange(seed * 7.7, 10, 30);
    const period = seededRange(seed * 2.3, 14, 26);

    gsap.set(blob, { xPercent: -50, yPercent: -50, transformOrigin: '50% 50%' });

    const tl = gsap
      .timeline({ repeat: -1, yoyo: true, defaults: { ease: 'sine.inOut' } })
      .to(blob, {
        x: `+=${driftX}vw`,
        y: `-=${driftY}vh`,
        duration: period,
      })
      .to(
        blob,
        {
          scale: seededRange(seed * 5.5, 1.15, 1.55),
          duration: period * 0.7,
        },
        0,
      )
      .to(
        blob,
        {
          rotate: seededRange(seed * 9.1, -40, 40),
          duration: period * 1.3,
        },
        0,
      );

    // Desynchronise the starting phase so blobs never breathe in lockstep.
    tl.progress(seededRange(seed * 11.3, 0, 1));
    timelines.push(tl);
  });

  const applyEnergy = () => {
    const e = energy.value;
    gsap.to(blobs, {
      opacity: 0.5 + e * 0.42,
      filter: `blur(${70 - e * 22}px)`,
      duration: 0.8,
      ease: 'apple-out',
      overwrite: 'auto',
    });
    // Excited blobs also move faster — the background reacts to the voice.
    timelines.forEach((tl) => gsap.to(tl, { timeScale: 1 + e * 1.6, duration: 1.2 }));
  };

  return {
    setEnergy(next: number) {
      energy.value = gsap.utils.clamp(0, 1, next);
      applyEnergy();
    },
    kill() {
      timelines.forEach((tl) => tl.kill());
      gsap.killTweensOf(blobs);
    },
  };
}
